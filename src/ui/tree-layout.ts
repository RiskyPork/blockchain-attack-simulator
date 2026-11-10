/**
 * Layout for the chain tree view: every block that any node stores, placed on
 * a grid with one column per height and one row per branch.
 *
 * Each node has its own block tree (node/blocktree.ts), and during a fork
 * they disagree, so the view merges them all and labels each block from one
 * node's point of view (the "viewpoint"):
 *
 *   main   on the viewpoint node's main chain.
 *   other  not on the viewpoint's main chain, but on some other node's. Either
 *          it hasn't reached the viewpoint yet, or it is the other side of a
 *          fork that hasn't been settled.
 *   stale  on no node's main chain: it lost a fork race. Nodes keep it in
 *          case its branch overtakes, but nobody builds on it and its miner's
 *          reward is worthless.
 *
 * A main-chain block is final once it has FINAL_CONFIRMATIONS confirmations,
 * Bitcoin's usual rule of thumb: an attacker with less than half the hash
 * power would rarely catch up from 6 blocks behind.
 *
 * Rows: the tree is split into paths. A path follows each block's preferred
 * child (the next main-chain block, else the child most nodes follow, else the
 * deepest), and every other child starts a new path. The path through genesis
 * takes row 0, so the main chain is a straight line along the top. Each
 * other path, in order of the height it starts at, takes the first row below
 * that is free over its heights, with one empty column on either side so two
 * unrelated branches never look joined. Old forks that ended long ago leave
 * their row free for new ones, so the view stays a few rows tall.
 *
 * Pure data in, pure data out: no DOM, so it is unit-tested.
 */
import type { NodeId } from '../network';
import type { Chain } from '../node';
import { bytesToHex } from '../core';

export const FINAL_CONFIRMATIONS = 6;

export type BlockStatus = 'main' | 'other' | 'stale';

/** One block in the union of every node's tree. */
export interface UnionBlock {
  hash: string;
  /** null for genesis. */
  parent: string | null;
  height: number;
  /** Nodes that store it, on their main chain or a side branch. */
  heldBy: NodeId[];
  /** Nodes whose main chain includes it. */
  mainFor: NodeId[];
}

export interface TreeSnapshot {
  /** Parents always come before their children. */
  blocks: UnionBlock[];
  /** Each node's main-chain tip. */
  tips: Map<NodeId, string>;
}

export interface PlacedBlock extends UnionBlock {
  row: number;
  status: BlockStatus;
  /** Confirmations on the viewpoint's main chain: 1 for its tip, 0 off it. */
  confirmations: number;
  final: boolean;
  /** Nodes whose tip this is. */
  tipOf: NodeId[];
}

export interface TreeLayout {
  /** In snapshot order, so parents come before children. */
  blocks: PlacedBlock[];
  byHash: Map<string, PlacedBlock>;
  /** Height of the viewpoint's tip, or -1 if the viewpoint isn't a node. */
  mainHeight: number;
  maxHeight: number;
  stale: number;
}

/** Merge every node's block tree into one list, recording who stores each block and whose main chain it is on. */
export function snapshotChains(nodes: readonly { id: NodeId; chain: Chain }[]): TreeSnapshot {
  const byHash = new Map<string, UnionBlock>();
  const tips = new Map<NodeId, string>();
  for (const { id, chain } of nodes) {
    // A tree lists a block only after its parent, and the parent is in the
    // same tree, so appending each node's new blocks keeps parents first.
    for (const e of chain.tree.entries()) {
      let b = byHash.get(e.hash);
      if (!b) {
        b = { hash: e.hash, parent: e.parent, height: e.height, heldBy: [], mainFor: [] };
        byHash.set(e.hash, b);
      }
      b.heldBy.push(id);
      if (chain.isOnMainChain(e.hash)) b.mainFor.push(id);
    }
    if (chain.height >= 0) tips.set(id, bytesToHex(chain.tipHash));
  }
  return { blocks: [...byHash.values()], tips };
}

export function layoutTree(snapshot: TreeSnapshot, viewpoint: NodeId): TreeLayout {
  const { blocks, tips } = snapshot;
  const index = new Map(blocks.map((b, i) => [b.hash, i]));
  const viewTip = tips.get(viewpoint);
  const mainHeight = viewTip !== undefined && index.has(viewTip) ? blocks[index.get(viewTip)!].height : -1;

  const tipOf = new Map<string, NodeId[]>();
  for (const [id, hash] of tips) tipOf.set(hash, [...(tipOf.get(hash) ?? []), id]);

  const placed: PlacedBlock[] = blocks.map((b) => {
    const status: BlockStatus = b.mainFor.includes(viewpoint) ? 'main' : b.mainFor.length > 0 ? 'other' : 'stale';
    const confirmations = status === 'main' ? mainHeight - b.height + 1 : 0;
    return { ...b, row: 0, status, confirmations, final: confirmations >= FINAL_CONFIRMATIONS, tipOf: tipOf.get(b.hash) ?? [] };
  });

  // Children of each block, and the greatest height reachable below it.
  // Children come later in the list than parents, so one backwards pass works.
  const children = new Map<number, number[]>();
  const deepest = placed.map((b) => b.height);
  const parentIndex = placed.map((b) => (b.parent === null ? undefined : index.get(b.parent)));
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = parentIndex[i];
    if (p === undefined) continue;
    children.set(p, [i, ...(children.get(p) ?? [])]);
    deepest[p] = Math.max(deepest[p], deepest[i]);
  }

  const statusRank = { main: 0, other: 1, stale: 2 };
  const preferred = (a: number, b: number) =>
    statusRank[placed[a].status] - statusRank[placed[b].status] ||
    placed[b].mainFor.length - placed[a].mainFor.length ||
    deepest[b] - deepest[a] ||
    a - b;

  // Split the tree into paths. Roots are genesis (and, defensively, any block
  // whose parent no node has).
  const paths: number[][] = [];
  const starts = placed.map((_, i) => i).filter((i) => parentIndex[i] === undefined);
  while (starts.length > 0) {
    const path: number[] = [];
    for (let i: number | undefined = starts.shift(); i !== undefined; ) {
      path.push(i);
      const kids = [...(children.get(i) ?? [])].sort(preferred);
      starts.push(...kids.slice(1));
      i = kids[0];
    }
    paths.push(path);
  }

  // Row 0 for the first root's path; the rest greedily, by starting height.
  const [trunk, ...branches] = paths;
  const rowEnd: number[] = [Number.POSITIVE_INFINITY];
  for (const i of trunk ?? []) placed[i].row = 0;
  branches.sort((a, b) => placed[a[0]].height - placed[b[0]].height || a[0] - b[0]);
  for (const path of branches) {
    const start = placed[path[0]].height;
    const end = placed[path.at(-1)!].height;
    let row = 1;
    while (row < rowEnd.length && rowEnd[row] >= start - 1) row++;
    rowEnd[row] = end;
    for (const i of path) placed[i].row = row;
  }

  return {
    blocks: placed,
    byHash: new Map(placed.map((b) => [b.hash, b])),
    mainHeight,
    maxHeight: placed.reduce((m, b) => Math.max(m, b.height), -1),
    stale: placed.filter((b) => b.status === 'stale').length,
  };
}
