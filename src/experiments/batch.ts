/**
 * Batch runner: many headless attack trials on the real network engine in
 * Fast (simulated PoW) mode, swept over a grid of parameters, for the charts
 * that set simulated results beside the theory (theory.ts).
 *
 * A trial is one full run: a ring of nodes, the attacker on node 0 with hash
 * share α (q for a double spend), the rest honest, sharing 1 − α equally.
 * Every block still goes through every node's validation, fork choice and
 * gossip; only the nonce search is skipped (network/mining.ts).
 *
 *   double spend  run until the attacker gives up, or releases its branch and
 *                 the network settles (nothing on the wire, every node on the
 *                 same tip). Success when the replacement tx is confirmed.
 *   selfish       run until `blocks` blocks have been found, stop mining,
 *                 have the attacker publish what it still withholds, deliver
 *                 what is on the wire, and take the attacker's share of an
 *                 honest node's main chain.
 *
 * Reproducible: each trial's seed is mixed from the experiment's seed, the
 * cell's index and the trial's index, so a result doesn't depend on how the
 * work was chunked, and one cell or trial can be replayed on its own.
 *
 * An ExperimentRun goes one trial at a time, round-robin over the cells:
 * trial 1 of every cell, then trial 2 of every cell, and so on. Stopped
 * early, it still has an estimate for the whole grid, just a noisier one.
 * The Experiments tab runs it in a Web Worker (worker.ts) and charts the
 * partial results as they come in.
 */
import { DEFAULT_BLOCK_INTERVAL, type MinerStrategy, Network, type NodeId } from '../network';
import { DoubleSpendAttacker, HonestMiner, SelfishMiner } from '../strategies';
import { chainMetrics, revenueShare } from './metrics';
import { ATTACK_PAYMENT, attackerKey, genesisFor, merchantAddress, minerAddress } from './scenario';
import { doubleSpendSuccess, nakamotoSuccess, selfishRevenue } from './theory';

/** The network every trial of an experiment runs on. */
export interface TrialNetwork {
  /** Honest nodes besides the attacker. They split the honest hash power equally. */
  honestNodes: number;
  /** One-way delay per link, in simulated seconds. */
  latency: number;
  /** Maximum extra random delay per message, in seconds. */
  jitter: number;
  /** Mean seconds between blocks. */
  blockInterval: number;
}

/**
 * Near-instant propagation, as the formulas assume (they have no network at
 * all): a 1 s hop against a 600 s block interval makes honest forks rare.
 */
export const EXPERIMENT_NETWORK: Readonly<TrialNetwork> = { honestNodes: 4, latency: 1, jitter: 1, blockInterval: DEFAULT_BLOCK_INTERVAL };

/** A trial that runs past this many blocks is stopped and counted as failed. */
export const DEFAULT_MAX_BLOCKS = 5000;

// ---------------------------------------------------------------------------
// One trial
// ---------------------------------------------------------------------------

export interface DoubleSpendTrialOptions {
  /** The attacker's hash share. */
  q: number;
  /** Confirmations the merchant waits for (z in the whitepaper, k in the strategy). */
  confirmations: number;
  /** The attacker gives up this many blocks behind. */
  maxDeficit: number;
  seed: number;
  network?: TrialNetwork;
  maxBlocks?: number;
}

export interface DoubleSpendTrialResult {
  success: boolean;
  /** Stopped at maxBlocks before the race was decided (counted as a failure). */
  capped: boolean;
  /** Blocks found by every miner during the trial. */
  blocks: number;
}

export function runDoubleSpendTrial(o: DoubleSpendTrialOptions): DoubleSpendTrialResult {
  const net = buildNetwork(o.seed, o.network ?? EXPERIMENT_NETWORK);
  const attacker = new DoubleSpendAttacker({
    key: attackerKey(),
    merchant: merchantAddress(),
    amount: ATTACK_PAYMENT,
    confirmations: o.confirmations,
    maxDeficit: o.maxDeficit,
  });
  setMiners(net, attacker, o.q);
  attacker.launch(net.mining.nodeContext(ATTACKER));

  const maxBlocks = o.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  let blocks = 0;
  while (blocks < maxBlocks) {
    const e = net.sim.step();
    if (!e) break;
    if (e.type === 'block-found') blocks++;
    if (attacker.phase === 'abandoned') return { success: false, capped: false, blocks };
    if (attacker.phase === 'released' && settled(net)) return { success: attacker.outcome === 'success', capped: false, blocks };
  }
  return { success: false, capped: true, blocks };
}

export interface SelfishTrialOptions {
  alpha: number;
  gamma: number;
  /** Blocks to find before stopping. */
  blocks: number;
  seed: number;
  network?: TrialNetwork;
}

export interface SelfishTrialResult {
  /** The attacker's share of an honest node's main chain. */
  revenue: number;
  /** Blocks found that are not on that main chain, over all blocks found. */
  staleRate: number;
  mainBlocks: number;
}

export function runSelfishTrial(o: SelfishTrialOptions): SelfishTrialResult {
  const net = buildNetwork(o.seed, o.network ?? EXPERIMENT_NETWORK);
  const selfish = new SelfishMiner(attackerKey().address);
  setMiners(net, selfish, o.alpha, o.gamma);

  let found = 0;
  while (found < o.blocks) {
    const e = net.sim.step();
    if (!e) break;
    if (e.type === 'block-found') found++;
  }
  // Stop mining, have the selfish miner cash in what it is still holding
  // (see SelfishMiner.releaseAll), and deliver everything on the wire.
  for (const id of net.mining.minerIds()) net.mining.setHashPower(id, 0);
  selfish.releaseAll(net.mining.nodeContext(ATTACKER));
  while (net.sim.step());

  const m = chainMetrics(net.node(OBSERVER).chain, net.mining.minedBlocks());
  return { revenue: revenueShare(m, ATTACKER), staleRate: m.staleRate, mainBlocks: m.mainBlocks };
}

// ---------------------------------------------------------------------------
// A sweep of trials
// ---------------------------------------------------------------------------

/** Double spend: success rate over a grid of attacker shares q and confirmation counts z. */
export interface DoubleSpendExperiment {
  kind: 'double-spend';
  seed: number;
  /** Trials per (q, z) cell. */
  trials: number;
  qs: number[];
  zs: number[];
  maxDeficit: number;
  network: TrialNetwork;
}

/** Selfish mining: revenue share over a grid of hash shares α and tie-break fractions γ. */
export interface SelfishExperiment {
  kind: 'selfish';
  seed: number;
  /** Trials per (α, γ) cell. */
  trials: number;
  alphas: number[];
  gammas: number[];
  /** Blocks found per trial. */
  blocks: number;
  network: TrialNetwork;
}

export type Experiment = DoubleSpendExperiment | SelfishExperiment;

const range = (from: number, to: number, step: number): number[] =>
  Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => Number((from + i * step).toFixed(10)));

/**
 * The Experiments tab's first chart: z = 1 to 6, as in the whitepaper's
 * section 11, over q up to 0.5. 60 cells × 100 trials = 6,000 trials.
 */
export const DEFAULT_DOUBLE_SPEND: Readonly<DoubleSpendExperiment> = {
  kind: 'double-spend',
  seed: 42,
  trials: 100,
  qs: range(0.05, 0.5, 0.05),
  zs: range(1, 6, 1),
  maxDeficit: 20,
  network: EXPERIMENT_NETWORK,
};

/** The second chart: α up to 0.45, for γ = 0 and 1/2, the two cases the paper works through. */
export const DEFAULT_SELFISH: Readonly<SelfishExperiment> = {
  kind: 'selfish',
  seed: 42,
  trials: 3,
  alphas: range(0.05, 0.45, 0.05),
  gammas: [0, 0.5],
  blocks: 2000,
  network: EXPERIMENT_NETWORK,
};

export interface DoubleSpendCell {
  q: number;
  z: number;
  /** Trials run so far. */
  trials: number;
  successes: number;
  /** Trials stopped at the block cap, counted as failures. */
  capped: number;
  /** For this simulator's rules (doubleSpendSuccess), with the experiment's maxDeficit. */
  theory: number;
  /** Nakamoto's figure (nakamotoSuccess), which ignores give-ups and counts a tie as a win. */
  nakamoto: number;
}

export interface SelfishCell {
  alpha: number;
  gamma: number;
  trials: number;
  /** The attacker's revenue share in each trial, in the order run. */
  revenues: number[];
  /** Mean stale rate over the trials. */
  staleRate: number;
  /** Eyal & Sirer's expected revenue share. */
  theory: number;
}

export type ExperimentResult =
  | { kind: 'double-spend'; experiment: DoubleSpendExperiment; done: number; total: number; cells: DoubleSpendCell[] }
  | { kind: 'selfish'; experiment: SelfishExperiment; done: number; total: number; cells: SelfishCell[] };

/** Parameter limits, also used by the UI to bound its inputs. */
export const LIMITS = { trials: 10_000, blocks: 100_000, honestNodes: 11, maxDeficit: 1000, confirmations: 50, gridValues: 40 } as const;

/** Throws a RangeError naming the first bad parameter. */
export function checkExperiment(e: Experiment): void {
  const int = (x: number, lo: number, hi: number, name: string) => {
    if (!Number.isInteger(x) || x < lo || x > hi) throw new RangeError(`${name} must be a whole number from ${lo} to ${hi}`);
  };
  const shares = (xs: number[], name: string, open: boolean) => {
    if (xs.length === 0 || xs.length > LIMITS.gridValues) throw new RangeError(`give between 1 and ${LIMITS.gridValues} values of ${name}`);
    for (const x of xs) {
      if (!(open ? x > 0 && x < 1 : x >= 0 && x <= 1)) throw new RangeError(`every ${name} must be in ${open ? '(0, 1)' : '[0, 1]'}`);
    }
  };
  if (!Number.isSafeInteger(e.seed)) throw new RangeError('seed must be an integer');
  int(e.trials, 1, LIMITS.trials, 'trials');
  int(e.network.honestNodes, 1, LIMITS.honestNodes, 'honest nodes');
  for (const [x, name] of [[e.network.latency, 'latency'], [e.network.jitter, 'jitter']] as const) {
    if (!Number.isFinite(x) || x < 0) throw new RangeError(`${name} must be a number >= 0`);
  }
  if (!(Number.isFinite(e.network.blockInterval) && e.network.blockInterval > 0)) throw new RangeError('block interval must be > 0');
  if (e.kind === 'double-spend') {
    shares(e.qs, 'q', true);
    if (e.zs.length === 0 || e.zs.length > LIMITS.gridValues) throw new RangeError(`give between 1 and ${LIMITS.gridValues} values of z`);
    for (const z of e.zs) int(z, 1, LIMITS.confirmations, 'z');
    int(e.maxDeficit, 1, LIMITS.maxDeficit, 'give-up distance');
  } else {
    shares(e.alphas, 'α', true);
    shares(e.gammas, 'γ', false);
    int(e.blocks, 10, LIMITS.blocks, 'blocks per trial');
  }
}

/**
 * Seed of trial `trial` in cell `cell`: the three numbers mixed by a 32-bit
 * hash (murmur3's finaliser), so neighbouring trials get unrelated streams.
 */
export function trialSeed(seed: number, cell: number, trial: number): number {
  let h = (seed ^ Math.imul(cell + 1, 0x9e3779b1) ^ Math.imul(trial + 1, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export class ExperimentRun {
  readonly experiment: Experiment;
  /** Cells in grid order: for a double spend z outer and q inner, for selfish mining γ outer and α inner. */
  private readonly ds: DoubleSpendCell[] = [];
  private readonly sm: (SelfishCell & { staleSum: number })[] = [];
  private _done = 0;

  constructor(experiment: Experiment) {
    checkExperiment(experiment);
    this.experiment = structuredClone(experiment);
    const e = this.experiment;
    if (e.kind === 'double-spend') {
      for (const z of e.zs) {
        for (const q of e.qs) {
          this.ds.push({ q, z, trials: 0, successes: 0, capped: 0, theory: doubleSpendSuccess(q, z, e.maxDeficit), nakamoto: nakamotoSuccess(q, z) });
        }
      }
    } else {
      for (const gamma of e.gammas) {
        for (const alpha of e.alphas) {
          this.sm.push({ alpha, gamma, trials: 0, revenues: [], staleRate: 0, staleSum: 0, theory: selfishRevenue(alpha, gamma) });
        }
      }
    }
  }

  get cellCount(): number {
    return this.ds.length + this.sm.length;
  }

  /** Trials in the whole experiment. */
  get total(): number {
    return this.cellCount * this.experiment.trials;
  }

  /** Trials run so far. */
  get done(): number {
    return this._done;
  }

  get finished(): boolean {
    return this._done >= this.total;
  }

  /** Run the next trial. Returns false, doing nothing, once every trial has run. */
  step(): boolean {
    if (this.finished) return false;
    const cell = this._done % this.cellCount;
    const trial = Math.floor(this._done / this.cellCount);
    const seed = trialSeed(this.experiment.seed, cell, trial);
    const e = this.experiment;
    if (e.kind === 'double-spend') {
      const c = this.ds[cell];
      const r = runDoubleSpendTrial({ q: c.q, confirmations: c.z, maxDeficit: e.maxDeficit, seed, network: e.network });
      c.trials++;
      if (r.success) c.successes++;
      if (r.capped) c.capped++;
    } else {
      const c = this.sm[cell];
      const r = runSelfishTrial({ alpha: c.alpha, gamma: c.gamma, blocks: e.blocks, seed, network: e.network });
      c.trials++;
      c.revenues.push(r.revenue);
      c.staleSum += r.staleRate;
      c.staleRate = c.staleSum / c.trials;
    }
    this._done++;
    return true;
  }

  /** Run every remaining trial. */
  runAll(): ExperimentResult {
    while (this.step());
    return this.result();
  }

  /** The results so far, as a copy that is safe to keep or post to another thread. */
  result(): ExperimentResult {
    const { done, total } = this;
    const e = structuredClone(this.experiment);
    if (e.kind === 'double-spend') return { kind: 'double-spend', experiment: e, done, total, cells: this.ds.map((c) => ({ ...c })) };
    const cells = this.sm.map(({ staleSum: _, ...c }) => ({ ...c, revenues: [...c.revenues] }));
    return { kind: 'selfish', experiment: e, done, total, cells };
  }
}

const ATTACKER: NodeId = 0;
/** The honest node whose main chain revenue is judged against: the merchant's, say. */
const OBSERVER: NodeId = 1;

/** Node 0 (the attacker) and the honest nodes, linked in a ring. */
function buildNetwork(seed: number, n: TrialNetwork): Network {
  if (!Number.isInteger(n.honestNodes) || n.honestNodes < 1) throw new RangeError('honestNodes must be an integer >= 1');
  const net = new Network({ seed, genesis: genesisFor('simulated'), blockInterval: n.blockInterval });
  const ids = Array.from({ length: n.honestNodes + 1 }, () => net.addNode());
  const link = { latency: n.latency, jitter: n.jitter };
  for (let i = 0; i + 1 < ids.length; i++) net.connect(ids[i], ids[i + 1], link);
  if (ids.length > 2) net.connect(ids.at(-1)!, ids[0], link);
  return net;
}

/** The attacker gets share α; honest miners split the rest. With γ, they break ties with the selfish miner by it. */
function setMiners(net: Network, attacker: MinerStrategy, alpha: number, gamma?: number): void {
  if (!(alpha > 0 && alpha < 1)) throw new RangeError('the attacker\'s share must be in (0, 1)');
  const honest = net.nodeIds().filter((id) => id !== ATTACKER);
  net.mining.setMiner(ATTACKER, attacker, alpha);
  const tieBreak = gamma === undefined ? undefined : { favour: attackerKey().address, gamma };
  for (const id of honest) net.mining.setMiner(id, new HonestMiner(minerAddress(id), { tieBreak }), (1 - alpha) / honest.length);
}

/** Nothing on the wire and every node on the same tip: the race is over. */
function settled(net: Network): boolean {
  if (net.inFlight().length > 0) return false;
  const [first, ...rest] = net.nodeIds().map((id) => net.node(id).chain.tipHash);
  return rest.every((t) => equalBytes(t, first));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
