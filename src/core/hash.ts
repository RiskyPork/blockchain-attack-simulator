/**
 * Hash primitives used throughout the simulator.
 *
 * Bitcoin uses two hash constructions (Lec05):
 *   - SHA-256 applied twice ("sha256d") for block hashes, transaction ids and
 *     Merkle tree nodes.
 *   - HASH160 = RIPEMD160(SHA256(x)) to shorten a public key into an address.
 *
 * All functions are synchronous so they can run inside the mining loop.
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export { bytesToHex, concatBytes, hexToBytes, utf8ToBytes };

/** Single SHA-256. */
export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

/** Double SHA-256, Bitcoin's standard hash for blocks, txids and Merkle nodes. */
export function sha256d(data: Uint8Array): Uint8Array {
  return nobleSha256(nobleSha256(data));
}

/** Lec05: address payload = RIPEMD160(SHA256(pubkey)). */
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(nobleSha256(data));
}

/**
 * Interpret a hash as a big-endian unsigned integer so it can be compared with
 * the difficulty target: a block is valid PoW iff hashToBigInt(hash) <= target.
 */
export function hashToBigInt(hash: Uint8Array): bigint {
  return hash.length === 0 ? 0n : BigInt('0x' + bytesToHex(hash));
}
