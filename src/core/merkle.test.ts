import { describe, expect, it } from 'vitest';
import { bytesToHex, concatBytes, hexToBytes, sha256d, utf8ToBytes } from './hash';
import { merkleRoot } from './merkle';

const leaf = (s: string) => sha256d(utf8ToBytes(s));
const pair = (a: Uint8Array, b: Uint8Array) => sha256d(concatBytes(a, b));
const hex = bytesToHex;

describe('merkleRoot', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(leaf);

  it('throws for zero transactions', () => {
    expect(() => merkleRoot([])).toThrow();
  });

  it('1 tx: the root is the txid itself', () => {
    expect(hex(merkleRoot([a]))).toBe(hex(a));
  });

  it('2 txs: H(a‖b)', () => {
    expect(hex(merkleRoot([a, b]))).toBe(hex(pair(a, b)));
  });

  it('3 txs: the last hash is duplicated, H(H(a‖b) ‖ H(c‖c))', () => {
    expect(hex(merkleRoot([a, b, c]))).toBe(hex(pair(pair(a, b), pair(c, c))));
  });

  it('4 txs: H(H(a‖b) ‖ H(c‖d))', () => {
    expect(hex(merkleRoot([a, b, c, d]))).toBe(hex(pair(pair(a, b), pair(c, d))));
  });

  it('is order-sensitive and changes when any tx changes', () => {
    const root = hex(merkleRoot([a, b, c, d]));
    expect(hex(merkleRoot([b, a, c, d]))).not.toBe(root);
    expect(hex(merkleRoot([a, b, c, leaf('d!')]))).not.toBe(root);
  });

  it('does not mutate its input', () => {
    const input = [a, b, c];
    merkleRoot(input);
    expect(input).toEqual([a, b, c]);
  });

  it('matches real Bitcoin block 100000', () => {
    // Bitcoin displays txids and the root byte-reversed, so reverse in and out.
    const rev = (h: string) => hexToBytes(h).reverse();
    const txids = [
      '8c14f0db3df150123e6f3dbbf30f8b955a8249b62ac1d1ff16284aefa3d06d87',
      'fff2525b8931402dd09222c50775608f75787bd2b87e56995a7bdd30f79702c4',
      '6359f0868171b1d194cbee1af2f16ea598ae8fad666d9b012c8ed2b79a236ec4',
      'e9a66845e05d5abc0ad04ec80f774a7e585c6e8db975962d069a522137b80c1d',
    ].map(rev);
    expect(hex(merkleRoot(txids).reverse())).toBe(
      'f3e94742aca4b5ef85488dc37c06c3282295ffec960994b2c0d5ac2a25a95766',
    );
  });
});
