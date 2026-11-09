import { describe, expect, it } from 'vitest';
import {
  type BlockHeader,
  HEADER_BYTES,
  ZERO_HASH,
  blockHash,
  blockHashHex,
  blockWork,
  meetsTarget,
  serializeHeader,
  targetFromLeadingZeroBits,
} from './block';
import { bytesToHex, hexToBytes, sha256d, utf8ToBytes } from './hash';

const header = (over: Partial<BlockHeader> = {}): BlockHeader => ({
  prevHash: ZERO_HASH,
  merkleRoot: sha256d(utf8ToBytes('coinbase')),
  timestamp: 1_000,
  target: targetFromLeadingZeroBits(8),
  nonce: 42,
  ...over,
});

describe('serializeHeader', () => {
  it('has a fixed length and layout', () => {
    const h = header({ timestamp: 0x0102, nonce: 0xaabbccdd });
    const bytes = serializeHeader(h);
    expect(bytes).toHaveLength(HEADER_BYTES);
    expect(bytesToHex(bytes.slice(0, 32))).toBe(bytesToHex(h.prevHash));
    expect(bytesToHex(bytes.slice(32, 64))).toBe(bytesToHex(h.merkleRoot));
    expect(bytesToHex(bytes.slice(64, 72))).toBe('0000000000000102');
    // 8 leading zero bits → 0x00 then 31 bytes of 0xff.
    expect(bytesToHex(bytes.slice(72, 104))).toBe('00' + 'ff'.repeat(31));
    expect(bytesToHex(bytes.slice(104))).toBe('aabbccdd');
  });

  it('is deterministic', () => {
    expect(bytesToHex(serializeHeader(header()))).toBe(bytesToHex(serializeHeader(header())));
  });

  it('rejects out-of-range fields', () => {
    expect(() => serializeHeader(header({ prevHash: new Uint8Array(31) }))).toThrow(/prevHash/);
    expect(() => serializeHeader(header({ merkleRoot: new Uint8Array(33) }))).toThrow(/merkleRoot/);
    expect(() => serializeHeader(header({ timestamp: -1 }))).toThrow(/timestamp/);
    expect(() => serializeHeader(header({ timestamp: 1.5 }))).toThrow(/timestamp/);
    expect(() => serializeHeader(header({ nonce: 2 ** 32 }))).toThrow(/nonce/);
    expect(() => serializeHeader(header({ target: 0n }))).toThrow(/target/);
    expect(() => serializeHeader(header({ target: 1n << 256n }))).toThrow(/target/);
  });
});

describe('blockHash', () => {
  it('is sha256d of the serialized header', () => {
    const h = header();
    expect(bytesToHex(blockHash(h))).toBe(bytesToHex(sha256d(serializeHeader(h))));
    expect(blockHashHex(h)).toBe(bytesToHex(blockHash(h)));
  });

  it('changes when any header field changes', () => {
    const base = blockHashHex(header());
    const variants: Partial<BlockHeader>[] = [
      { prevHash: sha256d(utf8ToBytes('parent')) },
      { merkleRoot: sha256d(utf8ToBytes('other tx')) },
      { timestamp: 1_001 },
      { target: targetFromLeadingZeroBits(9) },
      { nonce: 43 },
    ];
    for (const v of variants) expect(blockHashHex(header(v))).not.toBe(base);
  });
});

describe('targets and PoW check', () => {
  it('targetFromLeadingZeroBits gives 2^(256-bits) - 1', () => {
    expect(targetFromLeadingZeroBits(0)).toBe((1n << 256n) - 1n);
    expect(targetFromLeadingZeroBits(16)).toBe((1n << 240n) - 1n);
    expect(() => targetFromLeadingZeroBits(256)).toThrow();
    expect(() => targetFromLeadingZeroBits(-1)).toThrow();
  });

  it('meetsTarget accepts hashes at or below the target only', () => {
    const target = targetFromLeadingZeroBits(8);
    expect(meetsTarget(hexToBytes('00' + 'ff'.repeat(31)), target)).toBe(true); // == target
    expect(meetsTarget(hexToBytes('0000' + 'ab'.repeat(30)), target)).toBe(true);
    expect(meetsTarget(hexToBytes('01' + '00'.repeat(31)), target)).toBe(false);
  });

  it('a brute-force nonce search finds a block that meets an easy target', () => {
    // Not the miner, just a check that the header + target pieces fit together.
    const target = targetFromLeadingZeroBits(8);
    let h = header({ nonce: 0 });
    while (!meetsTarget(blockHash(h), target)) h = { ...h, nonce: h.nonce + 1 };
    expect(blockHashHex(h).startsWith('00')).toBe(true);
  });

  it('blockWork doubles with each extra zero bit', () => {
    expect(blockWork(targetFromLeadingZeroBits(0))).toBe(1n);
    expect(blockWork(targetFromLeadingZeroBits(10))).toBe(1024n);
    expect(blockWork(targetFromLeadingZeroBits(11))).toBe(2n * blockWork(targetFromLeadingZeroBits(10)));
  });
});
