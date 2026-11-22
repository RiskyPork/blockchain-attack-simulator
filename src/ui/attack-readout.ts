/**
 * What the Attacks tab shows about the running attack, worked out from the
 * playground without touching the DOM, so it is unit-tested. The numbers come
 * from the strategies (strategies/) and the shared metrics and theory
 * (experiments/); nothing here decides anything about consensus.
 */
import { catchUpProbability, chainMetrics, revenueShare, selfishRevenue, selfishThreshold } from '../experiments';
import type { NodeId } from '../network';
import type { AttackOutcome, DoubleSpendPhase, SelfishCounters, SelfishStatus } from '../strategies';
import type { Playground } from './playground';

interface CommonReadout {
  attacker: NodeId;
  /** The honest node whose main chain revenue and stale blocks are judged against. */
  observer: NodeId;
  /** The attacker's live share of the hash power. */
  alpha: number;
  /** Of the observer's main-chain blocks after genesis, the fraction the attacker found. */
  revenue: number;
  mainBlocks: number;
  /** Blocks the attacker has found, published or not. */
  attackerFound: number;
  /** Of all blocks found, the fraction not on the observer's main chain. */
  staleRate: number;
}

export interface DoubleSpendReadout extends CommonReadout {
  kind: 'double-spend';
  phase: DoubleSpendPhase;
  outcome: AttackOutcome;
  /** Attacker's blocks above the fork point. */
  privateBlocks: number;
  /** Public blocks above the fork point, as the attacker's node sees them. */
  publicBlocks: number;
  /** Confirmations of the payment, as the attacker's node sees them. */
  confirmations: number;
  /** k: confirmations the merchant waits for. */
  needed: number;
  maxDeficit: number;
  /** Net blocks the attacker still has to gain to be strictly ahead (0 once it is). */
  toGetAhead: number;
  /**
   * Chance it ever gets ahead from here if it never gave up: (q/p)^z, or 1
   * with a majority (Nakamoto 2008, section 11). Null once the race is over.
   */
  catchUp: number | null;
}

export interface SelfishReadout extends CommonReadout {
  kind: 'selfish';
  gamma: number;
  status: SelfishStatus;
  counters: SelfishCounters;
  /** Expected revenue share for this α and γ (Eyal & Sirer 2014). */
  theory: number;
  /** The α above which selfish mining beats honest mining, for this γ. */
  threshold: number;
}

export type AttackReadout = DoubleSpendReadout | SelfishReadout;

export function readAttack(pg: Playground): AttackReadout | null {
  const a = pg.attack;
  if (!a) return null;
  const observer = pg.ring.find((id) => id !== a.node) ?? a.node;
  const mined = pg.net.mining.minedBlocks();
  const m = chainMetrics(pg.chain(observer), mined);
  const alpha = pg.net.mining.share(a.node);
  const common: CommonReadout = {
    attacker: a.node,
    observer,
    alpha,
    revenue: revenueShare(m, a.node),
    mainBlocks: m.mainBlocks,
    attackerFound: m.byMiner.get(a.node)?.found ?? 0,
    staleRate: m.staleRate,
  };

  if (a.kind === 'selfish') {
    const gamma = a.config.gamma;
    return {
      ...common,
      kind: 'selfish',
      gamma,
      status: a.strategy.status(pg.chain(a.node)),
      counters: a.strategy.counters,
      theory: selfishRevenue(alpha, gamma),
      threshold: selfishThreshold(gamma),
    };
  }

  const s = a.strategy;
  const race = s.race() ?? { privateBlocks: 0, publicBlocks: 0, confirmations: 0 };
  const toGetAhead = Math.max(0, race.publicBlocks - race.privateBlocks + 1);
  return {
    ...common,
    kind: 'double-spend',
    phase: s.phase,
    outcome: s.outcome,
    ...race,
    needed: s.options.confirmations,
    maxDeficit: s.options.maxDeficit,
    toGetAhead,
    catchUp: s.phase === 'mining' ? catchUpProbability(alpha, toGetAhead) : null,
  };
}
