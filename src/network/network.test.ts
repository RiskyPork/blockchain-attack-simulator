import { describe, expect, it } from 'vitest';
import { type Block, type BlockHeader, ZERO_HASH, blockHashHex, targetFromLeadingZeroBits } from '../core/block';
import { hexToBytes } from '../core/hash';
import { type KeyPair, keyPairFromPrivate } from '../core/keys';
import { assembleBlock, mineChunk } from '../core/miner';
import type { Chain } from '../node/chain';
import { type BlockArrive, Network } from './network';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const keyN = (n: number): KeyPair => keyPairFromPrivate(hexToBytes(n.toString(16).padStart(64, '0')));
const minerA = keyN(1);
const minerB = keyN(2);

const T8 = targetFromLeadingZeroBits(8);

function mineHeaderSync(header: BlockHeader): BlockHeader {
  let h = header;
  for (;;) {
    const r = mineChunk(h, 20_000);
    if (r.found) return r.header;
    h = r.header;
  }
}
const mined = (b: Block): Block => ({ header: mineHeaderSync(b.header), txs: b.txs });

const GENESIS = mined(
  assembleBlock({ prevHash: ZERO_HASH, height: 0, timestamp: 0, target: T8, minerAddress: minerA.address, txs: [], fees: 0 }),
);
const GENESIS_HASH = blockHashHex(GENESIS.header);

/** A real-PoW block on top of `chain`'s current tip. Different miners give different blocks on the same parent. */
const nextBlock = (chain: Chain, miner: KeyPair = minerA, timestamp = 1): Block =>
  mined(chain.createBlockTemplate(miner.address, timestamp));

const hashOf = (b: Block) => blockHashHex(b.header);
const tipOf = (chain: Chain) => hashOf(chain.blocks.at(-1)!);

function makeNetwork(n: number, opts: { seed?: number; recordLog?: boolean } = {}) {
  const net = new Network({ seed: opts.seed ?? 1, genesis: GENESIS, recordLog: opts.recordLog });
  const ids = Array.from({ length: n }, () => net.addNode());
  return { net, ids };
}

/** Log entries for block arrivals, in the order they fired. */
const arrivals = (net: Network): BlockArrive[] =>
  net.sim.log.map((e) => e.event).filter((e): e is BlockArrive => e.type === 'block-arrive');

// ---------------------------------------------------------------------------
// Nodes and links
// ---------------------------------------------------------------------------

describe('Network nodes', () => {
  it('starts every node on the shared genesis block', () => {
    const { net, ids } = makeNetwork(3);
    expect(ids).toEqual([0, 1, 2]);
    for (const id of ids) {
      const chain = net.node(id).chain;
      expect(chain.height).toBe(0);
      expect(tipOf(chain)).toBe(GENESIS_HASH);
      expect(chain.target).toBe(T8);
    }
  });

  it('rejects a genesis block that is not a valid first block', () => {
    const notMined = assembleBlock({
      prevHash: ZERO_HASH, height: 0, timestamp: 0, target: T8, minerAddress: minerA.address, txs: [], fees: 0,
    });
    const unmined = { header: { ...notMined.header, target: 1n }, txs: notMined.txs };
    expect(() => new Network({ seed: 1, genesis: unmined })).toThrow(/genesis/);
  });

  it('never reuses the id of a removed node', () => {
    const { net } = makeNetwork(2);
    net.removeNode(1);
    expect(net.addNode()).toBe(2);
    expect(net.nodeIds()).toEqual([0, 2]);
  });

  it('throws for an unknown node', () => {
    const { net } = makeNetwork(1);
    expect(() => net.node(7)).toThrow(/unknown node/);
    expect(() => net.removeNode(7)).toThrow(/unknown node/);
  });
});

describe('Network links', () => {
  it('connects two nodes in both directions', () => {
    const { net } = makeNetwork(3);
    net.connect(0, 1, { latency: 2 });
    net.connect(1, 2, { latency: 3, jitter: 0.5 });
    expect(net.peersOf(1)).toEqual([0, 2]);
    expect(net.peersOf(0)).toEqual([1]);
    expect(net.link(2, 1)).toEqual({ a: 1, b: 2, latency: 3, jitter: 0.5 });
    expect(net.links()).toEqual([
      { a: 0, b: 1, latency: 2, jitter: 0 },
      { a: 1, b: 2, latency: 3, jitter: 0.5 },
    ]);
  });

  it('rejects self links, duplicate links, unknown nodes and bad latencies', () => {
    const { net } = makeNetwork(2);
    expect(() => net.connect(0, 0, { latency: 1 })).toThrow(/itself/);
    expect(() => net.connect(0, 5, { latency: 1 })).toThrow(/unknown node/);
    expect(() => net.connect(0, 1, { latency: -1 })).toThrow(RangeError);
    expect(() => net.connect(0, 1, { latency: 1, jitter: Number.NaN })).toThrow(RangeError);
    net.connect(0, 1, { latency: 1 });
    expect(() => net.connect(1, 0, { latency: 1 })).toThrow(/already connected/);
  });

  it('updates a link, and the new latency applies to later messages', () => {
    const { net } = makeNetwork(2);
    net.connect(0, 1, { latency: 1 });
    net.updateLink(1, 0, { latency: 9 });
    expect(net.link(0, 1)).toMatchObject({ latency: 9, jitter: 0 });
    net.publish(0, nextBlock(net.node(0).chain));
    expect(net.inFlight()[0].arriveAt).toBe(9);
    expect(() => net.updateLink(0, 1, { jitter: -2 })).toThrow(RangeError);
  });

  it('disconnect stops later gossip over that link', () => {
    const { net } = makeNetwork(2);
    net.connect(0, 1, { latency: 1 });
    expect(net.disconnect(0, 1)).toBe(true);
    expect(net.disconnect(0, 1)).toBe(false);
    net.publish(0, nextBlock(net.node(0).chain));
    net.sim.runUntil(10);
    expect(net.node(1).chain.height).toBe(0);
    expect(net.stats.sent).toBe(0);
  });

  it('removing a node removes its links', () => {
    const { net } = makeNetwork(3);
    net.connect(0, 1, { latency: 1 });
    net.connect(1, 2, { latency: 1 });
    net.removeNode(1);
    expect(net.peersOf(0)).toEqual([]);
    expect(net.links()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Propagation
// ---------------------------------------------------------------------------

describe('Network propagation', () => {
  it('delivers a block hop by hop after each link latency', () => {
    const { net } = makeNetwork(3);
    net.connect(0, 1, { latency: 2 });
    net.connect(1, 2, { latency: 3 });
    const b = nextBlock(net.node(0).chain);

    const result = net.publish(0, b);
    expect(result).toMatchObject({ ok: true, status: 'main' });
    expect(net.node(0).chain.height).toBe(1);

    net.sim.runUntil(1.99);
    expect(net.node(1).chain.height).toBe(0);
    net.sim.runUntil(2);
    expect(tipOf(net.node(1).chain)).toBe(hashOf(b));
    net.sim.runUntil(4.99);
    expect(net.node(2).chain.height).toBe(0);
    net.sim.runUntil(5);
    expect(tipOf(net.node(2).chain)).toBe(hashOf(b));
  });

  it('never sends a block back to the peer it came from', () => {
    const { net } = makeNetwork(2);
    net.connect(0, 1, { latency: 1 });
    net.publish(0, nextBlock(net.node(0).chain));
    net.sim.runUntil(100);
    expect(net.stats).toEqual({ sent: 1, delivered: 1, dropped: 0 });
  });

  it('floods a full mesh with each node relaying the block at most once', () => {
    const n = 5;
    const { net, ids } = makeNetwork(n, { recordLog: true });
    for (const a of ids) for (const b of ids) if (a < b) net.connect(a, b, { latency: 1 + a + b });
    const block = nextBlock(net.node(0).chain);
    net.publish(0, block);
    net.sim.runUntil(1_000);

    for (const id of ids) expect(tipOf(net.node(id).chain)).toBe(hashOf(block));
    // The origin sends to n−1 peers; each other node relays once, to everyone except its sender.
    expect(net.stats.sent).toBe(n - 1 + (n - 1) * (n - 2));
    expect(net.sim.pending).toBe(0);

    const sends = arrivals(net).map((e) => `${e.from}->${e.to}`);
    expect(new Set(sends).size).toBe(sends.length);
  });

  it('does not gossip a block its node rejects', () => {
    const { net } = makeNetwork(2);
    net.connect(0, 1, { latency: 1 });
    const chain = net.node(0).chain;
    // Coinbase claims a fee that no tx pays: valid PoW, invalid block.
    const greedy = mined(
      assembleBlock({ prevHash: chain.tipHash, height: 1, timestamp: 1, target: T8, minerAddress: minerA.address, txs: [], fees: 1 }),
    );
    expect(net.publish(0, greedy)).toMatchObject({ ok: false });
    // No PoW at all.
    const lazy = chain.createBlockTemplate(minerA.address, 2);
    expect(net.publish(0, { header: { ...lazy.header, target: 1n }, txs: lazy.txs })).toMatchObject({ ok: false });
    expect(net.stats.sent).toBe(0);
  });

  it('does not gossip a block the node already has', () => {
    const { net } = makeNetwork(2);
    net.connect(0, 1, { latency: 1 });
    const b = nextBlock(net.node(0).chain);
    net.publish(0, b);
    expect(net.publish(0, b)).toMatchObject({ ok: false, error: { code: 'duplicate' } });
    expect(net.stats.sent).toBe(1);
  });

  it('adds seeded jitter within [latency, latency + jitter]', () => {
    const { net, ids } = makeNetwork(6, { seed: 7 });
    for (const id of ids.slice(1)) net.connect(0, id, { latency: 2, jitter: 3 });
    net.publish(0, nextBlock(net.node(0).chain));
    const delays = net.inFlight().map((d) => d.arriveAt - d.sentAt);
    expect(delays).toHaveLength(5);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(2);
      expect(d).toBeLessThan(5);
    }
    expect(new Set(delays).size).toBe(5);
  });

  it('lists messages in flight until they arrive, for the UI to animate', () => {
    const { net } = makeNetwork(2);
    net.connect(0, 1, { latency: 4 });
    net.sim.runUntil(1);
    const b = nextBlock(net.node(0).chain);
    net.publish(0, b);
    expect(net.inFlight()).toEqual([{ from: 0, to: 1, hash: hashOf(b), sentAt: 1, arriveAt: 5 }]);
    net.sim.runUntil(3);
    expect(net.inFlight()).toHaveLength(1);
    net.sim.runUntil(5);
    expect(net.inFlight()).toEqual([]);
  });

  it('drops messages addressed to a node removed while they were in flight', () => {
    const { net } = makeNetwork(2);
    net.connect(0, 1, { latency: 4 });
    net.publish(0, nextBlock(net.node(0).chain));
    net.removeNode(1);
    net.sim.runUntil(10);
    expect(net.stats).toEqual({ sent: 1, delivered: 0, dropped: 1 });
    expect(net.inFlight()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Forks across the network
// ---------------------------------------------------------------------------

describe('Network forks', () => {
  it('forks when two nodes mine at once, then resolves to the branch with more work', () => {
    const { net } = makeNetwork(2);
    net.connect(0, 1, { latency: 10 });
    const a = nextBlock(net.node(0).chain, minerA);
    const b = nextBlock(net.node(1).chain, minerB);
    net.publish(0, a);
    net.publish(1, b);
    net.sim.runUntil(10);

    // Both blocks have equal work, so each node keeps the one it saw first.
    expect(tipOf(net.node(0).chain)).toBe(hashOf(a));
    expect(tipOf(net.node(1).chain)).toBe(hashOf(b));
    expect(net.node(0).chain.tree.has(hashOf(b))).toBe(true);
    expect(net.node(1).chain.tree.has(hashOf(a))).toBe(true);

    // Node 0 extends its branch; once node 1 hears of it, node 1 reorgs onto it.
    const c = nextBlock(net.node(0).chain, minerA, 2);
    net.publish(0, c);
    net.sim.runUntil(20);
    for (const id of [0, 1]) {
      const chain = net.node(id).chain;
      expect(tipOf(chain)).toBe(hashOf(c));
      expect(chain.isOnMainChain(hashOf(b))).toBe(false); // b is now a stale block
      expect(chain.tree.has(hashOf(b))).toBe(true);
    }
  });

  it('connects a block that overtakes its parent through the orphan pool', () => {
    // With jitter, a child can overtake its parent on the same link. Find seeds where that happens.
    let overtaken = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const { net } = makeNetwork(2, { seed, recordLog: true });
      net.connect(0, 1, { latency: 1, jitter: 5 });
      const parent = nextBlock(net.node(0).chain, minerA, 1);
      net.publish(0, parent);
      const child = nextBlock(net.node(0).chain, minerA, 2);
      net.publish(0, child);
      net.sim.runUntil(100);

      expect(tipOf(net.node(1).chain)).toBe(hashOf(child));
      expect(net.node(1).chain.tree.orphans()).toEqual([]);
      if (arrivals(net)[0].block === child) overtaken++;
    }
    expect(overtaken).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Sync on connect
// ---------------------------------------------------------------------------

describe('Network sync on connect', () => {
  it('sends a newly connected node only the blocks it is missing', () => {
    const { net } = makeNetwork(1);
    const chain0 = net.node(0).chain;
    net.publish(0, nextBlock(chain0, minerA, 1));
    net.publish(0, nextBlock(chain0, minerA, 2));
    const late = net.addNode();

    net.connect(0, late, { latency: 2 });
    expect(net.stats.sent).toBe(2); // genesis is shared, so it isn't sent
    net.sim.runUntil(2);
    expect(net.node(late).chain.height).toBe(2);
    expect(tipOf(net.node(late).chain)).toBe(tipOf(chain0));
    // The synced blocks are not relayed back to the node that sent them.
    expect(net.stats.sent).toBe(2);
  });

  it('heals a partition: both sides converge on the branch with more work', () => {
    const { net } = makeNetwork(2);
    // Mined in isolation: node 0 builds two blocks, node 1 builds one on a rival branch.
    const a1 = nextBlock(net.node(0).chain, minerA, 1);
    net.publish(0, a1);
    const a2 = nextBlock(net.node(0).chain, minerA, 2);
    net.publish(0, a2);
    const b1 = nextBlock(net.node(1).chain, minerB, 1);
    net.publish(1, b1);

    net.connect(0, 1, { latency: 3 });
    net.sim.runUntil(3);
    for (const id of [0, 1]) {
      const chain = net.node(id).chain;
      expect(tipOf(chain)).toBe(hashOf(a2));
      expect(chain.tree.has(hashOf(b1))).toBe(true);
      expect(chain.isOnMainChain(hashOf(b1))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Reproducibility
// ---------------------------------------------------------------------------

describe('Network reproducibility', () => {
  /** A small jittered mesh where several nodes publish blocks at different times. */
  function run(seed: number) {
    const { net, ids } = makeNetwork(4, { seed, recordLog: true });
    net.connect(0, 1, { latency: 1, jitter: 2 });
    net.connect(1, 2, { latency: 2, jitter: 2 });
    net.connect(2, 3, { latency: 1, jitter: 2 });
    net.connect(3, 0, { latency: 3, jitter: 2 });
    for (const [t, id] of [[0, 0], [0.5, 2], [4, 1], [4.2, 3]] as const) {
      net.sim.runUntil(t);
      net.publish(id, nextBlock(net.node(id).chain, id % 2 ? minerB : minerA, Math.ceil(t) + 1));
    }
    net.sim.runUntil(100);
    return {
      log: net.sim.log.map((e) => ({ time: e.time, ...summarise(e.event as BlockArrive) })),
      tips: ids.map((id) => tipOf(net.node(id).chain)),
    };
  }
  const summarise = (e: BlockArrive) => ({ from: e.from, to: e.to, hash: hashOf(e.block) });

  it('gives an identical event log for the same seed', () => {
    const a = run(42);
    expect(a.log.length).toBeGreaterThan(10);
    expect(run(42)).toEqual(a);
  });

  it('gives different arrival times for a different seed', () => {
    expect(run(43).log).not.toEqual(run(42).log);
  });
});
