/**
 * Block tree (S2-2): every block a node has accepted, including stale ones,
 * plus an orphan pool.
 *
 * With network delay, two miners can find a block on the same parent before
 * either hears about the other's, so the chain forks. A node keeps every
 * branch, because the branch with less work today may overtake tomorrow.
 * Lec05 separates two kinds of off-chain block, which are easy to mix up:
 *
 *   stale block   valid, parent known, but not on the main chain: it lost a
 *                 fork race and its miner earns nothing. It stays in the tree.
 *   orphan block  this node doesn't know its parent yet (blocks can arrive
 *                 out of order), so it can't be placed in the tree. It waits in
 *                 the orphan pool and is connected when the parent arrives.
 *
 * (Many sources loosely call stale blocks "orphans"; this code follows Lec05.)
 *
 * The tree only tracks structure and cumulative work. Which branch is the main
 * chain, and full validation of a block's spends, are Chain's job (S2-3).
 */
import { type Block, type BlockError, ZERO_HASH, blockHashHex, blockWork, bytesToHex } from '../core';

/** A block placed in the tree. Hashes are hex strings so they can key maps. */
export interface TreeEntry {
  readonly block: Block;
  readonly hash: string;
  /** Parent's hash, or null for a genesis block (prevHash = ZERO_HASH). */
  readonly parent: string | null;
  readonly height: number;
  /**
   * Σ blockWork(target) from genesis to this block: the expected number of
   * hashes it took to build this branch. Fork choice compares this, not height.
   */
  readonly chainWork: bigint;
  /** Order the block joined the tree. Breaks fork-choice ties: first seen wins. */
  readonly seq: number;
}

/** Why a block is known to be invalid. A block whose ancestor is invalid is invalid too. */
export type InvalidReason = BlockError | { code: 'invalid-parent' };

export type AddResult =
  | { status: 'duplicate' }
  | { status: 'invalid'; error: InvalidReason }
  | { status: 'orphan' }
  /** The block, then any orphans it let connect, every parent before its children. */
  | { status: 'added'; entries: TreeEntry[] };

/**
 * Rules a block must pass before it is stored, given the height its parent
 * puts it at. Chain passes checkBlockStructure; tests can pass a stub.
 */
export type StructureCheck = (block: Block, height: number) => BlockError | null;

const GENESIS_PARENT = bytesToHex(ZERO_HASH);

export class BlockTree {
  private readonly nodes = new Map<string, TreeEntry>();
  private readonly children = new Map<string, string[]>();
  /** Entries with no children. The most-work entry is always one of these, since work only grows along a branch. */
  private readonly leaves = new Set<string>();
  private readonly orphanPool = new Map<string, Block>();
  /** Orphan hashes keyed by the parent hash they're waiting for. */
  private readonly waiting = new Map<string, string[]>();
  /** Known-invalid blocks, so a resubmission is rejected with the same reason without re-checking. */
  private readonly invalid = new Map<string, InvalidReason>();
  private nextSeq = 0;

  constructor(private readonly check: StructureCheck) {}

  get size(): number {
    return this.nodes.size;
  }

  get(hash: string): TreeEntry | undefined {
    return this.nodes.get(hash);
  }

  has(hash: string): boolean {
    return this.nodes.has(hash);
  }

  isOrphan(hash: string): boolean {
    return this.orphanPool.has(hash);
  }

  invalidReason(hash: string): InvalidReason | undefined {
    return this.invalid.get(hash);
  }

  /** Every entry, in the order they joined the tree. */
  entries(): TreeEntry[] {
    return [...this.nodes.values()];
  }

  childrenOf(hash: string): TreeEntry[] {
    return (this.children.get(hash) ?? []).map((h) => this.nodes.get(h)!);
  }

  /** Tips of every branch: the main chain's tip plus the tip of each stale branch. */
  tips(): TreeEntry[] {
    return [...this.leaves].map((h) => this.nodes.get(h)!);
  }

  /** Blocks waiting for their parent, in arrival order. */
  orphans(): Block[] {
    return [...this.orphanPool.values()];
  }

  /**
   * Fork choice (Nakamoto consensus, Lec05): the tip with the most cumulative
   * work. Height alone is wrong once difficulty varies, since a short chain of
   * hard blocks can hold more work than a long chain of easy ones. On a tie
   * the block seen first wins, as in Bitcoin Core, so a node doesn't flip
   * between equal branches; selfish mining (S3-4) depends on this rule.
   */
  bestTip(): TreeEntry | undefined {
    let best: TreeEntry | undefined;
    for (const hash of this.leaves) {
      const e = this.nodes.get(hash)!;
      if (!best || e.chainWork > best.chainWork || (e.chainWork === best.chainWork && e.seq < best.seq)) best = e;
    }
    return best;
  }

  /**
   * Store a block. Its header must already be well-formed (checkHeader passed).
   * If its parent is unknown it goes to the orphan pool; otherwise it is
   * structure-checked at its height, placed, and any orphans waiting on it
   * are connected in turn.
   */
  add(block: Block): AddResult {
    const hash = blockHashHex(block.header);
    if (this.nodes.has(hash) || this.orphanPool.has(hash)) return { status: 'duplicate' };
    const known = this.invalid.get(hash);
    if (known) return { status: 'invalid', error: known };

    const parent = parentOf(block);
    if (parent !== null && this.invalid.has(parent)) return this.reject(hash, { code: 'invalid-parent' });
    if (parent !== null && !this.nodes.has(parent)) {
      this.orphanPool.set(hash, block);
      this.waiting.set(parent, [...(this.waiting.get(parent) ?? []), hash]);
      return { status: 'orphan' };
    }

    const entry = this.place(block, hash);
    if ('error' in entry) return { status: 'invalid', error: entry.error };
    return { status: 'added', entries: [entry, ...this.connectOrphans(hash)] };
  }

  /**
   * Record that a stored block failed full validation: remove it and all its
   * descendants (including orphans waiting on any of them) and remember why.
   * Never called on a main-chain block, so the main chain is untouched.
   */
  markInvalid(hash: string, error: BlockError): void {
    const entry = this.nodes.get(hash);
    if (!entry) throw new Error(`block ${hash} is not in the tree`);
    if (entry.parent !== null) {
      const siblings = this.children.get(entry.parent)!.filter((h) => h !== hash);
      if (siblings.length > 0) this.children.set(entry.parent, siblings);
      else {
        this.children.delete(entry.parent);
        this.leaves.add(entry.parent);
      }
    }
    const stack: [string, InvalidReason][] = [[hash, error]];
    while (stack.length > 0) {
      const [h, reason] = stack.pop()!;
      this.invalid.set(h, reason);
      this.nodes.delete(h);
      this.leaves.delete(h);
      for (const child of this.children.get(h) ?? []) stack.push([child, { code: 'invalid-parent' }]);
      this.children.delete(h);
      this.dropOrphansOf(h);
    }
  }

  /** Structure-check a block whose parent is in the tree (or is genesis) and add it. */
  private place(block: Block, hash: string): TreeEntry | { error: InvalidReason } {
    const parentHash = parentOf(block);
    const parent = parentHash === null ? undefined : this.nodes.get(parentHash)!;
    const height = parent ? parent.height + 1 : 0;
    const error = this.check(block, height);
    if (error) {
      this.reject(hash, error);
      return { error };
    }
    const entry: TreeEntry = {
      block,
      hash,
      parent: parentHash,
      height,
      chainWork: (parent?.chainWork ?? 0n) + blockWork(block.header.target),
      seq: this.nextSeq++,
    };
    this.nodes.set(hash, entry);
    this.leaves.add(hash);
    if (parentHash !== null) {
      this.children.set(parentHash, [...(this.children.get(parentHash) ?? []), hash]);
      this.leaves.delete(parentHash);
    }
    return entry;
  }

  /** Breadth-first: connect the orphans waiting on `hash`, then the ones waiting on those, and so on. */
  private connectOrphans(hash: string): TreeEntry[] {
    const connected: TreeEntry[] = [];
    const queue = [hash];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      for (const orphanHash of this.takeWaiting(parent)) {
        const entry = this.place(this.orphanPool.get(orphanHash)!, orphanHash);
        this.orphanPool.delete(orphanHash);
        if ('error' in entry) continue; // place() already dropped the orphans waiting on it
        connected.push(entry);
        queue.push(orphanHash);
      }
    }
    return connected;
  }

  private reject(hash: string, error: InvalidReason): { status: 'invalid'; error: InvalidReason } {
    this.invalid.set(hash, error);
    this.dropOrphansOf(hash);
    return { status: 'invalid', error };
  }

  /** The orphans waiting on an invalid block can never connect: mark them, and their own waiters, invalid. */
  private dropOrphansOf(hash: string): void {
    const stack = this.takeWaiting(hash);
    while (stack.length > 0) {
      const h = stack.pop()!;
      this.orphanPool.delete(h);
      this.invalid.set(h, { code: 'invalid-parent' });
      stack.push(...this.takeWaiting(h));
    }
  }

  private takeWaiting(parent: string): string[] {
    const hashes = this.waiting.get(parent) ?? [];
    this.waiting.delete(parent);
    return hashes;
  }
}

function parentOf(block: Block): string | null {
  const parent = bytesToHex(block.header.prevHash);
  return parent === GENESIS_PARENT ? null : parent;
}
