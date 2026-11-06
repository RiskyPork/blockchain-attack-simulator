import { describe, expect, it } from 'vitest';
import { type Block, ZERO_HASH, blockHash, blockHashHex, blockWork, targetFromLeadingZeroBits } from '../core/block';
import type { BlockError } from '../core/validation';
import { type AddResult, BlockTree, type StructureCheck } from './blocktree';

// The tree doesn't check PoW or contents (Chain does that before calling it),
// so these tests use unmined headers and a stub structure check.

const T8 = targetFromLeadingZeroBits(8);
const T9 = targetFromLeadingZeroBits(9);
let nonce = 0;

/** A distinct block on `parent` (null = genesis). */
function blockOn(parent: Block | null, target = T8): Block {
  return {
    header: {
      prevHash: parent ? blockHash(parent.header) : ZERO_HASH,
      merkleRoot: new Uint8Array(32),
      timestamp: 0,
      target,
      nonce: nonce++,
    },
    txs: [],
  };
}

/** A straight chain of `n` blocks starting on `parent`. */
function chainOn(parent: Block | null, n: number, target = T8): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < n; i++) out.push(blockOn(out.at(-1) ?? parent, target));
  return out;
}

const h = (b: Block) => blockHashHex(b.header);
const hashes = (r: AddResult) => (r.status === 'added' ? r.entries.map((e) => e.hash) : r.status);
const accept: StructureCheck = () => null;

/** Stub check that fails exactly the given blocks, and records every (block, height) it was asked about. */
function failing(bad: Map<string, BlockError>) {
  const calls: [string, number][] = [];
  const check: StructureCheck = (b, height) => {
    calls.push([h(b), height]);
    return bad.get(h(b)) ?? null;
  };
  return { check, calls };
}

describe('BlockTree: placing blocks', () => {
  it('starts empty', () => {
    const t = new BlockTree(accept);
    expect(t.size).toBe(0);
    expect(t.entries()).toEqual([]);
    expect(t.tips()).toEqual([]);
    expect(t.orphans()).toEqual([]);
    expect(t.bestTip()).toBeUndefined();
  });

  it('a block on ZERO_HASH is a genesis block: height 0, no parent, work of one block', () => {
    const t = new BlockTree(accept);
    const g = blockOn(null);
    expect(hashes(t.add(g))).toEqual([h(g)]);
    const e = t.get(h(g))!;
    expect(e).toMatchObject({ block: g, hash: h(g), parent: null, height: 0, chainWork: blockWork(T8), seq: 0 });
    expect(t.has(h(g))).toBe(true);
    expect(t.size).toBe(1);
  });

  it('children get parent height + 1 and cumulative work, summed per block target', () => {
    const t = new BlockTree(accept);
    const g = blockOn(null);
    const a = blockOn(g, T9);
    const b = blockOn(a);
    for (const x of [g, a, b]) t.add(x);
    expect(t.get(h(a))).toMatchObject({ parent: h(g), height: 1, chainWork: blockWork(T8) + blockWork(T9) });
    expect(t.get(h(b))).toMatchObject({ parent: h(a), height: 2, chainWork: 2n * blockWork(T8) + blockWork(T9) });
    expect(t.childrenOf(h(g)).map((e) => e.hash)).toEqual([h(a)]);
    expect(t.childrenOf(h(b))).toEqual([]);
  });

  it('passes the height the parent implies to the structure check', () => {
    const { check, calls } = failing(new Map());
    const t = new BlockTree(check);
    const [g, a, b] = chainOn(null, 3);
    t.add(g);
    t.add(a);
    t.add(b);
    expect(calls).toEqual([
      [h(g), 0],
      [h(a), 1],
      [h(b), 2],
    ]);
  });

  it('keeps every branch of a fork: both children are stored and both are tips (stale blocks are kept)', () => {
    const t = new BlockTree(accept);
    const g = blockOn(null);
    const a = blockOn(g);
    const b = blockOn(g);
    const b2 = blockOn(b);
    for (const x of [g, a, b, b2]) t.add(x);
    expect(t.size).toBe(4);
    expect(t.childrenOf(h(g)).map((e) => e.hash)).toEqual([h(a), h(b)]);
    expect(t.tips().map((e) => e.hash).sort()).toEqual([h(a), h(b2)].sort());
    expect(t.entries().map((e) => e.hash)).toEqual([g, a, b, b2].map(h));
  });

  it('two different genesis blocks are two branches', () => {
    const t = new BlockTree(accept);
    const g1 = blockOn(null);
    const g2 = blockOn(null);
    t.add(g1);
    t.add(g2);
    expect(t.tips().map((e) => e.hash).sort()).toEqual([h(g1), h(g2)].sort());
  });

  it('rejects a block it already holds as a duplicate', () => {
    const t = new BlockTree(accept);
    const g = blockOn(null);
    t.add(g);
    expect(t.add(g)).toEqual({ status: 'duplicate' });
    expect(t.size).toBe(1);
  });
});

describe('BlockTree: orphan pool', () => {
  it('holds a block whose parent is unknown, then connects it when the parent arrives', () => {
    const t = new BlockTree(accept);
    const [g, a] = chainOn(null, 2);
    expect(t.add(a)).toEqual({ status: 'orphan' });
    expect(t.isOrphan(h(a))).toBe(true);
    expect(t.has(h(a))).toBe(false);
    expect(t.orphans()).toEqual([a]);
    expect(t.add(a)).toEqual({ status: 'duplicate' });

    expect(hashes(t.add(g))).toEqual([h(g), h(a)]);
    expect(t.isOrphan(h(a))).toBe(false);
    expect(t.orphans()).toEqual([]);
    expect(t.get(h(a))).toMatchObject({ height: 1, parent: h(g) });
    // seq is the order blocks joined the tree, not arrival order
    expect(t.get(h(g))!.seq).toBeLessThan(t.get(h(a))!.seq);
  });

  it('a block whose parent is itself an orphan waits too', () => {
    const t = new BlockTree(accept);
    const [g, a, b] = chainOn(null, 3);
    expect(t.add(b).status).toBe('orphan');
    expect(t.add(a).status).toBe('orphan');
    expect(t.orphans()).toEqual([b, a]);
    expect(hashes(t.add(g))).toEqual([h(g), h(a), h(b)]);
  });

  it('connects a whole subtree of orphans, every parent before its children', () => {
    const t = new BlockTree(accept);
    const g = blockOn(null);
    const a = blockOn(g);
    const [a1, a2] = chainOn(a, 2);
    const b1 = blockOn(a);
    const c = blockOn(g);
    for (const x of [a2, b1, c, a1]) expect(t.add(x).status).toBe('orphan');
    t.add(g); // a is still missing: only c can connect
    expect(t.tips().map((e) => e.hash)).toEqual([h(c)]);
    const r = t.add(a);
    expect(hashes(r)).toEqual([h(a), h(b1), h(a1), h(a2)]);
    expect(t.orphans()).toEqual([]);
    expect(t.get(h(a2))!.height).toBe(3);
  });

  it('an orphan is only structure-checked once its height is known', () => {
    const { check, calls } = failing(new Map());
    const t = new BlockTree(check);
    const [g, a] = chainOn(null, 2);
    t.add(a);
    expect(calls).toEqual([]);
    t.add(g);
    expect(calls).toEqual([
      [h(g), 0],
      [h(a), 1],
    ]);
  });
});

describe('BlockTree: invalid blocks', () => {
  const err: BlockError = { code: 'bad-merkle-root' };

  it('a block failing the structure check is not stored, and a resubmission gets the same reason', () => {
    const g = blockOn(null);
    const { check, calls } = failing(new Map([[h(g), err]]));
    const t = new BlockTree(check);
    expect(t.add(g)).toEqual({ status: 'invalid', error: err });
    expect(t.size).toBe(0);
    expect(t.invalidReason(h(g))).toEqual(err);
    expect(t.add(g)).toEqual({ status: 'invalid', error: err });
    expect(calls.length).toBe(1); // not re-checked
  });

  it('a child of an invalid block is invalid-parent, without being checked', () => {
    const [g, a] = chainOn(null, 2);
    const { check, calls } = failing(new Map([[h(g), err]]));
    const t = new BlockTree(check);
    t.add(g);
    expect(t.add(a)).toEqual({ status: 'invalid', error: { code: 'invalid-parent' } });
    expect(calls.map(([x]) => x)).toEqual([h(g)]);
    expect(t.isOrphan(h(a))).toBe(false);
  });

  it('orphans waiting on a block that fails are dropped as invalid-parent, recursively', () => {
    const [g, a, b] = chainOn(null, 3);
    const t = new BlockTree(failing(new Map([[h(a), err]])).check);
    t.add(b);
    t.add(a);
    expect(hashes(t.add(g))).toEqual([h(g)]);
    expect(t.orphans()).toEqual([]);
    expect(t.invalidReason(h(a))).toEqual(err);
    expect(t.invalidReason(h(b))).toEqual({ code: 'invalid-parent' });
  });

  it('markInvalid removes the block and its whole subtree, and its parent becomes a tip again', () => {
    const t = new BlockTree(accept);
    const g = blockOn(null);
    const main = blockOn(g);
    const [s1, s2] = chainOn(g, 2);
    const s2b = blockOn(s1);
    const waiting = blockOn(blockOn(s2)); // orphan two levels below s2
    for (const x of [g, main, s1, s2, s2b, waiting]) t.add(x);
    expect(t.isOrphan(h(waiting))).toBe(true);

    t.markInvalid(h(s1), err);
    expect(t.entries().map((e) => e.hash)).toEqual([h(g), h(main)]);
    expect(t.childrenOf(h(g)).map((e) => e.hash)).toEqual([h(main)]);
    expect(t.tips().map((e) => e.hash)).toEqual([h(main)]);
    expect(t.invalidReason(h(s1))).toEqual(err);
    expect(t.invalidReason(h(s2))).toEqual({ code: 'invalid-parent' });
    expect(t.invalidReason(h(s2b))).toEqual({ code: 'invalid-parent' });
    expect(t.orphans()).toEqual([waiting]); // its parent was never seen, so it still just waits
    expect(t.add(s2)).toEqual({ status: 'invalid', error: { code: 'invalid-parent' } });

    t.markInvalid(h(main), err);
    expect(t.tips().map((e) => e.hash)).toEqual([h(g)]);
  });

  it('markInvalid on a block not in the tree throws', () => {
    const t = new BlockTree(accept);
    expect(() => t.markInvalid('00', err)).toThrow();
  });
});

describe('BlockTree: bestTip (fork choice)', () => {
  it('is the tip with the most cumulative work', () => {
    const t = new BlockTree(accept);
    const g = blockOn(null);
    const short = chainOn(g, 1);
    const long = chainOn(g, 3);
    for (const x of [g, ...short, ...long]) t.add(x);
    expect(t.bestTip()!.hash).toBe(h(long[2]));
  });

  it('compares work, not height: two hard blocks beat three easy ones', () => {
    const t = new BlockTree(accept);
    const g = blockOn(null);
    const easy = chainOn(g, 3, T8); // 3 × 256
    const hard = chainOn(g, 2, T9); // 2 × 512
    for (const x of [g, ...easy, hard[0]]) t.add(x);
    expect(t.bestTip()!.hash).toBe(h(easy[2]));
    t.add(hard[1]);
    expect(t.bestTip()!.hash).toBe(h(hard[1]));
    expect(t.bestTip()!.height).toBe(2);
  });

  it('on equal work the block that joined the tree first wins', () => {
    const t = new BlockTree(accept);
    const g = blockOn(null);
    const a = blockOn(g);
    const b = blockOn(g);
    t.add(g);
    t.add(b);
    t.add(a);
    expect(t.bestTip()!.hash).toBe(h(b));
  });
});
