/**
 * Real proof-of-work mining.
 *
 * A miner assembles a candidate block (its own coinbase first, then the
 * transactions it picked) and then searches for a nonce such that
 * sha256d(header) <= target. SHA-256 behaves like a random function, so there
 * is no shortcut: the only way is to try nonces one by one. The expected
 * number of attempts is 2^bits for a target with `bits` leading zero bits.
 *
 * The search runs in chunks with a yield to the event loop between them, so
 * the browser stays responsive while a block is being mined.
 */
import { type Block, type BlockHeader, blockHash, meetsTarget } from './block';
import type { Address } from './keys';
import { merkleRoot } from './merkle';
import { COIN, type StandardTx, type Transaction, createCoinbase, txid } from './transaction';

/** New coins created per block. Fixed in this simulator (Bitcoin halves it every 210,000 blocks). */
export const BLOCK_SUBSIDY = 50 * COIN;

const MAX_NONCE = 0xffffffff;
const DEFAULT_CHUNK_SIZE = 5000;

export interface BlockParams {
  prevHash: Uint8Array;
  height: number;
  timestamp: number;
  target: bigint;
  minerAddress: Address;
  /** Transactions to include, in order, after the coinbase. */
  txs: readonly StandardTx[];
  /** Σ fees of `txs`; the miner may claim subsidy + fees in its coinbase. */
  fees: number;
}

/** Candidate block with nonce 0. Its hash still has to be mined. */
export function assembleBlock(p: BlockParams): Block {
  if (!Number.isSafeInteger(p.fees) || p.fees < 0) throw new Error('fees must be a non-negative integer');
  const txs: Transaction[] = [createCoinbase(p.height, p.minerAddress, BLOCK_SUBSIDY + p.fees), ...p.txs];
  return {
    header: {
      prevHash: p.prevHash,
      merkleRoot: merkleRoot(txs.map(txid)),
      timestamp: p.timestamp,
      target: p.target,
      nonce: 0,
    },
    txs,
  };
}

export interface ChunkResult {
  /** Winning header if found, otherwise the next header to try. */
  header: BlockHeader;
  found: boolean;
  /** Hashes computed in this chunk, including the winning one. */
  attempts: number;
}

/**
 * Try up to `maxAttempts` nonces in order, starting with header.nonce.
 * When the 32-bit nonce runs out, bump the timestamp and start again from 0
 * (real miners also change the timestamp or the coinbase "extra nonce").
 */
export function mineChunk(header: BlockHeader, maxAttempts: number): ChunkResult {
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) throw new RangeError('maxAttempts must be a positive integer');
  let h: BlockHeader = { ...header };
  for (let attempts = 1; attempts <= maxAttempts; attempts++) {
    if (meetsTarget(blockHash(h), h.target)) return { header: h, found: true, attempts };
    h = h.nonce === MAX_NONCE ? { ...h, nonce: 0, timestamp: h.timestamp + 1 } : { ...h, nonce: h.nonce + 1 };
  }
  return { header: h, found: false, attempts: maxAttempts };
}

export interface MineOptions {
  /** Nonces tried between yields to the event loop. */
  chunkSize?: number;
  signal?: AbortSignal;
  /** Called after every chunk with the total number of hashes so far. */
  onProgress?: (totalAttempts: number) => void;
  /** How to give the UI a turn between chunks; injectable for tests. */
  yieldToEventLoop?: () => Promise<void>;
}

const defaultYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Mine until a nonce meets the target. Rejects with an AbortError if `signal` aborts. */
export async function mineHeader(
  header: BlockHeader,
  opts: MineOptions = {},
): Promise<{ header: BlockHeader; attempts: number }> {
  const { chunkSize = DEFAULT_CHUNK_SIZE, signal, onProgress, yieldToEventLoop = defaultYield } = opts;
  let current = header;
  let total = 0;
  for (; ;) {
    if (signal?.aborted) throw new DOMException('Mining aborted', 'AbortError');
    const r = mineChunk(current, chunkSize);
    total += r.attempts;
    onProgress?.(total);
    if (r.found) return { header: r.header, attempts: total };
    await yieldToEventLoop();
    current = r.header;
  }
}

export async function mineBlock(block: Block, opts: MineOptions = {}): Promise<{ block: Block; attempts: number }> {
  const { header, attempts } = await mineHeader(block.header, opts);
  return { block: { header, txs: block.txs }, attempts };
}
