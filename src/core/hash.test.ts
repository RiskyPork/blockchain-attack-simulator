import { describe, expect, it } from 'vitest';
import { bytesToHex, hash160, hashToBigInt, hexToBytes, sha256, sha256d, utf8ToBytes } from './hash';

describe('hash primitives', () => {
  it('sha256 matches the FIPS 180-2 "abc" test vector', () => {
    expect(bytesToHex(sha256(utf8ToBytes('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('sha256d is SHA-256 applied twice', () => {
    const data = utf8ToBytes('hello');
    expect(bytesToHex(sha256d(data))).toBe(bytesToHex(sha256(sha256(data))));
    expect(bytesToHex(sha256d(data))).toBe(
      '9595c9df90075148eb06860365df33584b75bff782a510c6cd4883a419833d50',
    );
  });

  it('hash160 matches the Bitcoin wiki address example', () => {
    // https://en.bitcoin.it/wiki/Technical_background_of_version_1_Bitcoin_addresses
    const pubkey = hexToBytes('0250863ad64a87ae8a2fe83c1af1a8403cb53f53e486d8511dad8a04887e5b2352');
    expect(bytesToHex(hash160(pubkey))).toBe('f54a5851e9372b87810a8e60cdd2e7cfd80b6e31');
  });

  it('hashToBigInt reads bytes big-endian', () => {
    expect(hashToBigInt(hexToBytes('0001'))).toBe(1n);
    expect(hashToBigInt(hexToBytes('ff00'))).toBe(0xff00n);
    expect(hashToBigInt(new Uint8Array())).toBe(0n);
  });
});
