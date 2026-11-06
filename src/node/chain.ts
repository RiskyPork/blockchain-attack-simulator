/**
 * One node's view of the blockchain (Sprint 1): a single main chain, its UTXO
 * set and a mempool of transactions waiting to be mined.
 *
 * Sprint 2 replaces the single chain with a block tree plus fork choice. The
 * rules stay in core/validation; this class only decides what to do with a
 * transaction or block once the rules have judged it.
 */
import {
  type Address,
  type Block,
  type BlockResult,
  type StandardTx,
  type Transaction,
  type TxResult,
  UtxoSet,
  ZERO_HASH,
  assembleBlock,
  blockHash,
  txidHex,
  validateBlock,
  validateTransaction,
} from '../core';

const TWO_256 = 1n << 256n;

export class Chain {
  private _target: bigint;
  private readonly _blocks: Block[] = [];
  private utxos = new UtxoSet();
  /** Pending txs with the fee each pays, in the order they were accepted. */
  private pending: { tx: StandardTx; fee: number }[] = [];

  constructor(opts: { target: bigint }) {
    this._target = checkTarget(opts.target);
  }

  /** Difficulty for the next blocks. Changing it doesn't affect blocks already in the chain. */
  get target(): bigint {
    return this._target;
  }

  set target(t: bigint) {
    this._target = checkTarget(t);
  }

  get height(): number {
    return this._blocks.length - 1;
  }

  get tipHash(): Uint8Array {
    const tip = this._blocks.at(-1);
    return tip ? blockHash(tip.header) : ZERO_HASH;
  }

  get blocks(): readonly Block[] {
    return [...this._blocks];
  }

  get mempool(): readonly StandardTx[] {
    return this.pending.map((p) => p.tx);
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

  /** Unmined candidate block: coinbase (subsidy + fees) followed by the whole mempool. */
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

  submitBlock(block: Block): BlockResult {
    const result = validateBlock(block, {
      utxos: this.utxos,
      parentHash: this.tipHash,
      height: this.height + 1,
      target: this._target,
    });
    if (!result.ok) return result;

    this.utxos.applyBlock(block);
    this._blocks.push(block);
    this.rebuildMempool(new Set(block.txs.map(txidHex)));
    return result;
  }

  /**
   * After a new block: drop the txs it confirmed, then re-check the rest in
   * order. Any that now conflict with the block (their inputs are gone) are dropped.
   */
  private rebuildMempool(confirmed: Set<string>): void {
    const remaining = this.pending.filter((p) => !confirmed.has(txidHex(p.tx)));
    this.pending = [];
    for (const { tx } of remaining) this.submitTransaction(tx);
  }
}

function checkTarget(t: bigint): bigint {
  if (typeof t !== 'bigint' || t < 1n || t >= TWO_256) throw new RangeError('target must be in [1, 2^256)');
  return t;
}
