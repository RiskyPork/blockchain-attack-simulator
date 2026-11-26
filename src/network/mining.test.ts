import { describe, expect, it } from 'vitest';
import { type Block, ZERO_HASH, blockHash, blockHashHex, meetsTarget, targetFromLeadingZeroBits } from '../core/block';
import { hexToBytes } from '../core/hash';
import { type KeyPair, keyPairFromPrivate } from '../core/keys';
import { assembleBlock, mineChunk } from '../core/miner';
import { COIN, txidHex } from '../core/transaction';
import { buildPayment } from '../node/wallet';
import { type AcceptedBlock, type MinerContext, type MinerStrategy, SIMULATED_POW_TARGET } from './mining';
import { Network } from './network';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const keyN = (n: number): KeyPair => keyPairFromPrivate(hexToBytes(n.toString(16).padStart(64, '0')));

function genesisAt(target: bigint): Block {
  const t = assembleBlock({
    prevHash: ZERO_HASH, height: 0, timestamp: 0, target, minerAddress: keyN(999).address, txs: [], fees: 0,
  });
  return { header: mineChunk(t.header, Number.MAX_SAFE_INTEGER).header, txs: t.txs };
}

const FAST_GENESIS = genesisAt(SIMULATED_POW_TARGET);
const T8 = targetFromLeadingZeroBits(8);
const REAL_GENESIS = genesisAt(T8);

/**
 * Builds on its node's tip and publishes at once. This is what the honest
 * miner does; it is kept local so these tests exercise only the engine.
 */
const onTip = (n: number): MinerStrategy => {
  const address = keyN(n).address;
  return { onBlockFound: (ctx) => void ctx.publish(ctx.solve(ctx.chain.createBlockTemplate(address, ctx.timestamp))) };
};

interface NetOpts {
  seed?: number;
  genesis?: Block;
  blockInterval?: number;
  recordLog?: boolean;
}

function makeNet(nodes: number, opts: NetOpts = {}) {
  const net = new Network({ seed: opts.seed ?? 1, genesis: opts.genesis ?? FAST_GENESIS, ...opts });
  const ids = Array.from({ length: nodes }, () => net.addNode());
  return { net, ids };
}

/** Fire events until `count` more blocks have been found. */
function runBlocks(net: Network, count: number): void {
  for (let found = 0; found < count; ) {
    const e = net.sim.step();
    if (!e) throw new Error('ran out of events');
    if (e.type === 'block-found') found++;
  }
}

/** Fire every remaining event. Only ends once no miner has hash power. */
function drain(net: Network): void {
  while (net.sim.step());
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const gapsOf = (times: number[], start = 0) => times.map((t, i) => t - (i === 0 ? start : times[i - 1]));

// ---------------------------------------------------------------------------
// When blocks are found
// ---------------------------------------------------------------------------

describe('Mining: block timing', () => {
  it('schedules nothing until some node has hash power', () => {
    const { net, ids } = makeNet(2);
    expect(net.sim.pending).toBe(0);
    expect(net.sim.runUntil(1e6)).toBe(0);

    net.mining.setMiner(ids[0], onTip(1), 0);
    expect(net.sim.pending).toBe(0);
    net.mining.setHashPower(ids[0], 1);
    expect(net.sim.pending).toBe(1);
  });

  it('finds a block every blockInterval on average, with exponentially distributed gaps', () => {
    const { net, ids } = makeNet(1, { blockInterval: 600 });
    net.mining.setMiner(ids[0], onTip(1), 1);
    runBlocks(net, 4000);

    const gaps = gapsOf(net.mining.minedBlocks().map((b) => b.foundAt));
    expect(mean(gaps)).toBeGreaterThan(570);
    expect(mean(gaps)).toBeLessThan(630);
    // For Exp with mean m, P(gap < m) = 1 − 1/e ≈ 0.632. Evenly spaced blocks would give 0 or 1 here.
    const shorter = gaps.filter((g) => g < 600).length / gaps.length;
    expect(Math.abs(shorter - (1 - Math.exp(-1)))).toBeLessThan(0.03);
    expect(net.node(ids[0]).chain.height).toBe(4000);
  });

  it('uses the configured interval, and a new interval takes effect at once', () => {
    const { net, ids } = makeNet(1, { blockInterval: 10 });
    net.mining.setMiner(ids[0], onTip(1), 1);
    runBlocks(net, 2000);
    expect(Math.abs(mean(gapsOf(net.mining.minedBlocks().map((b) => b.foundAt))) - 10)).toBeLessThan(1);

    const switchedAt = net.sim.now;
    net.mining.blockInterval = 100;
    expect(net.mining.blockInterval).toBe(100);
    runBlocks(net, 2000);
    const later = net.mining.minedBlocks().slice(2000).map((b) => b.foundAt);
    expect(Math.abs(mean(gapsOf(later, switchedAt)) - 100)).toBeLessThan(10);
    expect(net.sim.pending).toBe(1); // the old draw was cancelled, not left alongside the new one
  });
});

// ---------------------------------------------------------------------------
// Who finds them
// ---------------------------------------------------------------------------

describe('Mining: winner by hash share', () => {
  it('picks each winner with probability equal to its hash share', () => {
    // No links, so each node just extends its own chain and the counts are easy to read.
    const { net, ids } = makeNet(4);
    const powers = [1, 2, 5, 0];
    ids.forEach((id, i) => net.mining.setMiner(id, onTip(i + 1), powers[i]));
    expect(net.mining.totalHashPower).toBe(8);
    expect(ids.map((id) => net.mining.share(id))).toEqual([0.125, 0.25, 0.625, 0]);

    const n = 4000;
    runBlocks(net, n);
    const wins = ids.map((id) => net.mining.minedBlocks().filter((b) => b.miner === id).length);
    ids.forEach((id, i) => {
      expect(Math.abs(wins[i] / n - net.mining.share(id))).toBeLessThan(0.03);
      expect(net.node(id).chain.height).toBe(wins[i]);
    });
    expect(wins[3]).toBe(0); // no hash power, never wins
  });

  it('applies a hash-power change from the moment it is made', () => {
    const { net, ids } = makeNet(2);
    net.mining.setMiner(ids[0], onTip(1), 1);
    net.mining.setMiner(ids[1], onTip(2), 0);
    runBlocks(net, 20);
    expect(net.mining.minedBlocks().every((b) => b.miner === ids[0])).toBe(true);

    const t = net.sim.now;
    net.mining.setHashPower(ids[0], 0);
    net.mining.setHashPower(ids[1], 1);
    expect(net.sim.pending).toBe(1);
    runBlocks(net, 20);
    const after = net.mining.minedBlocks().filter((b) => b.foundAt > t);
    expect(after).toHaveLength(20);
    expect(after.every((b) => b.miner === ids[1])).toBe(true);
  });

  it('stops when every miner has zero power or is removed', () => {
    const { net, ids } = makeNet(2);
    net.mining.setMiner(ids[0], onTip(1), 1);
    net.mining.setHashPower(ids[0], 0);
    expect(net.sim.pending).toBe(0);
    net.mining.setHashPower(ids[0], 1);
    expect(net.sim.pending).toBe(1);

    expect(net.mining.removeMiner(ids[0])).toBe(true);
    expect(net.mining.removeMiner(ids[0])).toBe(false);
    expect(net.mining.minerIds()).toEqual([]);
    expect(net.mining.hashPower(ids[0])).toBe(0);
    expect(net.sim.pending).toBe(0);

    // Removing the node removes its miner too.
    net.mining.setMiner(ids[1], onTip(2), 3);
    net.removeNode(ids[1]);
    expect(net.mining.minerIds()).toEqual([]);
    expect(net.sim.pending).toBe(0);
  });

  it('never picks a node again once it has been removed', () => {
    const { net, ids } = makeNet(3);
    ids.forEach((id, i) => net.mining.setMiner(id, onTip(i + 1), 1));
    runBlocks(net, 30);
    const t = net.sim.now;
    net.removeNode(ids[1]);
    runBlocks(net, 200);
    const after = net.mining.minedBlocks().filter((b) => b.foundAt > t);
    expect(after.some((b) => b.miner === ids[1])).toBe(false);
    expect(after.some((b) => b.miner === ids[0]) && after.some((b) => b.miner === ids[2])).toBe(true);
  });

  it('replacing a strategy without changing the power keeps the pending draw', () => {
    const { net, ids } = makeNet(1, { recordLog: true });
    net.mining.setMiner(ids[0], onTip(1), 1);
    const before = net.sim.nextEventTime;
    let called = false;
    net.mining.setMiner(ids[0], { onBlockFound: () => void (called = true) }, 1);
    expect(net.sim.nextEventTime).toBe(before);
    runBlocks(net, 1);
    expect(called).toBe(true);
  });

  it('draws exactly one next block when a strategy changes hash power while handling its own', () => {
    const { net, ids } = makeNet(1);
    let calls = 0;
    net.mining.setMiner(ids[0], { onBlockFound: () => net.mining.setHashPower(ids[0], ++calls + 1) }, 1);
    runBlocks(net, 5);
    expect(net.sim.pending).toBe(1);

    // And one that switches itself off stops the engine.
    const { net: net2, ids: ids2 } = makeNet(1);
    net2.mining.setMiner(ids2[0], { onBlockFound: () => net2.mining.setHashPower(ids2[0], 0) }, 1);
    runBlocks(net2, 1);
    expect(net2.sim.pending).toBe(0);
  });

  it('rejects bad inputs', () => {
    const { net, ids } = makeNet(1);
    expect(() => net.mining.setMiner(99, onTip(1), 1)).toThrow(/unknown node/);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => net.mining.setMiner(ids[0], onTip(1), bad)).toThrow(RangeError);
    }
    expect(() => net.mining.setHashPower(ids[0], 1)).toThrow(/not a miner/);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => makeNet(1, { blockInterval: bad })).toThrow(RangeError);
      expect(() => (net.mining.blockInterval = bad)).toThrow(RangeError);
    }
  });
});

// ---------------------------------------------------------------------------
// Simulated vs real PoW, and what a strategy is given
// ---------------------------------------------------------------------------

describe('Mining: simulated and real PoW', () => {
  it('simulated PoW: the first nonce wins, blocks are marked, and every node still validates them', () => {
    const { net, ids } = makeNet(3);
    net.connect(ids[0], ids[1], { latency: 1 });
    net.connect(ids[1], ids[2], { latency: 1 });
    net.mining.setMiner(ids[0], onTip(1), 1);
    runBlocks(net, 10);
    net.mining.setHashPower(ids[0], 0);
    drain(net);

    const records = net.mining.minedBlocks();
    expect(records).toHaveLength(10);
    expect(records.every((r) => r.pow === 'simulated' && r.attempts === 1 && r.miner === ids[0])).toBe(true);
    for (const id of ids) {
      expect(net.node(id).chain.height).toBe(10);
      expect(records.every((r) => net.node(id).chain.isOnMainChain(r.hash))).toBe(true);
    }
  });

  it('real PoW: the winner searches nonces, and peers accept the blocks because they meet the target', () => {
    const { net, ids } = makeNet(2, { genesis: REAL_GENESIS });
    net.connect(ids[0], ids[1], { latency: 1 });
    net.mining.setMiner(ids[0], onTip(1), 1);
    runBlocks(net, 20);
    net.mining.setHashPower(ids[0], 0);
    drain(net);

    const peer = net.node(ids[1]).chain;
    expect(peer.height).toBe(20);
    for (const block of peer.blocks.slice(1)) {
      expect(meetsTarget(blockHash(block.header), T8)).toBe(true);
      expect(net.mining.minedBlock(blockHashHex(block.header))?.pow).toBe('real');
    }
    // About 2^8 = 256 tries per block on average, far more than the single try of simulated PoW.
    const avg = mean(net.mining.minedBlocks().map((r) => r.attempts));
    expect(avg).toBeGreaterThan(50);
    expect(avg).toBeLessThan(2000);
  });

  it("gives the strategy the winner's node, chain and the simulated time", () => {
    const { net, ids } = makeNet(2);
    const seen: { ctx: MinerContext; minedTimestamp: number }[] = [];
    const recorder: MinerStrategy = {
      onBlockFound: (ctx) => {
        onTip(ctx.id + 1).onBlockFound(ctx);
        seen.push({ ctx, minedTimestamp: ctx.chain.blocks.at(-1)!.header.timestamp });
      },
    };
    ids.forEach((id) => net.mining.setMiner(id, recorder, 1));
    runBlocks(net, 10);

    const records = net.mining.minedBlocks();
    seen.forEach(({ ctx, minedTimestamp }, i) => {
      expect(ctx.id).toBe(records[i].miner);
      expect(ctx.chain).toBe(net.node(ctx.id).chain);
      expect(ctx.timestamp).toBe(Math.round(records[i].foundAt * 1000));
      expect(minedTimestamp).toBe(ctx.timestamp);
    });
  });

  it('records blocks a strategy keeps to itself (a selfish miner will need this)', () => {
    const { net, ids } = makeNet(1);
    const address = keyN(1).address;
    net.mining.setMiner(ids[0], { onBlockFound: (ctx) => void ctx.solve(ctx.chain.createBlockTemplate(address, ctx.timestamp)) }, 1);
    runBlocks(net, 3);
    expect(net.mining.minedBlocks()).toHaveLength(3);
    expect(net.node(ids[0]).chain.height).toBe(0);
    expect(net.mining.minedBlock(blockHashHex(FAST_GENESIS.header))).toBeUndefined();
  });

  it('logs block-found events with the winning miner', () => {
    const { net, ids } = makeNet(1, { recordLog: true });
    net.mining.setMiner(ids[0], onTip(1), 1);
    runBlocks(net, 3);
    expect(net.sim.log.map((e) => e.event)).toEqual([
      { type: 'block-found', miner: ids[0] },
      { type: 'block-found', miner: ids[0] },
      { type: 'block-found', miner: ids[0] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Reproducibility
// ---------------------------------------------------------------------------

describe('Mining: reproducibility', () => {
  /** A short run with forks and jitter, summarised as one line per fired event. */
  function run(seed: number): string[] {
    const { net, ids } = makeNet(3, { seed, recordLog: true, blockInterval: 10 });
    net.connect(ids[0], ids[1], { latency: 2, jitter: 1 });
    net.connect(ids[1], ids[2], { latency: 2, jitter: 1 });
    ids.forEach((id, i) => net.mining.setMiner(id, onTip(i + 1), i + 1));
    net.sim.runUntil(500);
    return net.sim.log.map(({ time, event: e }) =>
      e.type === 'block-found'
        ? `${time} found by ${e.miner}`
        : `${time} ${e.from}->${e.to} ${blockHashHex(e.block.header)}`,
    );
  }

  it('the same seed gives the same event log, and a different seed a different one', () => {
    const a = run(7);
    expect(a.length).toBeGreaterThan(50);
    expect(run(7)).toEqual(a);
    expect(run(8)).not.toEqual(a);
  });
});

// ---------------------------------------------------------------------------
// Strategy hooks
// ---------------------------------------------------------------------------

describe('Mining: strategy hooks', () => {
  /** With simulated PoW the first nonce always works. */
  const solved = (t: Block): Block => ({ header: mineChunk(t.header, 1).header, txs: t.txs });

  /** Mines on its tip like onTip, and records each block its node receives from a peer. */
  function watcher(n: number) {
    const received: { hash: string; status: AcceptedBlock['status']; timestamp: number }[] = [];
    const strategy: MinerStrategy = {
      ...onTip(n),
      onBlockReceived: (ctx, block, result) =>
        void received.push({ hash: blockHashHex(block.header), status: result.status, timestamp: ctx.timestamp }),
    };
    return { strategy, received };
  }

  it('tells each miner about every block a peer delivers, once, on arrival, and never about its own', () => {
    const { net, ids } = makeNet(3, { blockInterval: 10 });
    // A triangle: every block reaches each other node twice, first straight from its finder.
    net.connect(ids[0], ids[1], { latency: 1 });
    net.connect(ids[1], ids[2], { latency: 1 });
    net.connect(ids[0], ids[2], { latency: 1 });
    const watchers = ids.map((id, i) => {
      const w = watcher(i + 1);
      net.mining.setMiner(id, w.strategy, 1);
      return w;
    });
    runBlocks(net, 30);
    for (const id of ids) net.mining.setHashPower(id, 0);
    drain(net);

    const records = net.mining.minedBlocks();
    ids.forEach((id, i) => {
      const expected = records
        .filter((r) => r.miner !== id)
        .map((r) => ({ hash: r.hash, timestamp: Math.round((r.foundAt + 1) * 1000) }));
      const got = watchers[i].received.map(({ hash, timestamp }) => ({ hash, timestamp }));
      expect(got).toEqual(expected);
    });
  });

  it('says where the block landed: main chain, side branch or orphan pool', () => {
    const { net, ids } = makeNet(2);
    const [a, b] = ids;
    net.connect(a, b, { latency: 1 });
    const w = watcher(2);
    net.mining.setMiner(b, w.strategy, 0);
    const chainA = net.node(a).chain;

    const x = solved(chainA.createBlockTemplate(keyN(1).address, 1));
    const y = solved(chainA.createBlockTemplate(keyN(3).address, 2)); // also on genesis: x's competitor
    net.publish(a, x);
    net.publish(a, y);
    const hidden = solved(chainA.createBlockTemplate(keyN(1).address, 3)); // on x, kept by node a
    chainA.submitBlock(hidden);
    const z = solved(chainA.createBlockTemplate(keyN(1).address, 4)); // on hidden, which b never gets
    net.publish(a, z);
    drain(net);

    expect(w.received.map((r) => r.status)).toEqual(['main', 'stale', 'orphan']);
    expect(net.node(b).chain.tree.isOrphan(blockHashHex(z.header))).toBe(true);
  });

  it('gives code outside the hooks the same view and actions, as of now', () => {
    const { net, ids } = makeNet(2);
    const [a, b] = ids;
    net.connect(a, b, { latency: 1 });
    net.sim.runUntil(12.3456);
    const ctx = net.mining.nodeContext(a);
    expect(ctx.id).toBe(a);
    expect(ctx.chain).toBe(net.node(a).chain);
    expect(ctx.timestamp).toBe(12_346);

    // keyN(999) owns the genesis coinbase.
    const tx = buildPayment(ctx.chain.confirmedUtxos(), keyN(999), keyN(1).address, COIN, 1_000);
    expect(ctx.broadcastTransaction(tx)).toEqual({ ok: true, fee: 1_000 });
    expect(net.node(b).chain.mempool.map(txidHex)).toEqual([txidHex(tx)]);

    expect(ctx.publish(solved(ctx.chain.createBlockTemplate(keyN(1).address, ctx.timestamp))).ok).toBe(true);
    drain(net);
    expect(net.node(b).chain.height).toBe(1);
    expect(net.node(b).chain.txConfirmations(txidHex(tx))).toBe(1);
  });
});
