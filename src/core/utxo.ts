/**
 * The UTXO set: every transaction output that has not been spent yet.
 *
 * This is all a node needs to know who owns what. A balance is the sum of the
 * UTXOs locked to an address, and a transaction can only spend outputs in this
 * set, which is what stops double spending.
 *
 * applyBlock / undoBlock are exact inverses. When a node switches to a heavier
 * fork, it undoes blocks back to the common ancestor and
 * applies the new branch. Undoing needs the outputs the block spent, which the
 * block itself doesn't contain, so applyBlock returns them as undo data
 *
 * Only outpoint bookkeeping happens here. Signatures, values, PoW and the
 * Merkle root are checked by validation before a block is applied.
 */
import type { Block } from './block';
import type { Address } from './keys';
import { type OutPoint, type Transaction, type TxOutput, isCoinbase, outPointKey, totalOutputValue, txid } from './transaction';

export interface Utxo {
  outPoint: OutPoint;
  output: TxOutput;
}

/** The outputs a block removed from the set, so it can be undone. */
export interface BlockUndo {
  spent: Utxo[];
}

/** One change to the set, recorded so a failed apply/undo can be rolled back. */
type Change = { op: 'add' | 'remove'; key: string; utxo: Utxo };

export class UtxoSet {
  /** Keyed by outPointKey ("txidhex:index") so lookups compare by value, not by array identity. */
  private readonly map = new Map<string, Utxo>();

  get size(): number {
    return this.map.size;
  }

  has(o: OutPoint): boolean {
    return this.map.has(outPointKey(o));
  }

  get(o: OutPoint): TxOutput | undefined {
    return this.map.get(outPointKey(o))?.output;
  }

  all(): Utxo[] {
    return [...this.map.values()];
  }

  utxosOf(address: Address): Utxo[] {
    return this.all().filter((u) => u.output.address === address);
  }

  balanceOf(address: Address): number {
    return this.utxosOf(address).reduce((sum, u) => sum + u.output.value, 0);
  }

  clone(): UtxoSet {
    const copy = new UtxoSet();
    for (const [key, utxo] of this.map) copy.map.set(key, utxo);
    return copy;
  }

  /**
   * Spend every input and add every output, tx by tx in block order, so a tx
   * may spend an output created earlier in the same block. All or nothing:
   * on error the set is left unchanged.
   */
  applyBlock(block: Block): BlockUndo {
    const spent: Utxo[] = [];
    this.transact((change) => {
      for (const tx of block.txs) {
        for (const input of inputsOf(tx)) {
          spent.push(change.remove(input, 'input spends a missing or already-spent output'));
        }
        const id = txid(tx);
        tx.outputs.forEach((output, index) => change.add({ outPoint: { txid: id, index }, output }));
      }
    });
    return { spent };
  }

  /**
   * Reverse of applyBlock. Walks the txs backwards: removes each tx's outputs
   * and then restores what it spent. The order matters when a later tx spent
   * an earlier tx's output in the same block.
   */
  undoBlock(block: Block, undo: BlockUndo): void {
    this.transact((change) => {
      let s = undo.spent.length;
      for (let t = block.txs.length - 1; t >= 0; t--) {
        const tx = block.txs[t];
        const id = txid(tx);
        for (let index = tx.outputs.length - 1; index >= 0; index--) {
          change.remove({ txid: id, index }, 'block being undone is not the last block applied');
        }
        const inputs = inputsOf(tx);
        for (let i = inputs.length - 1; i >= 0; i--) {
          const restored = undo.spent[--s];
          if (!restored || outPointKey(restored.outPoint) !== outPointKey(inputs[i])) {
            throw new Error('undo data does not match block');
          }
          change.add(restored);
        }
      }
      if (s !== 0) throw new Error('undo data does not match block');
    });
  }

  /** Run `body`; if it throws, revert every change it made, then rethrow. */
  private transact(body: (change: { add(u: Utxo): void; remove(o: OutPoint, err: string): Utxo }) => void): void {
    const log: Change[] = [];
    const change = {
      add: (utxo: Utxo) => {
        const key = outPointKey(utxo.outPoint);
        if (this.map.has(key)) throw new Error(`output ${key} already exists`);
        this.map.set(key, utxo);
        log.push({ op: 'add', key, utxo });
      },
      remove: (o: OutPoint, err: string): Utxo => {
        const key = outPointKey(o);
        const utxo = this.map.get(key);
        if (!utxo) throw new Error(`${err}: ${key}`);
        this.map.delete(key);
        log.push({ op: 'remove', key, utxo });
        return utxo;
      },
    };
    try {
      body(change);
    } catch (e) {
      for (let i = log.length - 1; i >= 0; i--) {
        const c = log[i];
        if (c.op === 'add') this.map.delete(c.key);
        else this.map.set(c.key, c.utxo);
      }
      throw e;
    }
  }
}

function inputsOf(tx: Transaction): OutPoint[] {
  return isCoinbase(tx) ? [] : tx.inputs.map((i) => i.prevOut);
}

/** Σ inputs − Σ outputs. Coinbase → 0. May be negative; validation rejects that. */
export function txFee(set: UtxoSet, tx: Transaction): number {
  if (isCoinbase(tx)) return 0;
  let inputTotal = 0;
  for (const input of tx.inputs) {
    const out = set.get(input.prevOut);
    if (!out) throw new Error(`input spends missing output ${outPointKey(input.prevOut)}`);
    inputTotal += out.value;
  }
  return inputTotal - totalOutputValue(tx);
}
