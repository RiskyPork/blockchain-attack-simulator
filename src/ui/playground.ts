/**
 * The live network behind the Network, Chain tree and Attacks tabs: a Network
 * of miners (honest, or one attacker among them) that the user reshapes while
 * it runs, and the play / pause / step / speed controls that drive its
 * simulated clock.
 *
 * No DOM here, so it is unit-tested; the panels only read it and call its
 * methods. Consensus stays in node/ and network/: this class wires nodes,
 * links and miners together and watches what they do.
 *
 * Topology is a ring. A new node is inserted between the last node and the
 * first; a removed node's two neighbours are linked to close the gap. A ring
 * keeps every node reachable and makes a block cross several hops, so latency
 * adds up and forks appear without needing extreme settings.
 *
 * Attacks: launching one restarts the run with the first node (N0) as the
 * attacker, its hash share set to α, and every other node honest. The genesis
 * block pays the attacker's wallet, so a double spend can start at t = 0
 * without the attacker first having to mine some coins.
 *
 * Reproducibility: everything random comes from the run's seeded Rng, and
 * miners' reward keys are derived from their node id. Moving the clock in
 * small or large steps fires the same events in the same order, so the run
 * depends on the seed and the settings, not on the browser's frame rate.
 */
import { type Block, blockHashHex, bytesToHex } from '../core';
import { DEFAULT_BLOCK_INTERVAL, type MinerStrategy, type NetEvent, Network, type NodeId } from '../network';
import type { Chain } from '../node';
import { ATTACK_PAYMENT, type PowMode, ReorgTracker, attackerKey, genesisFor, merchantAddress, minerAddress } from '../experiments';
import { DoubleSpendAttacker, HonestMiner, SelfishMiner } from '../strategies';
import { shortHex } from './format';

export { ATTACK_PAYMENT, type PowMode, REAL_POW_BITS, attackerKey, genesisFor, merchantAddress, minerAddress } from '../experiments';

export const MAX_NODES = 12;

/** Speeds offered by the UI, in simulated seconds per real second. */
export const SPEEDS = [1, 10, 30, 60, 120, 300, 600, 1800] as const;

export interface PlaygroundOptions {
  seed: number;
  pow: PowMode;
  /** Hash power of each starting node, in ring order. Only the ratios matter. */
  hashPowers: number[];
  /** Fixed one-way delay per link, in simulated seconds. */
  latency: number;
  /** Maximum extra random delay per message, in seconds. */
  jitter: number;
  blockInterval: number;
}

export const DEFAULT_OPTIONS: Readonly<PlaygroundOptions> = {
  seed: 42,
  pow: 'simulated',
  hashPowers: [30, 20, 15, 15, 10, 10],
  latency: 10,
  jitter: 2,
  blockInterval: DEFAULT_BLOCK_INTERVAL,
};

/** Hash power given to a node added from the UI. */
export const NEW_NODE_HASH_POWER = 10;

/** A real frame longer than this (e.g. the tab was in the background) only advances the clock this much. */
const MAX_FRAME_SECONDS = 0.25;
const ACTIVITY_LIMIT = 200;

export type AttackKind = 'double-spend' | 'selfish';

/** What the user picks on the Attacks tab. Each kind ignores the other kind's fields. */
export interface AttackConfig {
  kind: AttackKind;
  /** The attacker's share of the hash power, in (0, 1). */
  alpha: number;
  /** Double spend: confirmations the merchant waits for (k). */
  confirmations: number;
  /** Double spend: give up this many blocks behind; Infinity never gives up. */
  maxDeficit: number;
  /** Selfish mining: fraction of honest hash power that mines on the attacker's block in a tie. */
  gamma: number;
}

export const DEFAULT_ATTACK: Readonly<AttackConfig> = { kind: 'double-spend', alpha: 0.3, confirmations: 6, maxDeficit: 10, gamma: 0 };

/**
 * The 51% attack: a double spend by a majority miner that never gives up. The
 * race drifts its way, so it succeeds in the end however many confirmations
 * the merchant waits for (Nakamoto 2008, section 11). This is why a chain is
 * only immutable while no one holds more than half of the hash power.
 */
export const PRESET_51: Readonly<AttackConfig> = { kind: 'double-spend', alpha: 0.55, confirmations: 6, maxDeficit: Infinity, gamma: 0 };

export type ActiveAttack =
  | { kind: 'double-spend'; config: Readonly<AttackConfig>; node: NodeId; strategy: DoubleSpendAttacker }
  | { kind: 'selfish'; config: Readonly<AttackConfig>; node: NodeId; strategy: SelfishMiner };

export interface BlockRef {
  hash: string;
  height: number;
}

/** Something worth showing in the activity log. Message deliveries are too frequent to list. */
export type Activity =
  | { kind: 'found'; time: number; node: NodeId; block: BlockRef }
  /** The attacker found a block and kept it to itself. */
  | { kind: 'withheld'; time: number; node: NodeId; block: BlockRef }
  /** Node `node` dropped `depth` blocks from its main chain to follow a branch with more work. */
  | { kind: 'reorg'; time: number; node: NodeId; depth: number; from: BlockRef; to: BlockRef };

export interface NodeSummary {
  id: NodeId;
  hashPower: number;
  /** Fraction of the total hash power: the chance this node finds the next block. */
  share: number;
  height: number;
  tip: string;
  /** Times this node won the block lottery. */
  found: number;
  /** Blocks waiting for a parent this node hasn't received yet. */
  orphans: number;
  peers: NodeId[];
}

export function nodeLabel(id: NodeId): string {
  return `N${id}`;
}

export class Playground {
  private _net!: Network;
  private _ring: NodeId[] = [];
  private _opts: PlaygroundOptions;
  private tips = new Map<NodeId, string>();
  private wins = new Map<NodeId, number>();
  private _activity: Activity[] = [];
  private _reorgs = new ReorgTracker();
  private _attackConfig: AttackConfig | null = null;
  private _attack: ActiveAttack | null = null;
  /** Deepest reorg each node made during the event being fired, as the chain reported it. */
  private readonly depthThisEvent = new Map<NodeId, number>();
  private _lastEvent = '';
  private _playing = false;
  private _speed = 60;
  private _version = 0;
  private readonly listeners = new Set<() => void>();

  constructor(opts: Partial<PlaygroundOptions> = {}) {
    this._opts = { ...DEFAULT_OPTIONS, ...opts, hashPowers: [...(opts.hashPowers ?? DEFAULT_OPTIONS.hashPowers)] };
    this.build(this._opts.hashPowers);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  get net(): Network {
    return this._net;
  }

  /** Node ids in ring order: each node links to the ones before and after it, and the last to the first. */
  get ring(): readonly NodeId[] {
    return this._ring;
  }

  get seed(): number {
    return this._opts.seed;
  }

  get pow(): PowMode {
    return this._opts.pow;
  }

  get latency(): number {
    return this._opts.latency;
  }

  get jitter(): number {
    return this._opts.jitter;
  }

  get blockInterval(): number {
    return this._opts.blockInterval;
  }

  get now(): number {
    return this._net.sim.now;
  }

  get playing(): boolean {
    return this._playing;
  }

  /** Simulated seconds per real second while playing. */
  get speed(): number {
    return this._speed;
  }

  set speed(s: number) {
    if (!Number.isFinite(s) || s <= 0) throw new RangeError('speed must be a finite number > 0');
    this._speed = s;
    this.emit();
  }

  /** Goes up whenever an event fires or the setup changes, so panels can skip redrawing when nothing moved. */
  get version(): number {
    return this._version;
  }

  /** Found blocks and reorgs, oldest first, capped at the most recent 200. */
  get activity(): readonly Activity[] {
    return this._activity;
  }

  /** Reorgs on every node so far, counted by depth (one fork settling on five nodes counts five times). */
  get reorgs(): Pick<ReorgTracker, 'count' | 'deepest' | 'histogram'> {
    return this._reorgs;
  }

  /** The running attack, or null when every node is honest. */
  get attack(): ActiveAttack | null {
    return this._attack;
  }

  /** Blocks the attacker has found and not published, so no node's tree has them. */
  hiddenBlocks(): readonly Block[] {
    const a = this._attack;
    if (!a) return [];
    if (a.kind === 'selfish') return a.strategy.withheld;
    return a.strategy.phase === 'mining' ? a.strategy.privateBranch : [];
  }

  /** Whether the attacker's node found this block (published or not). */
  isAttackerBlock(hash: string): boolean {
    const a = this._attack;
    return a !== null && this._net.mining.minedBlock(hash)?.miner === a.node;
  }

  /** What the last fired event did, in words (shown next to the Step button). */
  get lastEvent(): string {
    return this._lastEvent;
  }

  chain(id: NodeId): Chain {
    return this._net.node(id).chain;
  }

  nodes(): NodeSummary[] {
    const { mining } = this._net;
    return this._ring.map((id) => {
      const chain = this.chain(id);
      return {
        id,
        hashPower: mining.hashPower(id),
        share: mining.share(id),
        height: chain.height,
        tip: bytesToHex(chain.tipHash),
        found: this.wins.get(id) ?? 0,
        orphans: chain.tree.orphans().length,
        peers: this._net.peersOf(id),
      };
    });
  }

  /** Total blocks found so far, across all miners. */
  get blocksFound(): number {
    let n = 0;
    for (const w of this.wins.values()) n += w;
    return n;
  }

  /** Height of a block in whichever node's tree has it, or undefined if none does. */
  heightOf(hash: string): number | undefined {
    for (const id of this._ring) {
      const e = this.chain(id).tree.get(hash);
      if (e) return e.height;
    }
    return undefined;
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  /**
   * Start a fresh run from genesis with the same nodes (renumbered from 0),
   * hash powers and link settings. Pass a seed or PoW mode to change them.
   */
  reset(opts: { seed?: number; pow?: PowMode } = {}): void {
    if (opts.seed !== undefined) {
      if (!Number.isSafeInteger(opts.seed)) throw new RangeError('seed must be an integer');
      this._opts.seed = opts.seed;
    }
    if (opts.pow !== undefined) this._opts.pow = opts.pow;
    this.build(this._ring.map((id) => this._net.mining.hashPower(id)));
    this.changed();
  }

  /**
   * Restart the run from genesis with N0 as the attacker. The attacker gets
   * share α of the hash power; the honest nodes share the rest in the ratio
   * they had. A double spend is launched at once: the payment goes out at
   * t = 0. Reset replays the same attack; endAttack goes back to all honest.
   */
  launchAttack(config: AttackConfig): void {
    checkAttack(config);
    if (this._ring.length < 2) throw new Error('an attack needs at least two nodes: the attacker and someone honest');
    this._attackConfig = { ...config };
    this.build(attackHashPowers(this._ring.map((id) => this._net.mining.hashPower(id)), config.alpha));
    this.changed();
  }

  /** Restart the run from genesis with every node honest again. */
  endAttack(): void {
    this._attackConfig = null;
    this.build(this._ring.map((id) => this._net.mining.hashPower(id)));
    this.changed();
  }

  /** Add a node to the ring. It starts with only genesis and catches up over its new links. */
  addNode(hashPower = NEW_NODE_HASH_POWER): NodeId {
    if (this._ring.length >= MAX_NODES) throw new Error(`at most ${MAX_NODES} nodes`);
    const id = this.insertNode(hashPower);
    this.changed();
    return id;
  }

  /** Remove a node and link its two neighbours, so the ring stays connected. */
  removeNode(id: NodeId): void {
    const i = this._ring.indexOf(id);
    if (i < 0) throw new Error(`unknown node ${id}`);
    if (this._ring.length === 1) throw new Error('the network needs at least one node');
    if (this._attack?.node === id) throw new Error('the attacker node cannot be removed while the attack runs');
    const n = this._ring.length;
    const prev = this._ring[(i - 1 + n) % n];
    const next = this._ring[(i + 1) % n];
    this._net.removeNode(id);
    this._ring.splice(i, 1);
    this.tips.delete(id);
    if (prev !== next && !this._net.link(prev, next)) this._net.connect(prev, next, this.linkOptions());
    this.changed();
  }

  setHashPower(id: NodeId, hashPower: number): void {
    this._net.mining.setHashPower(id, hashPower);
    this.changed();
  }

  /** Set every link's latency. Messages already on the wire keep their old arrival time. */
  setLatency(seconds: number): void {
    this._opts.latency = checkDelay(seconds, 'latency');
    this.updateLinks();
  }

  setJitter(seconds: number): void {
    this._opts.jitter = checkDelay(seconds, 'jitter');
    this.updateLinks();
  }

  setBlockInterval(seconds: number): void {
    this._net.mining.blockInterval = seconds;
    this._opts.blockInterval = seconds;
    this.changed();
  }

  // -------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------

  play(): void {
    this._playing = true;
    this.emit();
  }

  pause(): void {
    this._playing = false;
    this.emit();
  }

  /** Called once per animation frame with the real time since the last one. Returns how many events fired. */
  tick(realSeconds: number): number {
    if (!this._playing || !(realSeconds > 0)) return 0;
    return this.advance(Math.min(realSeconds, MAX_FRAME_SECONDS) * this._speed);
  }

  /** Fire the next event, whenever it is, and move the clock to it. Returns undefined if nothing is scheduled. */
  step(): NetEvent | undefined {
    const e = this.fire();
    this.emit();
    return e;
  }

  /** Move the clock forward by `seconds`, firing every event on the way. Returns how many fired. */
  advance(seconds: number): number {
    const sim = this._net.sim;
    const until = sim.now + seconds;
    let fired = 0;
    for (let t = sim.nextEventTime; t !== undefined && t <= until; t = sim.nextEventTime) {
      this.fire();
      fired++;
    }
    sim.runUntil(until);
    this.emit();
    return fired;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private build(hashPowers: number[]): void {
    this._net = new Network({ seed: this._opts.seed, genesis: genesisFor(this._opts.pow), blockInterval: this._opts.blockInterval });
    this._ring = [];
    this.tips.clear();
    this.wins.clear();
    this._activity = [];
    this._reorgs = new ReorgTracker();
    this._reorgs.attach(this._net);
    this._net.onTipChange((node, change) => {
      const depth = change.disconnected.length;
      if (depth > 0) this.depthThisEvent.set(node, Math.max(depth, this.depthThisEvent.get(node) ?? 0));
    });
    this._lastEvent = '';
    // The first node added gets id 0, and becomes the attacker.
    this._attack = this._attackConfig && makeAttack(this._attackConfig, 0);
    for (const hp of hashPowers) this.insertNode(hp);
    // Every node is in place now, so the payment reaches every mempool.
    if (this._attack?.kind === 'double-spend') this._attack.strategy.launch(this._net.mining.nodeContext(this._attack.node));
  }

  private strategyFor(id: NodeId): MinerStrategy {
    const a = this._attack;
    if (a?.node === id) return a.strategy;
    const tieBreak = a?.kind === 'selfish' ? { favour: attackerKey().address, gamma: a.config.gamma } : undefined;
    return new HonestMiner(minerAddress(id), { tieBreak });
  }

  private insertNode(hashPower: number): NodeId {
    const net = this._net;
    const id = net.addNode();
    const ring = this._ring;
    const first = ring[0];
    const last = ring.at(-1);
    // Splice the new node between the last and the first. With two nodes their
    // single link is also the ring's closing link, so it stays.
    if (ring.length >= 3) net.disconnect(last!, first);
    if (last !== undefined) net.connect(last, id, this.linkOptions());
    if (ring.length >= 2) net.connect(id, first, this.linkOptions());
    ring.push(id);
    net.mining.setMiner(id, this.strategyFor(id), hashPower);
    this.tips.set(id, bytesToHex(net.node(id).chain.tipHash));
    return id;
  }

  private linkOptions() {
    return { latency: this._opts.latency, jitter: this._opts.jitter };
  }

  private updateLinks(): void {
    for (const link of this._net.links()) this._net.updateLink(link.a, link.b, this.linkOptions());
    this.changed();
  }

  /** Fire one event, then record what it did. */
  private fire(): NetEvent | undefined {
    const before = new Map(this._ring.map((id) => [id, storeCounts(this.chain(id))]));
    this.depthThisEvent.clear();
    const e = this._net.sim.step();
    if (!e) return undefined;
    this._version++;
    if (e.type === 'block-found') {
      this.wins.set(e.miner, (this.wins.get(e.miner) ?? 0) + 1);
      this.noteWithheld(e.miner);
    }
    const reorgs = this.watchTips(e);
    this._lastEvent = this.describe(e, before.get(e.type === 'block-arrive' ? e.to : e.miner), reorgs);
    return e;
  }

  /**
   * Compare every node's tip with the one it had before the event. A tip
   * that moved off the old tip's branch is a reorg: the node undid blocks
   * back to the fork point and followed a branch with more work.
   */
  private watchTips(e: NetEvent): Map<NodeId, number> {
    const now = this._net.sim.now;
    const reorgs = new Map<NodeId, number>();
    for (const id of this._ring) {
      const chain = this.chain(id);
      const tip = bytesToHex(chain.tipHash);
      const old = this.tips.get(id);
      this.tips.set(id, tip);
      if (old === undefined || old === tip) continue;
      if (e.type === 'block-found' && e.miner === id) {
        const rec = this._net.mining.minedBlock(tip);
        if (rec?.miner === id && rec.foundAt === now) this.log({ kind: 'found', time: now, node: id, block: this.ref(chain, tip) });
      }
      if (chain.isOnMainChain(old)) continue;
      // The chain's own count is exact. Measuring from the tip before the event
      // undercounts when a node extended its chain and then reorged within the
      // same event (an attacker that receives a block, then releases its branch).
      const depth = this.depthThisEvent.get(id) ?? blocksOffMainChain(chain, old);
      reorgs.set(id, depth);
      this.log({ kind: 'reorg', time: now, node: id, depth, from: this.ref(chain, old), to: this.ref(chain, tip) });
    }
    return reorgs;
  }

  /** If the block node `id` just found went nowhere (the attacker kept it), log that. */
  private noteWithheld(id: NodeId): void {
    if (this._attack?.node !== id) return;
    const hidden = this.hiddenBlocks().at(-1);
    if (!hidden) return;
    const hash = blockHashHex(hidden.header);
    // An older hidden block means the new one was published instead.
    if (this._net.mining.minedBlock(hash)?.foundAt !== this.now) return;
    this.log({ kind: 'withheld', time: this.now, node: id, block: { hash, height: coinbaseHeight(hidden) } });
  }

  private describe(e: NetEvent, before: StoreCounts | undefined, reorgs: Map<NodeId, number>): string {
    if (e.type === 'block-found') {
      const tip = this.tips.get(e.miner)!;
      const rec = this._net.mining.minedBlock(tip);
      if (rec?.miner === e.miner && rec.foundAt === this.now) {
        return `${nodeLabel(e.miner)} found block #${this.chain(e.miner).height} (${shortHex(tip, 6, 4)}) and sent it to its peers.`;
      }
      const last = this._activity.at(-1);
      if (last?.kind === 'withheld' && last.time === this.now && last.node === e.miner) {
        return `${nodeLabel(e.miner)} (attacker) found block #${last.block.height} (${shortHex(last.block.hash, 6, 4)}) and kept it hidden.`;
      }
      return `${nodeLabel(e.miner)} found a block.`;
    }
    const hash = blockHashHex(e.block.header);
    const what = `Block #${this.heightOf(hash) ?? '?'} (${shortHex(hash, 6, 4)}) reached ${nodeLabel(e.to)} from ${nodeLabel(e.from)}`;
    if (!before || !this._ring.includes(e.to)) return `${what}, but that node was removed: dropped.`;
    const chain = this.chain(e.to);
    const after = storeCounts(chain);
    const depth = reorgs.get(e.to);
    if (depth !== undefined) return `${what}: its branch has more work, so ${nodeLabel(e.to)} reorganised (${depth} block${depth === 1 ? '' : 's'} undone).`;
    if (after.blocks > before.blocks) {
      return this.tips.get(e.to) === hash || chain.isOnMainChain(hash)
        ? `${what}: new tip, passed on to its other peers.`
        : `${what}: stored on a side branch (less work than the main chain), passed on.`;
    }
    if (after.orphans > before.orphans) return `${what}: parent not received yet, so it waits in the orphan pool.`;
    return `${what}: already had it, so it isn't passed on again.`;
  }

  private ref(chain: Chain, hash: string): BlockRef {
    return { hash, height: chain.tree.get(hash)?.height ?? -1 };
  }

  private log(a: Activity): void {
    this._activity.push(a);
    if (this._activity.length > ACTIVITY_LIMIT) this._activity.shift();
  }

  private changed(): void {
    this._version++;
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

function makeAttack(config: AttackConfig, node: NodeId): ActiveAttack {
  const key = attackerKey();
  if (config.kind === 'selfish') return { kind: 'selfish', config, node, strategy: new SelfishMiner(key.address) };
  const strategy = new DoubleSpendAttacker({
    key,
    merchant: merchantAddress(),
    amount: ATTACK_PAYMENT,
    confirmations: config.confirmations,
    maxDeficit: config.maxDeficit,
  });
  return { kind: 'double-spend', config, node, strategy };
}

function checkAttack(c: AttackConfig): void {
  if (!(c.alpha > 0 && c.alpha < 1)) throw new RangeError('alpha must be in (0, 1)');
  if (!(c.gamma >= 0 && c.gamma <= 1)) throw new RangeError('gamma must be in [0, 1]');
  if (!Number.isInteger(c.confirmations) || c.confirmations < 1) throw new RangeError('confirmations must be an integer >= 1');
  if (c.maxDeficit !== Infinity && (!Number.isInteger(c.maxDeficit) || c.maxDeficit < 1)) {
    throw new RangeError('maxDeficit must be an integer >= 1, or Infinity');
  }
}

/**
 * Hash powers for an attack: the first node gets share α, and the others
 * share 1 − α in the ratio they had (equally if none had any). Out of 100,
 * rounded to hundredths.
 */
export function attackHashPowers(powers: readonly number[], alpha: number): number[] {
  const honest = powers.slice(1);
  const total = honest.reduce((s, p) => s + p, 0);
  const weights = total > 0 ? honest : honest.map(() => 1);
  const sum = total > 0 ? total : honest.length;
  const round = (x: number) => Math.round(x * 100) / 100;
  return [round(100 * alpha), ...weights.map((w) => round((100 * (1 - alpha) * w) / sum))];
}

function coinbaseHeight(block: Block): number {
  const cb = block.txs[0];
  return 'height' in cb ? cb.height : -1;
}

function checkDelay(seconds: number, name: string): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError(`${name} must be a finite number >= 0`);
  return seconds;
}

interface StoreCounts {
  blocks: number;
  orphans: number;
}

function storeCounts(chain: Chain): StoreCounts {
  return { blocks: chain.tree.size, orphans: chain.tree.orphans().length };
}

/** How many blocks of the branch ending at `hash` are off `chain`'s main chain: the depth of the reorg that left it. */
function blocksOffMainChain(chain: Chain, hash: string): number {
  let depth = 0;
  for (let e = chain.tree.get(hash); e && !chain.isOnMainChain(e.hash); e = e.parent === null ? undefined : chain.tree.get(e.parent)) depth++;
  return depth;
}
