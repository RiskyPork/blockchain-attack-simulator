import { describe, expect, it } from 'vitest';
import type { NodeId } from '../network';
import { Playground } from './playground';
import { FINAL_CONFIRMATIONS, type TreeSnapshot, type UnionBlock, layoutTree, snapshotChains } from './tree-layout';

// ---------------------------------------------------------------------------
// Hand-built trees: block "h<height><branch>", e.g. "3a"
// ---------------------------------------------------------------------------

interface Spec {
  /** [hash, parent] pairs, parents first. Height is worked out from the parent. */
  blocks: [string, string | null][];
  /** Each node's main chain, as its tip: the chain is the tip and its ancestors. */
  tips: Record<NodeId, string>;
}

function snapshot(spec: Spec): TreeSnapshot {
  const parent = new Map(spec.blocks);
  const height = new Map<string, number>();
  for (const [h, p] of spec.blocks) height.set(h, p === null ? 0 : height.get(p)! + 1);
  const mainFor = new Map<string, NodeId[]>();
  for (const [id, tip] of Object.entries(spec.tips)) {
    for (let h: string | null | undefined = tip; h; h = parent.get(h)) mainFor.set(h, [...(mainFor.get(h) ?? []), Number(id)]);
  }
  const ids = Object.keys(spec.tips).map(Number);
  const blocks: UnionBlock[] = spec.blocks.map(([hash, p]) => ({
    hash, parent: p, height: height.get(hash)!, heldBy: ids, mainFor: mainFor.get(hash) ?? [],
  }));
  return { blocks, tips: new Map(Object.entries(spec.tips).map(([id, t]) => [Number(id), t])) };
}

/** A straight chain g, 1, 2, ... n (hashes are the heights). */
const linear = (n: number): [string, string | null][] =>
  Array.from({ length: n + 1 }, (_, h) => [h === 0 ? 'g' : String(h), h === 0 ? null : h === 1 ? 'g' : String(h - 1)]);

const rows = (layout: ReturnType<typeof layoutTree>) => Object.fromEntries(layout.blocks.map((b) => [b.hash, b.row]));

describe('Chain tree layout', () => {
  it('a single chain: one row, confirmations counted from the tip, final at 6', () => {
    const layout = layoutTree(snapshot({ blocks: linear(9), tips: { 0: '9' } }), 0);
    expect(layout.mainHeight).toBe(9);
    expect(layout.maxHeight).toBe(9);
    expect(layout.stale).toBe(0);
    for (const b of layout.blocks) {
      expect(b.row).toBe(0);
      expect(b.status).toBe('main');
      expect(b.confirmations).toBe(9 - b.height + 1);
      expect(b.final).toBe(b.confirmations >= FINAL_CONFIRMATIONS);
    }
    // Height 4 has exactly 6 confirmations: the first final block. Height 5 has 5.
    expect(layout.byHash.get('4')!.final).toBe(true);
    expect(layout.byHash.get('5')!.final).toBe(false);
    expect(layout.byHash.get('9')!.tipOf).toEqual([0]);
  });

  it('a fork the nodes disagree on: the viewpoint decides which side is main', () => {
    const spec: Spec = {
      blocks: [['g', null], ['1', 'g'], ['2a', '1'], ['2b', '1'], ['3a', '2a']],
      tips: { 0: '3a', 1: '2b', 2: '3a' },
    };
    const from0 = layoutTree(snapshot(spec), 0);
    expect(rows(from0)).toEqual({ g: 0, 1: 0, '2a': 0, '3a': 0, '2b': 1 });
    expect(from0.byHash.get('2b')).toMatchObject({ status: 'other', confirmations: 0, tipOf: [1] });
    expect(from0.byHash.get('3a')!.tipOf).toEqual([0, 2]);

    const from1 = layoutTree(snapshot(spec), 1);
    expect(rows(from1)).toEqual({ g: 0, 1: 0, '2b': 0, '2a': 1, '3a': 1 });
    expect(from1.mainHeight).toBe(2);
    expect(from1.byHash.get('3a')).toMatchObject({ status: 'other', confirmations: 0 });
    expect(from1.byHash.get('2b')).toMatchObject({ status: 'main', confirmations: 1 });
  });

  it('a block on no main chain is stale', () => {
    const layout = layoutTree(snapshot({ blocks: [...linear(3), ['2x', '1']], tips: { 0: '3', 1: '3' } }), 0);
    expect(layout.byHash.get('2x')).toMatchObject({ status: 'stale', row: 1, tipOf: [] });
    expect(layout.stale).toBe(1);
  });

  it('blocks beyond the viewpoint tip that it has not received yet stay on row 0', () => {
    // Node 0 is behind: it hasn't got 4 and 5 yet, which node 1 has on its main chain.
    const layout = layoutTree(snapshot({ blocks: linear(5), tips: { 0: '3', 1: '5' } }), 0);
    expect(layout.blocks.every((b) => b.row === 0)).toBe(true);
    expect(layout.byHash.get('4')!.status).toBe('other');
    expect(layout.byHash.get('3')).toMatchObject({ status: 'main', confirmations: 1, tipOf: [0] });
  });

  it('packs forks into as few rows as possible, never letting two branches touch', () => {
    const spec: Spec = {
      blocks: [
        ...linear(20),
        ['2x', '1'], ['3x', '2x'], ['4x', '3x'], // heights 2–4
        ['4y', '3'], // overlaps x: a new row
        ['5z', '4'], // right next to x and y, which end at 4: touching them would look joined
        ['6w', '5'], // leaves an empty column after x, so it can share x's row
        ['15v', '14'], // long after everything
      ],
      tips: { 0: '20' },
    };
    const r = rows(layoutTree(snapshot(spec), 0));
    expect([r['2x'], r['3x'], r['4x']]).toEqual([1, 1, 1]);
    expect(r['4y']).toBe(2);
    expect(r['5z']).toBe(3);
    expect(r['6w']).toBe(1);
    expect(r['15v']).toBe(1);
  });

  it('a fork of a fork gets its own row', () => {
    const spec: Spec = {
      blocks: [...linear(6), ['2x', '1'], ['3x', '2x'], ['4x', '3x'], ['4xx', '3x'], ['5xx', '4xx']],
      tips: { 0: '6' },
    };
    const r = rows(layoutTree(snapshot(spec), 0));
    // The deeper child continues the branch's row.
    expect([r['2x'], r['3x'], r['4xx'], r['5xx']]).toEqual([1, 1, 1, 1]);
    expect(r['4x']).toBe(2);
  });

  it('a viewpoint that is not a node marks nothing as main', () => {
    const layout = layoutTree(snapshot({ blocks: linear(3), tips: { 0: '3' } }), 42);
    expect(layout.mainHeight).toBe(-1);
    expect(layout.blocks.every((b) => b.status === 'other' && b.row === 0 && !b.final)).toBe(true);
  });

  it('an empty snapshot lays out nothing', () => {
    expect(layoutTree({ blocks: [], tips: new Map() }, 0)).toMatchObject({ blocks: [], mainHeight: -1, maxHeight: -1, stale: 0 });
  });
});

// ---------------------------------------------------------------------------
// Real chains from a forking network
// ---------------------------------------------------------------------------

describe('Chain tree from real nodes', () => {
  const pg = new Playground({ seed: 3, latency: 250, jitter: 100 });
  pg.advance(600 * 80);
  const nodes = pg.ring.map((id) => ({ id, chain: pg.chain(id) }));
  const snap = snapshotChains(nodes);

  it('merges every node tree: each block once, with who stores it and whose main chain has it', () => {
    const all = new Set(nodes.flatMap(({ chain }) => chain.tree.entries().map((e) => e.hash)));
    expect(snap.blocks.map((b) => b.hash).sort()).toEqual([...all].sort());
    for (const b of snap.blocks) {
      expect(b.heldBy).toEqual(nodes.filter(({ chain }) => chain.tree.has(b.hash)).map((n) => n.id));
      expect(b.mainFor).toEqual(nodes.filter(({ chain }) => chain.isOnMainChain(b.hash)).map((n) => n.id));
    }
    const seen = new Set<string>();
    for (const b of snap.blocks) {
      if (b.parent !== null) expect(seen.has(b.parent)).toBe(true);
      seen.add(b.hash);
    }
  });

  it('places blocks consistently with what each node holds', () => {
    expect(pg.reorgs.count).toBeGreaterThan(0); // the run really forked
    for (const { id: viewpoint, chain } of nodes) {
      const layout = layoutTree(snap, viewpoint);
      expect(layout.mainHeight).toBe(chain.height);
      expect(layout.stale).toBeGreaterThan(0);

      const cells = new Set<string>();
      for (const b of layout.blocks) {
        const cell = `${b.height}/${b.row}`;
        expect(cells.has(cell)).toBe(false);
        cells.add(cell);

        expect(b.confirmations).toBe(chain.confirmations(b.hash));
        expect(b.status === 'main').toBe(chain.isOnMainChain(b.hash));
        expect(b.status === 'stale').toBe(b.mainFor.length === 0);
        if (b.status === 'main') expect(b.row).toBe(0);
        if (b.row === 0 && b.status !== 'main') expect(b.height).toBeGreaterThan(chain.height);
        if (b.parent !== null) expect(layout.byHash.get(b.parent)!.height).toBe(b.height - 1);
      }
      for (const n of nodes) expect(layout.byHash.get(snap.tips.get(n.id)!)!.tipOf).toContain(n.id);
    }
  });
});
