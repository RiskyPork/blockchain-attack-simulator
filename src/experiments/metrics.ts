/**
 * Attack metrics, read off a finished (or running) simulation. The live
 * Attacks tab and the batch experiments compute them the same way.
 *
 *   revenue share   of the blocks on the main chain, the fraction a miner (or
 *                   group) found. Block rewards only pay out on the main chain,
 *                   so this is the miner's share of the income. An honest miner
 *                   expects about its hash share α; a selfish miner aims higher.
 *   stale rate      of all blocks found, the fraction not on the main chain:
 *                   work spent on blocks that lost a fork race, or that an
 *                   attacker kept hidden and then threw away.
 *   reorg depths    each time a node's main chain drops blocks to follow a
 *                   branch with more work, how many blocks it dropped. A
 *                   successful double spend shows up as one deep reorg.
 *
 * Revenue and stale rate are judged against one node's main chain. Read them
 * once the run has settled (no blocks on the wire, nothing withheld), or
 * recent blocks still in flight or kept private count as off the chain.
 */
import { blockHashHex } from '../core';
import type { MinedBlock, Network, NodeId } from '../network';
import type { Chain } from '../node';

export interface MinerTally {
  /** Blocks this miner found, published or not. */
  found: number;
  /** Of those, how many are on the main chain. */
  onMain: number;
}

export interface ChainMetrics {
  /** Blocks on the main chain after genesis. */
  mainBlocks: number;
  /** Blocks found by every miner, in total. */
  found: number;
  /** Blocks found that are not on the main chain. */
  stale: number;
  /** stale / found, or 0 before any block is found. */
  staleRate: number;
  byMiner: Map<NodeId, MinerTally>;
}

/**
 * Tally `mined` (Mining.minedBlocks(): every block found, by whom) against
 * `chain`'s main chain.
 */
export function chainMetrics(chain: Chain, mined: readonly MinedBlock[]): ChainMetrics {
  const main = new Set(chain.blocks.slice(1).map((b) => blockHashHex(b.header)));
  const byMiner = new Map<NodeId, MinerTally>();
  let onMain = 0;
  for (const rec of mined) {
    let t = byMiner.get(rec.miner);
    if (!t) byMiner.set(rec.miner, (t = { found: 0, onMain: 0 }));
    t.found++;
    if (main.has(rec.hash)) {
      t.onMain++;
      onMain++;
    }
  }
  const found = mined.length;
  return { mainBlocks: main.size, found, stale: found - onMain, staleRate: found > 0 ? (found - onMain) / found : 0, byMiner };
}

/** Fraction of main-chain blocks found by `miners`. 0 while the main chain holds only genesis. */
export function revenueShare(m: ChainMetrics, miners: NodeId | readonly NodeId[]): number {
  if (m.mainBlocks === 0) return 0;
  const ids = typeof miners === 'number' ? [miners] : miners;
  let blocks = 0;
  for (const id of ids) blocks += m.byMiner.get(id)?.onMain ?? 0;
  return blocks / m.mainBlocks;
}

/**
 * Counts reorgs on every node of a network, by depth. Attach it before the
 * run starts. A reorg here is one node dropping blocks from its main chain,
 * so one fork that resolves on five nodes counts five times.
 */
export class ReorgTracker {
  private readonly byDepth = new Map<number, number>();
  private _count = 0;
  private _deepest = 0;

  /** Start counting `net`'s reorgs. Returns a function that stops. */
  attach(net: Pick<Network, 'onTipChange'>): () => void {
    return net.onTipChange((_node, change) => {
      if (change.disconnected.length > 0) this.record(change.disconnected.length);
    });
  }

  record(depth: number): void {
    if (!Number.isInteger(depth) || depth < 1) throw new RangeError('reorg depth must be an integer >= 1');
    this.byDepth.set(depth, (this.byDepth.get(depth) ?? 0) + 1);
    this._count++;
    this._deepest = Math.max(this._deepest, depth);
  }

  get count(): number {
    return this._count;
  }

  get deepest(): number {
    return this._deepest;
  }

  /** [depth, how many reorgs had that depth], for every depth from 1 to the deepest (zeros included). */
  histogram(): [depth: number, count: number][] {
    const out: [number, number][] = [];
    for (let d = 1; d <= this._deepest; d++) out.push([d, this.byDepth.get(d) ?? 0]);
    return out;
  }
}
