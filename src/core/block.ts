/**
 * Block header, its serialization and hash, and difficulty targets.
 *
 * The header commits to the whole block:
 *   prevHash    links to the parent, forming the chain
 *   merkleRoot  commits to every transaction
 *   timestamp   when the block was mined (simulated ms)
 *   target      PoW threshold: valid iff sha256d(header) <= target
 *   nonce       the value the miner varies to search for a valid hash
 *
 * Simplification vs. Bitcoin: all fields are serialized big-endian, hashes are
 * displayed in that same order (Bitcoin reverses them for display), and the
 * target is stored as a full 32-byte number instead of the compact "nBits".
 */
import { bytesToHex, hashToBigInt, sha256d } from './hash';
import type { Transaction } from './transaction';

/** A full block. txs[0] is the coinbase; header.merkleRoot = merkleRoot(txs.map(txid)). */
export interface Block {
  header: BlockHeader;
  txs: Transaction[];
}

export const HASH_BYTES = 32;
/** 32 + 32 + 8 + 32 + 4 bytes. */
export const HEADER_BYTES = 108;
const MAX_UINT32 = 0xffffffff;
const TWO_256 = 1n << 256n;

export interface BlockHeader {
  prevHash: Uint8Array;
  merkleRoot: Uint8Array;
  /** Integer milliseconds on the simulation clock. */
  timestamp: number;
  target: bigint;
  /** 32-bit, as in Bitcoin. A miner that runs out of nonces bumps the timestamp. */
  nonce: number;
}

/** prevHash of the genesis block. */
export const ZERO_HASH = new Uint8Array(HASH_BYTES);

/** Deterministic byte layout: prevHash ‖ merkleRoot ‖ timestamp(u64) ‖ target(u256) ‖ nonce(u32). */
export function serializeHeader(h: BlockHeader): Uint8Array {
  if (h.prevHash.length !== HASH_BYTES) throw new Error('prevHash must be 32 bytes');
  if (h.merkleRoot.length !== HASH_BYTES) throw new Error('merkleRoot must be 32 bytes');
  if (!Number.isSafeInteger(h.timestamp) || h.timestamp < 0) throw new Error('timestamp must be a non-negative integer');
  if (h.target <= 0n || h.target >= TWO_256) throw new Error('target must be in [1, 2^256)');
  if (!Number.isInteger(h.nonce) || h.nonce < 0 || h.nonce > MAX_UINT32) throw new Error('nonce must be a uint32');

  const out = new Uint8Array(HEADER_BYTES);
  const view = new DataView(out.buffer);
  out.set(h.prevHash, 0);
  out.set(h.merkleRoot, 32);
  view.setBigUint64(64, BigInt(h.timestamp));
  out.set(bigIntTo32Bytes(h.target), 72);
  view.setUint32(104, h.nonce);
  return out;
}

/** Block hash = sha256d(serialized header). Transactions affect it only through merkleRoot. */
export function blockHash(h: BlockHeader): Uint8Array {
  return sha256d(serializeHeader(h));
}

export function blockHashHex(h: BlockHeader): string {
  return bytesToHex(blockHash(h));
}

/** The PoW condition: hash, read as a 256-bit number, is at most the target. */
export function meetsTarget(hash: Uint8Array, target: bigint): boolean {
  return hashToBigInt(hash) <= target;
}

/**
 * Target that requires `bits` leading zero bits: 2^(256 - bits) - 1.
 * Each extra bit halves the chance a random hash qualifies, so it doubles the
 * expected number of nonce attempts (≈ 2^bits).
 */
export function targetFromLeadingZeroBits(bits: number): bigint {
  if (!Number.isInteger(bits) || bits < 0 || bits > 255) throw new Error('bits must be an integer in [0, 255]');
  return (1n << BigInt(256 - bits)) - 1n;
}

/**
 * Expected number of hashes needed to meet `target`: 2^256 / (target + 1).
 * Fork choice (Sprint 2) sums this along a chain to pick the most-work tip.
 */
export function blockWork(target: bigint): bigint {
  return TWO_256 / (target + 1n);
}

function bigIntTo32Bytes(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}
