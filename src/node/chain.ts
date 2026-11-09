/**
 * One node's view of the blockchain: a block tree holding every block it has
 * accepted, the main chain chosen from it by most cumulative work,
 * the UTXO set at the main chain's tip, and a mempool of transactions
 * waiting to be mined.
 *
 * The rules stay in core/validation; this class only decides what to do with a
 * transaction or block once the rules have judged it.
 *
 * A block is checked in two stages, as in Bitcoin Core:
 *   1. on arrival: header and structure (PoW, coinbase, Merkle root). Anything
 *      that passes is stored, on a side branch if need be.
 *   2. on connecting to the main chain: the spends, against the UTXO set after
 *      its parent. A side-branch block only reaches this if its branch takes
 *      over. If it fails, it and its descendants are discarded and the node
 *      settles on the best branch that is still valid.
 */
import {
  type Address,
  type Block,
  type BlockUndo,
  type StandardTx,
  type Transaction,
  type TxResult,
  UtxoSet,
  ZERO_HASH,
  assembleBlock,
  checkBlockStructure,
  checkHeader,
  describeBlockError,
  hexToBytes,
  isCoinbase,
  txidHex,
  validateBlock,
  validateTransaction,
} from '../core';
import { BlockTree, type InvalidReason, type TreeEntry } from './blocktree';

const TWO_256 = 1n << 256n;

/** How the main chain moved. Both lists are in chain order (lowest height first). */
export interface TipChange {
  /** Blocks that left the main chain; their length is the reorg depth (0 for a plain extension). */
  disconnected: Block[];
  connected: Block[];
}

export type SubmitBlockError = InvalidReason | { code: 'duplicate' };

/**
 * `status` says where the submitted block ended up: on the main chain, stored
 * as a stale block, or in the orphan pool. `tipChange` is null when the main
 * chain didn't move. A rejected block never moves the main chain.
 */
export type SubmitBlockResult =
  | { ok: true; status: 'main' | 'stale' | 'orphan'; tipChange: TipChange | null }
  | { ok: false; error: SubmitBlockError };

/** Read-only view of the tree, e.g. for the chain tree view. */
export type ReadonlyBlockTree = Pick<
  BlockTree,
  'size' | 'get' | 'has' | 'isOrphan' | 'invalidReason' | 'entries' | 'childrenOf' | 'tips' | 'orphans'
>;

export class Chain {
  private _target: bigint;
  private readonly _tree = new BlockTree((block, height) =>
    // The target was checked against the network's on arrival (checkHeader).
    checkBlockStructure(block, { height, target: block.header.target }),
  );
  /** Main chain, genesis first: main[h] is the entry at height h. */
  private readonly main: TreeEntry[] = [];
  /** Undo data for each main-chain block, keyed by block hash. */
  private readonly undo = new Map<string, BlockUndo>();
  /** Height of the main-chain block holding each confirmed tx, keyed by txid hex. */
  private readonly txHeight = new Map<string, number>();
  private utxos = new UtxoSet();
  /** Pending txs with the fee each pays, in the order they were accepted. */
  private pending: { tx: StandardTx; fee: number }[] = [];

  constructor(opts: { target: bigint }) {
    this._target = checkTarget(opts.target);
  }

  /** Difficulty for new blocks. Changing it doesn't affect blocks already stored. */
  get target(): bigint {
    return this._target;
  }

  set target(t: bigint) {
    this._target = checkTarget(t);
  }

  get height(): number {
    return this.main.length - 1;
  }

  get tipHash(): Uint8Array {
    const tip = this.main.at(-1);
    return tip ? hexToBytes(tip.hash) : ZERO_HASH;
  }

  /** The main chain's blocks, genesis first. */
  get blocks(): readonly Block[] {
    return this.main.map((e) => e.block);
  }

  /** Every stored block: the main chain, stale branches and the orphan pool. */
  get tree(): ReadonlyBlockTree {
    return this._tree;
  }

  get mempool(): readonly StandardTx[] {
    return this.pending.map((p) => p.tx);
  }

  isOnMainChain(hash: string): boolean {
    const e = this._tree.get(hash);
    return e !== undefined && this.main[e.height] === e;
  }

  /**
   * Number of main-chain blocks from this one to the tip, inclusive: 1 for the
   * tip, 6 once five more blocks are built on it (Bitcoin's usual "final").
   * 0 for a block off the main chain (stale, orphan or unknown).
   */
  confirmations(hash: string): number {
    return this.isOnMainChain(hash) ? this.height - this._tree.get(hash)!.height + 1 : 0;
  }

  /** Confirmations of the block that holds this tx on the main chain; 0 if it's only in the mempool, or unknown. */
  txConfirmations(txid: string): number {
    const h = this.txHeight.get(txid);
    return h === undefined ? 0 : this.height - h + 1;
  }

  confirmedUtxos(): UtxoSet {
    return this.utxos.clone();
  }

  /** Confirmed outputs plus mempool txs, so a wallet can spend its unconfirmed change. */
  spendableUtxos(): UtxoSet {
    const view = this.utxos.clone();
    view.applyTransactions(this.mempool);
    return view;
  }

  balanceOf(address: Address, opts: { includeMempool?: boolean } = {}): number {
    return (opts.includeMempool ? this.spendableUtxos() : this.utxos).balanceOf(address);
  }

  /**
   * Accept a tx into the mempool if it is valid on top of the confirmed set
   * plus the txs already pending. The first tx seen wins: a later tx spending
   * the same output is rejected as a double spend.
   */
  submitTransaction(tx: Transaction): TxResult {
    const result = validateTransaction(this.spendableUtxos(), tx);
    if (result.ok) this.pending.push({ tx: tx as StandardTx, fee: result.fee });
    return result;
  }

  /** Unmined candidate block on the main chain's tip: coinbase (subsidy + fees) followed by the whole mempool. */
  createBlockTemplate(minerAddress: Address, timestamp: number): Block {
    return assembleBlock({
      prevHash: this.tipHash,
      height: this.height + 1,
      timestamp,
      target: this._target,
      minerAddress,
      txs: this.mempool,
      fees: this.pending.reduce((sum, p) => sum + p.fee, 0),
    });
  }

  submitBlock(block: Block): SubmitBlockResult {
    // Header first, so a block without real PoW is never stored, not even as an orphan.
    const headerError = checkHeader(block.header, this._target);
    if (headerError) return { ok: false, error: headerError };

    const added = this._tree.add(block);
    if (added.status === 'duplicate') return { ok: false, error: { code: 'duplicate' } };
    if (added.status === 'invalid') return { ok: false, error: added.error };
    if (added.status === 'orphan') return { ok: true, status: 'orphan', tipChange: null };

    const oldTip = this.main.at(-1);
    this.activateBestChain();
    const hash = added.entries[0].hash;
    const invalid = this._tree.invalidReason(hash);
    if (invalid) return { ok: false, error: invalid };

    const tipChange = this.tipChangeSince(oldTip);
    if (tipChange) this.rebuildMempool(tipChange.disconnected);
    return { ok: true, status: this.isOnMainChain(hash) ? 'main' : 'stale', tipChange };
  }

  /**
   * Move the main chain to the best tip in the tree (fork choice), and repeat
   * until it is there. A reorg undoes blocks back to the common ancestor (the
   * last block both branches share), then applies the new branch one block at
   * a time with full validation. If a block fails, the tree drops it and its
   * descendants and the loop picks the best remaining tip, which may be the
   * old one. Each failure removes at least one block, so the loop ends.
   */
  private activateBestChain(): void {
    for (;;) {
      const best = this._tree.bestTip();
      const tip = this.main.at(-1);
      if (best === tip || !best) return;
      const fork = this.commonAncestor(tip, best);
      while (this.main.length - 1 > (fork?.height ?? -1)) this.disconnectTip();
      for (const entry of this.branch(fork, best)) {
        const result = validateBlock(entry.block, {
          utxos: this.utxos,
          parentHash: this.tipHash,
          height: this.height + 1,
          target: entry.block.header.target,
        });
        if (!result.ok) {
          this._tree.markInvalid(entry.hash, result.error);
          break;
        }
        this.connectTip(entry);
      }
    }
  }

  private connectTip(entry: TreeEntry): void {
    this.undo.set(entry.hash, this.utxos.applyBlock(entry.block));
    this.main.push(entry);
    for (const tx of entry.block.txs) this.txHeight.set(txidHex(tx), entry.height);
  }

  private disconnectTip(): void {
    const entry = this.main.pop()!;
    this.utxos.undoBlock(entry.block, this.undo.get(entry.hash)!);
    this.undo.delete(entry.hash);
    for (const tx of entry.block.txs) this.txHeight.delete(txidHex(tx));
  }

  /** Last entry on both branches, or undefined if they only share the (virtual) parent of genesis. */
  private commonAncestor(a: TreeEntry | undefined, b: TreeEntry | undefined): TreeEntry | undefined {
    while (a && b && a !== b) {
      if (a.height >= b.height) a = this.parentEntry(a);
      else b = this.parentEntry(b);
    }
    return a && b ? a : undefined;
  }

  /** Entries after `from` up to and including `to`, in chain order. `from` must be an ancestor of `to` (undefined = genesis's parent). */
  private branch(from: TreeEntry | undefined, to: TreeEntry | undefined): TreeEntry[] {
    const path: TreeEntry[] = [];
    for (let e = to; e && e !== from; e = this.parentEntry(e)) path.push(e);
    return path.reverse();
  }

  private parentEntry(e: TreeEntry): TreeEntry | undefined {
    return e.parent === null ? undefined : this._tree.get(e.parent);
  }

  private tipChangeSince(oldTip: TreeEntry | undefined): TipChange | null {
    const newTip = this.main.at(-1);
    if (newTip === oldTip) return null;
    const fork = this.commonAncestor(oldTip, newTip);
    return {
      disconnected: this.branch(fork, oldTip).map((e) => e.block),
      connected: this.branch(fork, newTip).map((e) => e.block),
    };
  }

  /**
   * After the main chain moves: the txs of disconnected blocks go back into
   * the mempool, ahead of the pending ones since they are older, and every
   * candidate is re-checked in order against the new UTXO set. A tx the new
   * chain already confirmed, or one that conflicts with it, now fails and is
   * dropped. That is how a double spend wins: the attacker's chain confirms a
   * conflicting tx, so the merchant's payment vanishes on the reorg.
   * Coinbase txs are dropped: their reward only exists on their own branch.
   */
  private rebuildMempool(disconnected: Block[]): void {
    const returned = disconnected.flatMap((b) => b.txs.filter((tx): tx is StandardTx => !isCoinbase(tx)));
    const candidates = [...returned, ...this.mempool];
    this.pending = [];
    for (const tx of candidates) this.submitTransaction(tx);
  }
}

export function describeSubmitBlockError(e: SubmitBlockError): string {
  switch (e.code) {
    case 'duplicate':
      return 'This node already has the block.';
    case 'invalid-parent':
      return 'The block builds on a block that is invalid.';
    default:
      return describeBlockError(e);
  }
}

function checkTarget(t: bigint): bigint {
  if (typeof t !== 'bigint' || t < 1n || t >= TWO_256) throw new RangeError('target must be in [1, 2^256)');
  return t;
}
