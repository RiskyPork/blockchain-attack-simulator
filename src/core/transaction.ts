/**
 * Transactions in the UTXO model
 *
 * There are no account balances. Coins exist only as unspent transaction
 * outputs (UTXOs). A transaction consumes whole earlier outputs (its inputs)
 * and creates new ones (its outputs):
 *
 *   input  = reference to an earlier output (txid, index) + proof the spender owns it
 *   output = (value, address)
 *   fee    = Σ input values − Σ output values, collected by the miner
 *
 * A coinbase transaction has no inputs. It is the first transaction in a block
 * and creates new coins (subsidy + fees) for the miner.
 */
import { base58CheckDecode } from './base58';
import { bytesToHex, sha256d } from './hash';
import { type Address, type KeyPair, publicKeyMatchesAddress, signDigest, verifyDigest } from './keys';

/** Values are integers in the smallest unit; 1 coin = 10^8 units, as with satoshis. */
export const COIN = 100_000_000;

const MAX_UINT32 = 0xffffffff;
const TXID_BYTES = 32;
const ADDRESS_PAYLOAD_BYTES = 21; // version byte + HASH160

/** Points at output number `index` of transaction `txid`. */
export interface OutPoint {
  txid: Uint8Array;
  index: number;
}

export interface TxInput {
  prevOut: OutPoint;
  /** Compressed public key of the owner of the spent output (witness). */
  publicKey: Uint8Array;
  /** ECDSA signature over txid(tx) (witness). */
  signature: Uint8Array;
}

export interface TxOutput {
  value: number;
  address: Address;
}

export interface StandardTx {
  kind: 'standard';
  inputs: TxInput[];
  outputs: TxOutput[];
}

/**
 * The block height makes every coinbase txid unique. Without it, two coinbases
 * paying the same miner the same amount would share a txid (Bitcoin BIP 30/34).
 */
export interface CoinbaseTx {
  kind: 'coinbase';
  height: number;
  outputs: TxOutput[];
}

export type Transaction = StandardTx | CoinbaseTx;

export function isCoinbase(tx: Transaction): tx is CoinbaseTx {
  return tx.kind === 'coinbase';
}

export function createCoinbase(height: number, address: Address, value: number): CoinbaseTx {
  return { kind: 'coinbase', height, outputs: [{ value, address }] };
}

// Serialization and txid

/** Appends fixed-width big-endian fields to a growing byte array. */
class ByteWriter {
  private parts: number[] = [];

  u8(n: number): void {
    this.parts.push(n & 0xff);
  }

  u32(n: number, what: string): void {
    if (!Number.isInteger(n) || n < 0 || n > MAX_UINT32) throw new Error(`${what} must be a uint32`);
    this.parts.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }

  u64(n: number, what: string): void {
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${what} must be a non-negative integer`);
    const big = BigInt(n);
    for (let shift = 56n; shift >= 0n; shift -= 8n) this.parts.push(Number((big >> shift) & 0xffn));
  }

  bytes(b: Uint8Array): void {
    for (const x of b) this.parts.push(x);
  }

  /** Length-prefixed (1 byte) so malformed witnesses still serialize unambiguously. */
  varBytes(b: Uint8Array, what: string): void {
    if (b.length > 0xff) throw new Error(`${what} too long`);
    this.u8(b.length);
    this.bytes(b);
  }

  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

/**
 * Deterministic byte encoding:
 *   kind(u8: 0 standard, 1 coinbase) || [coinbase: height(u32)]
 *   || nInputs(u32) || per input: txid(32) || index(u32) || [witness: len||pubkey || len||sig]
 *   || nOutputs(u32) || per output: value(u64) || version||HASH160 (21)
 *
 * `withWitness: false` leaves out public keys and signatures. That form is
 * hashed for the txid and is the message every input signs.
 */
export function serializeTx(tx: Transaction, { withWitness = true } = {}): Uint8Array {
  const w = new ByteWriter();
  if (isCoinbase(tx)) {
    w.u8(1);
    w.u32(tx.height, 'coinbase height');
    w.u32(0, 'input count');
  } else {
    w.u8(0);
    w.u32(tx.inputs.length, 'input count');
    for (const input of tx.inputs) {
      if (input.prevOut.txid.length !== TXID_BYTES) throw new Error('input txid must be 32 bytes');
      w.bytes(input.prevOut.txid);
      w.u32(input.prevOut.index, 'input index');
      if (withWitness) {
        w.varBytes(input.publicKey, 'public key');
        w.varBytes(input.signature, 'signature');
      }
    }
  }
  w.u32(tx.outputs.length, 'output count');
  for (const output of tx.outputs) {
    w.u64(output.value, 'output value');
    w.bytes(addressPayload(output.address));
  }
  return w.done();
}

/** Decoded addresses. Serializing a tx (to get its txid) decodes every output's address, and the same ones recur. */
const payloads = new Map<Address, Uint8Array>();

/** The address's version byte and HASH160. The writer copies it, so the cached array is never handed out to change. */
function addressPayload(address: Address): Uint8Array {
  const cached = payloads.get(address);
  if (cached) return cached;
  let payload: Uint8Array;
  try {
    payload = base58CheckDecode(address);
  } catch {
    throw new Error(`invalid address '${address}'`);
  }
  if (payload.length !== ADDRESS_PAYLOAD_BYTES) throw new Error(`invalid address '${address}'`);
  if (payloads.size >= 50_000) payloads.clear();
  payloads.set(address, payload);
  return payload;
}

/** txid = sha256d(transaction without witnesses). It is also the digest every input signs. */
export function txid(tx: Transaction): Uint8Array {
  return sha256d(serializeTx(tx, { withWitness: false }));
}

export function txidHex(tx: Transaction): string {
  return bytesToHex(txid(tx));
}

/** "txidhex:index": a string key for maps/sets of outpoints (UTXO set, double-spend checks). */
export function outPointKey(o: OutPoint): string {
  return `${bytesToHex(o.txid)}:${o.index}`;
}

export function totalOutputValue(tx: Transaction): number {
  return tx.outputs.reduce((sum, o) => sum + o.value, 0);
}

// Signing and signature checks

export interface Spend {
  prevOut: OutPoint;
  /** Key pair that owns the output being spent. */
  key: KeyPair;
}

/**
 * Build and sign a standard transaction. The txid ignores witnesses, so it is
 * computed from the unsigned transaction and each input then signs it.
 * Doesn't check that the spends exist or that values balance; validation does that.
 */
export function signTransaction(spends: readonly Spend[], outputs: readonly TxOutput[]): StandardTx {
  const unsigned: StandardTx = {
    kind: 'standard',
    inputs: spends.map((s) => ({ prevOut: s.prevOut, publicKey: s.key.publicKey, signature: new Uint8Array() })),
    outputs: outputs.map((o) => ({ ...o })),
  };
  const digest = txid(unsigned);
  return {
    ...unsigned,
    inputs: unsigned.inputs.map((input, i) => ({ ...input, signature: signDigest(digest, spends[i].key.privateKey) })),
  };
}

/** Why an input's ownership proof failed, or null if it is valid. */
export type InputAuthError = 'wrong-public-key' | 'bad-signature';

/**
 * Check that input `i` may spend `spentOutput`:
 *   1. HASH160(publicKey) matches the address the output is locked to, and
 *   2. the signature over txid(tx) verifies with that public key.
 * Looking up `spentOutput` in the UTXO set is the caller's job.
 */
export function checkInputAuthorization(tx: StandardTx, i: number, spentOutput: TxOutput): InputAuthError | null {
  const input = tx.inputs[i];
  if (!input) throw new RangeError(`no input ${i}`);
  if (!publicKeyMatchesAddress(input.publicKey, spentOutput.address)) return 'wrong-public-key';
  if (!verifyDigest(input.signature, txid(tx), input.publicKey)) return 'bad-signature';
  return null;
}
