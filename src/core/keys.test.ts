import { describe, expect, it } from 'vitest';
import { base58CheckDecode, base58CheckEncode, base58Decode, base58Encode } from './base58';
import { bytesToHex, hexToBytes, sha256d, utf8ToBytes } from './hash';
import {
  addressFromPublicKey,
  generateKeyPair,
  isValidAddress,
  keyPairFromPrivate,
  publicKeyMatchesAddress,
  signDigest,
  verifyDigest,
} from './keys';

// https://en.bitcoin.it/wiki/Technical_background_of_version_1_Bitcoin_addresses
const WIKI_PRIV = '18e14a7b6a307f426a94f8114701e7c8e774e7f9a47e2c2035db29a206321725';
const WIKI_PUB = '0250863ad64a87ae8a2fe83c1af1a8403cb53f53e486d8511dad8a04887e5b2352';
const WIKI_ADDR = '1PMycacnJaSqwwJqjawXBErnLsZ7RkXUAs';

describe('Base58', () => {
  it('encodes a known string', () => {
    expect(base58Encode(utf8ToBytes('Hello World!'))).toBe('2NEpo7TZRRrLZSi2U');
  });

  it('maps each leading zero byte to a leading 1', () => {
    expect(base58Encode(hexToBytes('0000'))).toBe('11');
    expect(base58Encode(hexToBytes('000001'))).toBe('112');
    expect(base58Encode(new Uint8Array())).toBe('');
  });

  it('decode inverts encode', () => {
    for (const hex of ['', '00', '0000ff', 'deadbeef', '00f54a5851e9372b87810a8e60cdd2e7cfd80b6e31']) {
      expect(bytesToHex(base58Decode(base58Encode(hexToBytes(hex))))).toBe(hex);
    }
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => base58Decode('0OIl')).toThrow(/invalid Base58/);
  });

  it('Base58Check round-trips and detects corruption', () => {
    const payload = hexToBytes('00f54a5851e9372b87810a8e60cdd2e7cfd80b6e31');
    const text = base58CheckEncode(payload);
    expect(bytesToHex(base58CheckDecode(text))).toBe(bytesToHex(payload));
    // Change one character: the checksum must catch it.
    const corrupted = text.slice(0, -1) + (text.endsWith('s') ? 't' : 's');
    expect(() => base58CheckDecode(corrupted)).toThrow(/checksum/);
  });
});

describe('keys and addresses', () => {
  it('derives the Bitcoin wiki public key and address from its private key', () => {
    const kp = keyPairFromPrivate(hexToBytes(WIKI_PRIV));
    expect(bytesToHex(kp.publicKey)).toBe(WIKI_PUB);
    expect(kp.address).toBe(WIKI_ADDR);
    expect(addressFromPublicKey(hexToBytes(WIKI_PUB))).toBe(WIKI_ADDR);
  });

  it('rejects an out-of-range private key', () => {
    expect(() => keyPairFromPrivate(new Uint8Array(32))).toThrow(/invalid/);
  });

  it('generates distinct, valid key pairs', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(a.address).not.toBe(b.address);
    expect(a.publicKey).toHaveLength(33);
    expect(isValidAddress(a.address)).toBe(true);
    expect(a.address.startsWith('1')).toBe(true);
  });

  it('validates addresses', () => {
    expect(isValidAddress(WIKI_ADDR)).toBe(true);
    expect(isValidAddress(WIKI_ADDR.slice(0, -1) + 't')).toBe(false); // bad checksum
    expect(isValidAddress('not an address')).toBe(false);
    // Valid Base58Check but wrong version byte (0x05 = P2SH).
    expect(isValidAddress(base58CheckEncode(hexToBytes('05f54a5851e9372b87810a8e60cdd2e7cfd80b6e31')))).toBe(false);
  });

  it('matches a public key to its own address only', () => {
    const other = generateKeyPair();
    expect(publicKeyMatchesAddress(hexToBytes(WIKI_PUB), WIKI_ADDR)).toBe(true);
    expect(publicKeyMatchesAddress(other.publicKey, WIKI_ADDR)).toBe(false);
  });
});

describe('ECDSA signatures over a digest', () => {
  const digest = sha256d(utf8ToBytes('pay 5 coins to bob'));

  it('a signature verifies with the signer key', () => {
    const kp = generateKeyPair();
    const sig = signDigest(digest, kp.privateKey);
    expect(sig).toHaveLength(64);
    expect(verifyDigest(sig, digest, kp.publicKey)).toBe(true);
  });

  it('fails for a different message, a different key, or a tampered signature', () => {
    const kp = generateKeyPair();
    const other = generateKeyPair();
    const sig = signDigest(digest, kp.privateKey);
    expect(verifyDigest(sig, sha256d(utf8ToBytes('pay 500 coins to bob')), kp.publicKey)).toBe(false);
    expect(verifyDigest(sig, digest, other.publicKey)).toBe(false);
    const tampered = sig.slice();
    tampered[10] ^= 1;
    expect(verifyDigest(tampered, digest, kp.publicKey)).toBe(false);
  });

  it('returns false instead of throwing on malformed input', () => {
    const kp = generateKeyPair();
    expect(verifyDigest(new Uint8Array(5), digest, kp.publicKey)).toBe(false);
    expect(verifyDigest(signDigest(digest, kp.privateKey), digest, new Uint8Array(33))).toBe(false);
  });

  it('rejects a digest that is not 32 bytes', () => {
    expect(() => signDigest(new Uint8Array(31), generateKeyPair().privateKey)).toThrow(/32 bytes/);
  });
});
