/**
 * Key pairs, ECDSA signatures and addresses (Lec05).
 *
 * Bitcoin uses ECDSA over the secp256k1 curve:
 *   private key  = random 256-bit number
 *   public key   = privateKey · G  (33-byte compressed point)
 *   address      = Base58Check(version ‖ HASH160(publicKey))
 *
 * Only the address is published when receiving coins; the public key is
 * revealed when spending, and the signature proves ownership of the private
 * key without revealing it.
 */
import * as secp from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { base58CheckDecode, base58CheckEncode } from './base58';
import { concatBytes, hash160 } from './hash';

// noble/secp256k1 needs hash functions supplied to use its synchronous API.
// Sync signing matters because validation runs inside the simulation loop.
secp.hashes.sha256 = nobleSha256;
secp.hashes.hmacSha256 = (key, msg) => hmac(nobleSha256, key, msg);

/** Version byte 0x00 = Bitcoin mainnet P2PKH, which gives addresses starting with '1'. */
export const ADDRESS_VERSION = 0x00;

export type Address = string;

export interface KeyPair {
  privateKey: Uint8Array;
  /** 33-byte compressed public key. */
  publicKey: Uint8Array;
  address: Address;
}

export function publicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  return secp.getPublicKey(privateKey, true);
}

export function addressFromPublicKey(publicKey: Uint8Array): Address {
  return base58CheckEncode(concatBytes(Uint8Array.of(ADDRESS_VERSION), hash160(publicKey)));
}

export function keyPairFromPrivate(privateKey: Uint8Array): KeyPair {
  if (!secp.utils.isValidSecretKey(privateKey)) throw new Error('invalid secp256k1 private key');
  const publicKey = publicKeyFromPrivate(privateKey);
  return { privateKey, publicKey, address: addressFromPublicKey(publicKey) };
}

/**
 * Fresh key pair from the browser's CSPRNG. Wallet keys are deliberately not
 * drawn from the seeded simulation RNG: seeds control the simulation, not the keys.
 */
export function generateKeyPair(): KeyPair {
  return keyPairFromPrivate(secp.utils.randomSecretKey());
}

/**
 * Sign a 32-byte digest (e.g. the sha256d transaction digest). prehash is off
 * because the caller has already hashed the message. Returns a 64-byte compact
 * (r ‖ s) signature with low-S, as Bitcoin requires since BIP 146.
 */
export function signDigest(digest: Uint8Array, privateKey: Uint8Array): Uint8Array {
  if (digest.length !== 32) throw new Error('digest must be 32 bytes');
  return secp.sign(digest, privateKey, { prehash: false });
}

/** True iff `signature` is a valid signature of `digest` by `publicKey`. Never throws. */
export function verifyDigest(signature: Uint8Array, digest: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return secp.verify(signature, digest, publicKey, { prehash: false });
  } catch {
    return false;
  }
}

/** Address is well-formed: valid Base58Check, right version byte, 20-byte HASH160 payload. */
export function isValidAddress(address: string): boolean {
  try {
    const payload = base58CheckDecode(address);
    return payload.length === 21 && payload[0] === ADDRESS_VERSION;
  } catch {
    return false;
  }
}

/** True iff `publicKey` hashes to `address`; used to check who may spend an output. */
export function publicKeyMatchesAddress(publicKey: Uint8Array, address: Address): boolean {
  return addressFromPublicKey(publicKey) === address;
}
