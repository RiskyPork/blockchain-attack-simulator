import { describe, expect, it } from 'vitest';
import { type Activity, DEFAULT_OPTIONS, MAX_NODES, Playground, minerAddress } from './playground';

const isFound = (a: Activity) => a.kind === 'found';
const isReorg = (a: Activity): a is Extract<Activity, { kind: 'reorg' }> => a.kind === 'reorg';

/** A summary of a run that two identical runs must agree on exactly. */
function fingerprint(pg: Playground) {
  return {
    now: pg.now,
    tips: pg.nodes().map((n) => [n.id, n.height, n.tip]),
    activity: pg.activity,
    mined: pg.net.mining.minedBlocks(),
    stats: pg.net.stats,
  };
}

/** Stop all mining and let every message arrive. */
function settle(pg: Playground): void {
  for (const id of pg.ring) pg.setHashPower(id, 0);
  while (pg.step());
}

describe('Playground setup', () => {
  it('starts with the default nodes in a ring, each an honest miner on genesis', () => {
    const pg = new Playground();
    expect(pg.ring).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pg.net.links()).toHaveLength(6);
    for (const [i, n] of pg.nodes().entries()) {
      const ring = pg.ring;
      expect(n.peers.sort()).toEqual([ring[(i + 5) % 6], ring[(i + 1) % 6]].sort());
      expect(n.hashPower).toBe(DEFAULT_OPTIONS.hashPowers[i]);
      expect(n.height).toBe(0);
      expect(pg.net.mining.strategyOf(n.id)).toMatchObject({ rewardAddress: minerAddress(n.id) });
    }
    expect(pg.nodes().reduce((s, n) => s + n.share, 0)).toBeCloseTo(1);
    for (const l of pg.net.links()) expect(l).toMatchObject({ latency: DEFAULT_OPTIONS.latency, jitter: DEFAULT_OPTIONS.jitter });
  });

  it('inserts a new node between the last and the first, and it catches up over its links', () => {
    const pg = new Playground({ hashPowers: [1, 1, 1] });
    pg.advance(600 * 20);
    const id = pg.addNode(0);
    expect(pg.ring).toEqual([0, 1, 2, id]);
    expect(pg.net.link(2, 0)).toBeUndefined();
    expect(pg.net.peersOf(id).sort()).toEqual([0, 2]);
    expect(pg.chain(id).height).toBe(0);

    settle(pg);
    expect(new Set(pg.nodes().map((n) => n.tip)).size).toBe(1);
    expect(pg.chain(id).height).toBeGreaterThan(5);
  });

  it('grows from one and two nodes into a ring', () => {
    const pg = new Playground({ hashPowers: [1] });
    pg.addNode();
    expect(pg.net.links()).toHaveLength(1);
    pg.addNode();
    expect(pg.net.links()).toHaveLength(3); // a triangle
    pg.addNode();
    expect(pg.net.links()).toHaveLength(4);
    expect(pg.nodes().every((n) => n.peers.length === 2)).toBe(true);
  });

  it('closes the ring when a node is removed, and keeps at least one node', () => {
    const pg = new Playground();
    pg.removeNode(3);
    expect(pg.ring).toEqual([0, 1, 2, 4, 5]);
    expect(pg.net.link(2, 4)).toBeDefined();
    expect(pg.nodes().every((n) => n.peers.length === 2)).toBe(true);

    pg.removeNode(0); // the first node: its neighbours are the last and the second
    expect(pg.net.link(5, 1)).toBeDefined();
    for (const id of [1, 2, 4]) pg.removeNode(id);
    expect(pg.ring).toEqual([5]);
    expect(() => pg.removeNode(5)).toThrow(/at least one/);
    expect(() => pg.removeNode(99)).toThrow(/unknown node/);
  });

  it(`allows at most ${MAX_NODES} nodes`, () => {
    const pg = new Playground();
    while (pg.ring.length < MAX_NODES) pg.addNode();
    expect(() => pg.addNode()).toThrow();
  });

  it('applies latency and jitter to every link', () => {
    const pg = new Playground();
    pg.setLatency(120);
    pg.setJitter(7);
    for (const l of pg.net.links()) expect(l).toMatchObject({ latency: 120, jitter: 7 });
    expect(() => pg.setLatency(-1)).toThrow(RangeError);
    expect(pg.latency).toBe(120);
    pg.addNode();
    for (const l of pg.net.links()) expect(l).toMatchObject({ latency: 120, jitter: 7 });
  });

  it('reset restarts from genesis with the same nodes, renumbered, and the new seed or PoW mode', () => {
    const pg = new Playground();
    pg.removeNode(1);
    pg.setHashPower(4, 55);
    pg.setLatency(30);
    pg.advance(600 * 10);
    pg.reset({ seed: 7, pow: 'real' });

    expect(pg.now).toBe(0);
    expect(pg.seed).toBe(7);
    expect(pg.ring).toEqual([0, 1, 2, 3, 4]);
    expect(pg.nodes().map((n) => n.hashPower)).toEqual([30, 15, 15, 55, 10]);
    expect(pg.nodes().every((n) => n.height === 0)).toBe(true);
    expect(pg.activity).toEqual([]);
    for (const l of pg.net.links()) expect(l.latency).toBe(30);

    pg.advance(600 * 3);
    const mined = pg.net.mining.minedBlocks();
    expect(mined.length).toBeGreaterThan(0);
    expect(mined.every((b) => b.pow === 'real' && b.attempts >= 1)).toBe(true);
    expect(() => pg.reset({ seed: 1.5 })).toThrow(RangeError);
  });
});

describe('Playground clock', () => {
  it('tick only moves the clock while playing, by real time × speed, capped per frame', () => {
    const pg = new Playground();
    pg.tick(0.1);
    expect(pg.now).toBe(0);

    pg.speed = 100;
    pg.play();
    pg.tick(0.1);
    expect(pg.now).toBeCloseTo(10);
    pg.tick(5); // e.g. the tab was in the background
    expect(pg.now).toBeCloseTo(35);
    pg.pause();
    pg.tick(0.1);
    expect(pg.now).toBeCloseTo(35);
    expect(() => (pg.speed = 0)).toThrow(RangeError);
  });

  it('step fires exactly one event and says what it did', () => {
    const pg = new Playground();
    const t = pg.net.sim.nextEventTime!;
    const e = pg.step();
    expect(e?.type).toBe('block-found');
    expect(pg.now).toBe(t);
    expect(pg.lastEvent).toMatch(/^N\d found block #1 /);

    const arrive = pg.step();
    expect(arrive?.type).toBe('block-arrive');
    expect(pg.lastEvent).toMatch(/reached N\d from N\d: new tip/);
  });

  it('step returns undefined once nothing is scheduled', () => {
    const pg = new Playground();
    pg.advance(600 * 3);
    settle(pg);
    const v = pg.version;
    expect(pg.step()).toBeUndefined();
    expect(pg.version).toBe(v);
  });

  it('notifies listeners and bumps the version when events fire or the setup changes', () => {
    const pg = new Playground();
    let calls = 0;
    pg.onChange(() => calls++);
    const v = pg.version;
    pg.advance(1); // probably nothing fires, but time moved
    expect(calls).toBe(1);
    pg.setLatency(5);
    expect(pg.version).toBeGreaterThan(v);
    expect(calls).toBe(2);
  });
});

describe('Playground runs', () => {
  it('the same seed and settings replay exactly, however the clock is sliced', () => {
    const opts = { seed: 9, latency: 60, jitter: 20 };
    const a = new Playground(opts);
    a.advance(600 * 40);

    const b = new Playground(opts);
    for (let i = 0; i < 2400; i++) b.advance(10); // like animation frames
    expect(fingerprint(b)).toEqual(fingerprint(a));

    const c = new Playground({ ...opts, seed: 10 });
    c.advance(600 * 40);
    expect(fingerprint(c)).not.toEqual(fingerprint(a));
  });

  it('logs every block found, and every node agrees once mining stops', () => {
    const pg = new Playground();
    pg.advance(600 * 30);
    settle(pg);
    const found = pg.activity.filter(isFound);
    expect(found.length).toBe(pg.blocksFound);
    expect(found.length).toBe(pg.net.mining.minedBlocks().length);
    expect(new Set(pg.nodes().map((n) => n.tip)).size).toBe(1);
  });

  it('high latency causes forks, and each logged reorg moves a node to a longer branch', () => {
    const pg = new Playground({ latency: 300, jitter: 100 });
    pg.advance(600 * 60);
    const reorgs = pg.activity.filter(isReorg);
    expect(reorgs.length).toBeGreaterThan(0);
    expect(pg.reorgs.count).toBe(reorgs.length);
    expect(pg.reorgs.deepest).toBe(Math.max(...reorgs.map((r) => r.depth)));
    for (const r of reorgs) {
      expect(r.depth).toBeGreaterThanOrEqual(1);
      // Every block has the same work here, so more work means a greater
      // height; an equal-height rival never wins (first seen is kept).
      expect(r.to.height).toBeGreaterThan(r.from.height);
    }
  });

  it('low latency rarely forks', () => {
    const pg = new Playground({ latency: 0.5, jitter: 0 });
    pg.advance(600 * 60);
    expect(pg.reorgs.count).toBeLessThanOrEqual(1);
  });

  it('keeps only the most recent 200 activity entries', () => {
    const pg = new Playground({ blockInterval: 1, latency: 0.01, jitter: 0 });
    pg.advance(400);
    expect(pg.blocksFound).toBeGreaterThan(200);
    expect(pg.activity).toHaveLength(200);
    expect(pg.activity.at(-1)!.time).toBeLessThanOrEqual(pg.now);
  });
});
