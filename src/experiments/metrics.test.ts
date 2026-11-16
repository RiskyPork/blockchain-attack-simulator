import { describe, expect, it } from 'vitest';
import { type Block, ZERO_HASH } from '../core/block';
import { hexToBytes } from '../core/hash';
import { type KeyPair, keyPairFromPrivate } from '../core/keys';
import { assembleBlock, mineChunk } from '../core/miner';
import { SIMULATED_POW_TARGET } from '../network/mining';
import { Network, type NodeId } from '../network/network';
import { HonestMiner } from '../strategies/honest';
import { SelfishMiner } from '../strategies/selfish';
import { ReorgTracker, chainMetrics, revenueShare } from './metrics';

const keyN = (n: number): KeyPair => keyPairFromPrivate(hexToBytes(n.toString(16).padStart(64, '0')));
const solve = (t: Block): Block => ({ header: mineChunk(t.header, 1).header, txs: t.txs });
const GENESIS = solve(
  assembleBlock({ prevHash: ZERO_HASH, height: 0, timestamp: 0, target: SIMULATED_POW_TARGET, minerAddress: keyN(999).address, txs: [], fees: 0 }),
);

/** Only node `id` mines until it has found `n` blocks. Messages are left on the wire unless `settle`. */
function mineBy(net: Network, id: NodeId, n: number, settle = true): void {
  for (const m of net.mining.minerIds()) net.mining.setHashPower(m, m === id ? 1 : 0);
  for (let found = 0; found < n; ) if (net.sim.step()?.type === 'block-found') found++;
  if (!settle) return;
  for (const m of net.mining.minerIds()) net.mining.setHashPower(m, 0);
  while (net.sim.step());
}

/**
 * A and B each find a block before hearing of the other's (100 s latency), so
 * the chain forks; then A's next block settles it and B's block goes stale.
 */
function forkedPair() {
  // Blocks every second on average, so B's comes long before A's arrives.
  const net = new Network({ seed: 1, genesis: GENESIS, blockInterval: 1 });
  const [A, B] = [net.addNode(), net.addNode()];
  net.connect(A, B, { latency: 100 });
  net.mining.setMiner(A, new HonestMiner(keyN(1).address), 0);
  net.mining.setMiner(B, new HonestMiner(keyN(2).address), 0);
  const reorgs = new ReorgTracker();
  reorgs.attach(net);
  mineBy(net, A, 1, false);
  mineBy(net, B, 1);
  mineBy(net, A, 1);
  return { net, A, B, reorgs };
}

describe('chainMetrics and revenueShare (S3-6)', () => {
  it('counts blocks found against the main chain, per miner', () => {
    const { net, A, B } = forkedPair();
    const m = chainMetrics(net.node(B).chain, net.mining.minedBlocks());
    expect(m).toMatchObject({ mainBlocks: 2, found: 3, stale: 1 });
    expect(m.staleRate).toBeCloseTo(1 / 3);
    expect(m.byMiner.get(A)).toEqual({ found: 2, onMain: 2 });
    expect(m.byMiner.get(B)).toEqual({ found: 1, onMain: 0 });
    expect(revenueShare(m, A)).toBe(1);
    expect(revenueShare(m, B)).toBe(0);
    expect(revenueShare(m, [A, B])).toBe(1);
  });

  it('is all zeros before any block is found', () => {
    const net = new Network({ seed: 1, genesis: GENESIS });
    const A = net.addNode();
    const m = chainMetrics(net.node(A).chain, []);
    expect(m).toMatchObject({ mainBlocks: 0, found: 0, stale: 0, staleRate: 0 });
    expect(revenueShare(m, A)).toBe(0);
  });
});

describe('ReorgTracker (S3-6)', () => {
  it('records each node that drops blocks from its main chain, with the depth', () => {
    const { reorgs } = forkedPair();
    // Only B reorgs: A never left its own branch.
    expect(reorgs.count).toBe(1);
    expect(reorgs.deepest).toBe(1);
    expect(reorgs.histogram()).toEqual([[1, 1]]);
  });

  it("shows a selfish miner's override as one deep reorg on every node, with zeros for the depths in between", () => {
    const net = new Network({ seed: 2, genesis: GENESIS });
    const [S, H, O] = [net.addNode(), net.addNode(), net.addNode()];
    net.connect(S, H, { latency: 1 });
    net.connect(H, O, { latency: 1 });
    net.connect(S, O, { latency: 1 });
    net.mining.setMiner(S, new SelfishMiner(keyN(1).address), 0);
    net.mining.setMiner(H, new HonestMiner(keyN(2).address), 0);
    const reorgs = new ReorgTracker();
    const stop = reorgs.attach(net);
    mineBy(net, S, 4);
    mineBy(net, H, 3); // the selfish miner publishes its 4 blocks: 3 honest blocks are undone everywhere
    expect(reorgs.histogram()).toEqual([[1, 0], [2, 0], [3, 3]]);

    stop();
    mineBy(net, H, 1);
    expect(reorgs.count).toBe(3);
  });

  it('rejects a depth below 1', () => {
    expect(() => new ReorgTracker().record(0)).toThrow(RangeError);
  });
});
