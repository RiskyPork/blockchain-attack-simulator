import { describe, expect, it } from 'vitest';
import { type BlockHeader, ZERO_HASH, blockHash, meetsTarget, targetFromLeadingZeroBits } from './block';
import { bytesToHex, hexToBytes, sha256d, utf8ToBytes } from './hash';
import { keyPairFromPrivate } from './keys';
import { merkleRoot } from './merkle';
import { BLOCK_SUBSIDY, type BlockParams, assembleBlock, mineBlock, mineChunk, mineHeader } from './miner';
import { COIN, type StandardTx, createCoinbase, signTransaction, txid, txidHex } from './transaction';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Fixed keys so txids (and therefore merkle roots and hashes) are reproducible.
const alice = keyPairFromPrivate(hexToBytes('18e14a7b6a307f426a94f8114701e7c8e774e7f9a47e2c2035db29a206321725'));
const bob = keyPairFromPrivate(hexToBytes('0000000000000000000000000000000000000000000000000000000000000001'));
const miner = keyPairFromPrivate(hexToBytes('0000000000000000000000000000000000000000000000000000000000000002'));

const funding1 = createCoinbase(1, alice.address, 50 * COIN);
const funding2 = createCoinbase(2, bob.address, 50 * COIN);
const tx1: StandardTx = signTransaction(
  [{ prevOut: { txid: txid(funding1), index: 0 }, key: alice }],
  [
    { value: 30 * COIN, address: bob.address },
    { value: 20 * COIN - 1000, address: alice.address },
  ],
);
const tx2: StandardTx = signTransaction(
  [{ prevOut: { txid: txid(tx1), index: 0 }, key: bob }],
  [{ value: 30 * COIN - 500, address: alice.address }],
);
const tx3: StandardTx = signTransaction(
  [{ prevOut: { txid: txid(funding2), index: 0 }, key: bob }],
  [{ value: 50 * COIN - 2000, address: miner.address }],
);

const params = (over: Partial<BlockParams> = {}): BlockParams => ({
  prevHash: sha256d(utf8ToBytes('parent block')),
  height: 7,
  timestamp: 123_456,
  target: targetFromLeadingZeroBits(8),
  minerAddress: miner.address,
  txs: [tx1, tx2, tx3],
  fees: 3500,
  ...over,
});

const MAX_U32 = 0xffffffff;

const header = (over: Partial<BlockHeader> = {}): BlockHeader => ({
  prevHash: sha256d(utf8ToBytes('parent')),
  merkleRoot: sha256d(utf8ToBytes('txs')),
  timestamp: 1_000,
  target: targetFromLeadingZeroBits(8),
  nonce: 0,
  ...over,
});

/** Comparable view of a header (hex for the byte fields). */
const hv = (h: BlockHeader) => ({
  prevHash: bytesToHex(h.prevHash),
  merkleRoot: bytesToHex(h.merkleRoot),
  timestamp: h.timestamp,
  target: h.target,
  nonce: h.nonce,
});

/** The header tried after `h`, per the spec's uint32 overflow rule. */
function nextHeader(h: BlockHeader): BlockHeader {
  return h.nonce === MAX_U32 ? { ...h, nonce: 0, timestamp: h.timestamp + 1 } : { ...h, nonce: h.nonce + 1 };
}

/** Independent reference search: try headers one at a time, return the first that meets the target. */
function bruteForce(h: BlockHeader, limit: number): { header: BlockHeader; attempts: number } | null {
  let cur = h;
  for (let a = 1; a <= limit; a++) {
    if (meetsTarget(blockHash(cur), cur.target)) return { header: cur, attempts: a };
    cur = nextHeader(cur);
  }
  return null;
}

function sequential(h: BlockHeader): { header: BlockHeader; attempts: number } {
  const r = bruteForce(h, 2_000_000);
  if (!r) throw new Error('reference search found nothing');
  return r;
}

/** A family of distinct headers (different merkle roots) so tests aren't tied to one lucky hash. */
const variant = (i: number, over: Partial<BlockHeader> = {}): BlockHeader =>
  header({ merkleRoot: sha256d(utf8ToBytes(`variant ${i}`)), ...over });

function findVariant(pred: (h: BlockHeader) => boolean, over: Partial<BlockHeader> = {}): BlockHeader {
  for (let i = 0; i < 1000; i++) {
    const h = variant(i, over);
    if (pred(h)) return h;
  }
  throw new Error('no suitable test header found');
}

function lazy<T>(f: () => T): () => T {
  let v: T | undefined;
  let done = false;
  return () => {
    if (!done) {
      v = f();
      done = true;
    }
    return v as T;
  };
}

/** 10-bit header that needs 1500..6000 attempts from nonce 0: several chunks at most chunk sizes. */
const hardHeader = lazy(() =>
  findVariant(
    (v) => {
      const r = bruteForce(v, 6000);
      return r !== null && r.attempts >= 1500;
    },
    { target: targetFromLeadingZeroBits(10) },
  ),
);

async function expectAbortError(p: Promise<unknown>): Promise<void> {
  let rejected = false;
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    rejected = true;
    caught = e;
  }
  expect(rejected).toBe(true);
  expect(caught).toBeInstanceOf(DOMException);
  expect((caught as DOMException).name).toBe('AbortError');
}

const noYield = async (): Promise<void> => {};

/** Fails the test (instead of hanging) if mining continues long after it should have stopped. */
function runawayGuard(total: number): void {
  if (total > 100_000) throw new Error('mining did not stop after abort');
}

// ---------------------------------------------------------------------------
// assembleBlock
// ---------------------------------------------------------------------------

describe('BLOCK_SUBSIDY', () => {
  it('is 50 coins', () => {
    expect(BLOCK_SUBSIDY).toBe(50 * COIN);
  });
});

describe('assembleBlock', () => {
  it('puts exactly createCoinbase(height, miner, subsidy + fees) first', () => {
    const p = params();
    const block = assembleBlock(p);
    const expected = createCoinbase(7, miner.address, BLOCK_SUBSIDY + 3500);
    expect(block.txs[0]).toStrictEqual(expected);
    expect(txidHex(block.txs[0])).toBe(txidHex(expected));
    expect(block.txs[0].outputs).toEqual([{ value: 50 * COIN + 3500, address: miner.address }]);
  });

  it('follows the coinbase with p.txs in the same order, and nothing else', () => {
    const block = assembleBlock(params({ txs: [tx3, tx1, tx2] }));
    expect(block.txs).toHaveLength(4);
    expect(block.txs.slice(1).map(txidHex)).toEqual([tx3, tx1, tx2].map(txidHex));
    expect(block.txs.slice(1)).toEqual([tx3, tx1, tx2]);
    // Only one coinbase, at position 0.
    expect(block.txs.filter((t) => t.kind === 'coinbase')).toHaveLength(1);
    expect(block.txs[0].kind).toBe('coinbase');
  });

  it('header has the given fields, nonce 0, and the merkle root of all txids in order', () => {
    const p = params();
    const block = assembleBlock(p);
    const cb = createCoinbase(p.height, p.minerAddress, BLOCK_SUBSIDY + p.fees);
    const expectedRoot = merkleRoot([txid(cb), txid(tx1), txid(tx2), txid(tx3)]);
    expect(hv(block.header)).toEqual({
      prevHash: bytesToHex(p.prevHash),
      merkleRoot: bytesToHex(expectedRoot),
      timestamp: 123_456,
      target: targetFromLeadingZeroBits(8),
      nonce: 0,
    });
    // Consistent with the block's own txs as well.
    expect(bytesToHex(block.header.merkleRoot)).toBe(bytesToHex(merkleRoot(block.txs.map(txid))));
  });

  it('merkle root depends on tx order, fees and height', () => {
    const root = (over: Partial<BlockParams>) => bytesToHex(assembleBlock(params(over)).header.merkleRoot);
    const base = root({});
    expect(root({ txs: [tx2, tx1, tx3] })).not.toBe(base);
    expect(root({ fees: 3501 })).not.toBe(base);
    expect(root({ height: 8 })).not.toBe(base);
    expect(root({ minerAddress: alice.address })).not.toBe(base);
  });

  it('coinbase-only block: merkle root is the coinbase txid', () => {
    const block = assembleBlock(params({ prevHash: ZERO_HASH, height: 0, txs: [], fees: 0 }));
    const cb = createCoinbase(0, miner.address, BLOCK_SUBSIDY);
    expect(block.txs).toEqual([cb]);
    expect(bytesToHex(block.header.merkleRoot)).toBe(txidHex(cb));
    expect(bytesToHex(block.header.prevHash)).toBe(bytesToHex(ZERO_HASH));
  });

  it('returns a new txs array (p.txs is never touched)', () => {
    const input: readonly StandardTx[] = Object.freeze([tx1, tx2]);
    const block = assembleBlock(params({ txs: input }));
    block.txs.push(tx3); // must not throw (not the frozen input) ...
    expect(input).toHaveLength(2); // ... and must not change the input
    expect(block.txs).not.toBe(input);

    const mutable = [tx1];
    const b2 = assembleBlock(params({ txs: mutable }));
    b2.txs.pop();
    expect(mutable).toEqual([tx1]);
  });

  it('accepts zero fees', () => {
    const block = assembleBlock(params({ fees: 0 }));
    expect(block.txs[0].outputs[0].value).toBe(BLOCK_SUBSIDY);
  });

  it.each([-1, -1000, 1.5, 0.1, Number.NaN, Number.POSITIVE_INFINITY])('throws for invalid fees %s', (fees) => {
    expect(() => assembleBlock(params({ fees }))).toThrow();
  });

  it('does not mine, even when the target is practically unreachable', () => {
    const block = assembleBlock(params({ target: 1n }));
    expect(block.header.nonce).toBe(0);
    expect(block.header.target).toBe(1n);
  });
});

// ---------------------------------------------------------------------------
// mineChunk
// ---------------------------------------------------------------------------

describe('mineChunk', () => {
  it('finds a header whose hash really meets the target', () => {
    const h = header();
    const r = mineChunk(h, 1_000_000);
    expect(r.found).toBe(true);
    expect(meetsTarget(blockHash(r.header), h.target)).toBe(true);
    // 8 leading zero bits = first byte of the hash is 0.
    expect(blockHash(r.header)[0]).toBe(0);
  });

  it('finds the SMALLEST valid nonce, with attempts counting the winning hash (8 and 10 bits)', () => {
    const cases = [
      ...Array.from({ length: 8 }, (_, i) => variant(i)),
      ...Array.from({ length: 3 }, (_, i) => variant(100 + i, { target: targetFromLeadingZeroBits(10) })),
    ];
    for (const h of cases) {
      const r = mineChunk(h, 1_000_000);
      expect(r.found).toBe(true);
      const n = r.header.nonce;
      // Explicit brute-force check: every nonce below the result fails, the result passes.
      for (let k = 0; k < n; k++) expect(meetsTarget(blockHash({ ...h, nonce: k }), h.target)).toBe(false);
      expect(meetsTarget(blockHash({ ...h, nonce: n }), h.target)).toBe(true);
      expect(r.attempts).toBe(n + 1);
      expect(hv(r.header)).toEqual(hv(sequential(h).header));
    }
  });

  it('starts at header.nonce, and that nonce is the first attempt', () => {
    const h = variant(1);
    const first = sequential(h).header.nonce;

    // Starting exactly on a valid nonce: found in one attempt.
    const onIt = mineChunk({ ...h, nonce: first }, 1000);
    expect(onIt.found).toBe(true);
    expect(onIt.attempts).toBe(1);
    expect(onIt.header.nonce).toBe(first);

    // Starting just past it: finds the NEXT valid nonce, never the earlier one.
    const after = mineChunk({ ...h, nonce: first + 1 }, 1_000_000);
    const expected = sequential({ ...h, nonce: first + 1 });
    expect(after.found).toBe(true);
    expect(after.header.nonce).toBeGreaterThan(first);
    expect(after.header.nonce).toBe(expected.header.nonce);
    expect(after.attempts).toBe(after.header.nonce - first);
  });

  it('handles an arbitrary non-zero starting nonce', () => {
    for (const start of [1, 777, 123_456, 2 ** 31]) {
      const h = variant(3, { nonce: start });
      const r = mineChunk(h, 1_000_000);
      const expected = sequential(h);
      expect(r.found).toBe(true);
      expect(hv(r.header)).toEqual(hv(expected.header));
      expect(r.attempts).toBe(expected.attempts);
      expect(r.attempts).toBe(r.header.nonce - start + 1);
    }
  });

  it('with the easiest target every hash qualifies: found on the first attempt', () => {
    for (const start of [0, 12_345, MAX_U32]) {
      const h = header({ target: targetFromLeadingZeroBits(0), nonce: start });
      const r = mineChunk(h, 10);
      expect(r).toMatchObject({ found: true, attempts: 1 });
      expect(hv(r.header)).toEqual(hv(h));
    }
  });

  it('gives up after maxAttempts, returning the next untried header', () => {
    const h = header({ target: 1n, nonce: 40 });
    const r = mineChunk(h, 25);
    expect(r.found).toBe(false);
    expect(r.attempts).toBe(25);
    expect(hv(r.header)).toEqual(hv({ ...h, nonce: 65 }));

    const one = mineChunk(h, 1);
    expect(one).toMatchObject({ found: false, attempts: 1 });
    expect(one.header.nonce).toBe(41);
  });

  it('stops exactly at maxAttempts: one short of the winner leaves the winner as the next header', () => {
    const h = variant(5, { target: targetFromLeadingZeroBits(10) });
    const expected = sequential(h);
    expect(expected.attempts).toBeGreaterThan(1); // fixture sanity

    const exact = mineChunk(h, expected.attempts);
    expect(exact.found).toBe(true);
    expect(exact.attempts).toBe(expected.attempts);
    expect(hv(exact.header)).toEqual(hv(expected.header));

    const short = mineChunk(h, expected.attempts - 1);
    expect(short.found).toBe(false);
    expect(short.attempts).toBe(expected.attempts - 1);
    expect(hv(short.header)).toEqual(hv(expected.header)); // the winning nonce is next untried

    const resumed = mineChunk(short.header, 1);
    expect(resumed).toMatchObject({ found: true, attempts: 1 });
    expect(hv(resumed.header)).toEqual(hv(expected.header));
  });

  it.each([1, 3, 10, 64])('continues across chunks of %i without skipping or repeating nonces', (k) => {
    const h = variant(7, { target: targetFromLeadingZeroBits(9), nonce: 11 });
    const expected = sequential(h);
    let cur = h;
    let total = 0;
    let chunks = 0;
    for (;;) {
      const r = mineChunk(cur, k);
      chunks++;
      total += r.attempts;
      if (r.found) {
        expect(r.attempts).toBeLessThanOrEqual(k);
        expect(hv(r.header)).toEqual(hv(expected.header));
        break;
      }
      expect(r.attempts).toBe(k);
      expect(r.header.nonce).toBe(cur.nonce + k);
      cur = r.header;
      if (chunks > 1_000_000) throw new Error('runaway');
    }
    expect(total).toBe(expected.attempts);
    expect(chunks).toBe(Math.ceil(expected.attempts / k));
  });

  it('never changes prevHash, merkleRoot, target or (without overflow) timestamp', () => {
    const h = variant(9, { timestamp: 987_654 });
    for (const r of [mineChunk(h, 1_000_000), mineChunk({ ...h, target: 1n }, 50)]) {
      expect(bytesToHex(r.header.prevHash)).toBe(bytesToHex(h.prevHash));
      expect(bytesToHex(r.header.merkleRoot)).toBe(bytesToHex(h.merkleRoot));
      expect(r.header.timestamp).toBe(987_654);
    }
    expect(mineChunk(h, 1_000_000).header.target).toBe(h.target);
    expect(mineChunk({ ...h, target: 1n }, 50).header.target).toBe(1n);
  });

  it('does not mutate the input header', () => {
    for (const h of [variant(2), header({ target: 1n, nonce: 5 }), header({ target: 1n, nonce: MAX_U32 - 1 })]) {
      const before = hv(h);
      const frozen = Object.freeze(h);
      const r = mineChunk(frozen, 5000);
      expect(hv(h)).toEqual(before);
      if (!r.found) expect(r.header).not.toBe(h);
    }
  });

  describe('nonce overflow', () => {
    const start = MAX_U32 - 2;

    it('after nonce 0xffffffff the next header is nonce 0 with timestamp + 1', () => {
      const h = header({ target: 1n, nonce: start, timestamp: 5_000 });
      const five = mineChunk(h, 5);
      expect(five).toMatchObject({ found: false, attempts: 5 });
      expect(five.header.nonce).toBe(2);
      expect(five.header.timestamp).toBe(5_001);

      const three = mineChunk(h, 3); // tries fffffffd, fffffffe, ffffffff
      expect(three.header.nonce).toBe(0);
      expect(three.header.timestamp).toBe(5_001);

      const two = mineChunk(h, 2); // ffffffff not tried yet: no overflow
      expect(two.header.nonce).toBe(MAX_U32);
      expect(two.header.timestamp).toBe(5_000);

      const last = mineChunk(header({ target: 1n, nonce: MAX_U32, timestamp: 5_000 }), 1);
      expect(last.header.nonce).toBe(0);
      expect(last.header.timestamp).toBe(5_001);

      for (const r of [five, three, two, last]) {
        expect(bytesToHex(r.header.merkleRoot)).toBe(bytesToHex(h.merkleRoot));
        expect(bytesToHex(r.header.prevHash)).toBe(bytesToHex(h.prevHash));
        expect(r.header.target).toBe(1n);
      }
    });

    it('a search that crosses the overflow finds the smallest valid nonce at the new timestamp', () => {
      const h = findVariant(
        (v) => [0, 1, 2].every((k) => !meetsTarget(blockHash({ ...v, nonce: start + k }), v.target)),
        { nonce: start, timestamp: 5_000 },
      );
      const r = mineChunk(h, 1_000_000);
      const expected = sequential(h);
      expect(r.found).toBe(true);
      expect(r.header.timestamp).toBe(5_001);
      expect(hv(r.header)).toEqual(hv(expected.header));
      expect(r.attempts).toBe(3 + r.header.nonce + 1);
      expect(meetsTarget(blockHash(r.header), h.target)).toBe(true);
    });

    it('continuation across the overflow boundary matches one sequential search', () => {
      const h = findVariant(
        (v) => [0, 1, 2].every((k) => !meetsTarget(blockHash({ ...v, nonce: start + k }), v.target)),
        { nonce: start, timestamp: 5_000 },
      );
      let cur = h;
      let total = 0;
      for (;;) {
        const r = mineChunk(cur, 2);
        total += r.attempts;
        cur = r.header;
        if (r.found) break;
        if (total > 1_000_000) throw new Error('runaway');
      }
      const expected = sequential(h);
      expect(hv(cur)).toEqual(hv(expected.header));
      expect(total).toBe(expected.attempts);
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('throws RangeError for maxAttempts %s', (n) => {
    expect(() => mineChunk(header(), n)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// mineHeader
// ---------------------------------------------------------------------------

describe('mineHeader', () => {
  it.each([{ chunkSize: 1 }, { chunkSize: 7 }, { chunkSize: 1000 }, { chunkSize: 1_000_000 }, {}] as {
    chunkSize?: number;
  }[])('equals one sequential search for %o (progress and yields exact)', async ({ chunkSize }) => {
    const h = hardHeader();
    const expected = sequential(h);
    const size = chunkSize ?? 5000;
    const chunks = Math.ceil(expected.attempts / size);

    const progress: number[] = [];
    let yields = 0;
    const res = await mineHeader(h, {
      ...(chunkSize === undefined ? {} : { chunkSize }),
      onProgress: (t) => progress.push(t),
      yieldToEventLoop: async () => {
        yields++;
      },
    });

    expect(hv(res.header)).toEqual(hv(expected.header));
    expect(res.attempts).toBe(expected.attempts);
    expect(meetsTarget(blockHash(res.header), h.target)).toBe(true);

    expect(progress).toEqual(Array.from({ length: chunks }, (_, i) => Math.min((i + 1) * size, expected.attempts)));
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThan(progress[i - 1]);
    expect(progress[progress.length - 1]).toBe(res.attempts);
    expect(yields).toBe(chunks - 1);
  });

  it('fixture sanity: the hard header needs several 1000-attempt chunks', () => {
    expect(sequential(hardHeader()).attempts).toBeGreaterThan(1000);
  });

  it('reports progress before yielding, and never yields after the winning chunk', async () => {
    const h = hardHeader();
    const expected = sequential(h);
    const log: string[] = [];
    await mineHeader(h, {
      chunkSize: 1000,
      onProgress: (t) => log.push(`p${t}`),
      yieldToEventLoop: async () => {
        log.push('y');
      },
    });
    const chunks = Math.ceil(expected.attempts / 1000);
    const want: string[] = [];
    for (let i = 1; i <= chunks; i++) {
      want.push(`p${Math.min(i * 1000, expected.attempts)}`);
      if (i < chunks) want.push('y');
    }
    expect(log).toEqual(want);
  });

  it('a header that already meets the target: one progress call, no yields', async () => {
    const h = header({ target: targetFromLeadingZeroBits(0), nonce: 99 });
    const progress: number[] = [];
    let yields = 0;
    const res = await mineHeader(h, {
      chunkSize: 10,
      onProgress: (t) => progress.push(t),
      yieldToEventLoop: async () => {
        yields++;
      },
    });
    expect(res.attempts).toBe(1);
    expect(hv(res.header)).toEqual(hv(h));
    expect(progress).toEqual([1]);
    expect(yields).toBe(0);
  });

  it('works with no options at all', async () => {
    const h = variant(0);
    const res = await mineHeader(h);
    const expected = sequential(h);
    expect(hv(res.header)).toEqual(hv(expected.header));
    expect(res.attempts).toBe(expected.attempts);
  });

  it('default chunk size is 5000', async () => {
    const ctrl = new AbortController();
    const progress: number[] = [];
    await expectAbortError(
      mineHeader(header({ target: 1n }), {
        signal: ctrl.signal,
        onProgress: (t) => {
          progress.push(t);
          runawayGuard(t);
          ctrl.abort();
        },
        yieldToEventLoop: noYield,
      }),
    );
    expect(progress).toEqual([5000]);
  });

  it('default yieldToEventLoop really yields to the macrotask queue (setTimeout)', async () => {
    const h = findVariant(
      (v) => {
        const r = bruteForce(v, 40);
        return r !== null && r.attempts >= 3;
      },
      { target: targetFromLeadingZeroBits(4) },
    );
    const expected = sequential(h);
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 0);
    let tickedBeforeLastChunk = false;
    const res = await mineHeader(h, {
      chunkSize: 1,
      onProgress: (t) => {
        if (t === expected.attempts) tickedBeforeLastChunk = ticked;
      },
    });
    expect(hv(res.header)).toEqual(hv(expected.header));
    expect(res.attempts).toBe(expected.attempts);
    expect(tickedBeforeLastChunk).toBe(true);
  });

  it('default yield with several chunks still gives the sequential result', async () => {
    const h = hardHeader();
    const expected = sequential(h);
    const res = await mineHeader(h, { chunkSize: 700 });
    expect(hv(res.header)).toEqual(hv(expected.header));
    expect(res.attempts).toBe(expected.attempts);
  });

  it('crosses the nonce overflow exactly like the sequential search', async () => {
    const start = MAX_U32 - 3;
    const h = findVariant(
      (v) => [0, 1, 2, 3].every((k) => !meetsTarget(blockHash({ ...v, nonce: start + k }), v.target)),
      { nonce: start, timestamp: 9_000 },
    );
    const expected = sequential(h);
    const res = await mineHeader(h, { chunkSize: 3, yieldToEventLoop: noYield });
    expect(res.header.timestamp).toBe(9_001);
    expect(hv(res.header)).toEqual(hv(expected.header));
    expect(res.attempts).toBe(expected.attempts);
  });

  it('does not mutate the input header', async () => {
    const h = hardHeader();
    const before = hv(h);
    await mineHeader(Object.freeze(h), { chunkSize: 500, yieldToEventLoop: noYield });
    expect(hv(h)).toEqual(before);
  });

  describe('abort', () => {
    it('an already-aborted signal rejects with AbortError without mining', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      let progressCalls = 0;
      let yields = 0;
      await expectAbortError(
        mineHeader(header(), {
          signal: ctrl.signal,
          onProgress: () => {
            progressCalls++;
          },
          yieldToEventLoop: async () => {
            yields++;
          },
        }),
      );
      expect(progressCalls).toBe(0);
      expect(yields).toBe(0);
    });

    it('rejects even if the very first header would have been valid', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      let progressCalls = 0;
      await expectAbortError(
        mineHeader(header({ target: targetFromLeadingZeroBits(0) }), {
          signal: ctrl.signal,
          onProgress: () => {
            progressCalls++;
          },
        }),
      );
      expect(progressCalls).toBe(0);
    });

    it('aborting from onProgress stops before the next chunk', async () => {
      const ctrl = new AbortController();
      const progress: number[] = [];
      let yields = 0;
      await expectAbortError(
        mineHeader(header({ target: 1n }), {
          chunkSize: 10,
          signal: ctrl.signal,
          onProgress: (t) => {
            progress.push(t);
            runawayGuard(t);
            if (t === 30) ctrl.abort();
          },
          yieldToEventLoop: async () => {
            yields++;
          },
        }),
      );
      expect(progress).toEqual([10, 20, 30]);
      // Per the algorithm the yield after the third chunk still happens, then the abort check.
      expect(yields).toBe(3);
    });

    it('aborting from yieldToEventLoop stops before the next chunk', async () => {
      const ctrl = new AbortController();
      const progress: number[] = [];
      let yields = 0;
      await expectAbortError(
        mineHeader(header({ target: 1n }), {
          chunkSize: 10,
          signal: ctrl.signal,
          onProgress: (t) => {
            progress.push(t);
            runawayGuard(t);
          },
          yieldToEventLoop: async () => {
            yields++;
            if (yields === 2) ctrl.abort();
            if (yields > 10_000) throw new Error('mining did not stop after abort');
          },
        }),
      );
      expect(progress).toEqual([10, 20]);
      expect(yields).toBe(2);
    });

    it('aborting mid-way with the real default yield', async () => {
      const ctrl = new AbortController();
      const progress: number[] = [];
      await expectAbortError(
        mineHeader(header({ target: 1n }), {
          chunkSize: 5,
          signal: ctrl.signal,
          onProgress: (t) => {
            progress.push(t);
            runawayGuard(t);
            if (t === 15) ctrl.abort();
          },
        }),
      );
      expect(progress).toEqual([5, 10, 15]);
    });
  });
});

// ---------------------------------------------------------------------------
// mineBlock
// ---------------------------------------------------------------------------

describe('mineBlock', () => {
  it('mines the assembled block: same txs, valid PoW, merkle root still matches', async () => {
    const block = assembleBlock(params());
    const headerBefore = hv(block.header);
    const txidsBefore = block.txs.map(txidHex);
    const expected = sequential(block.header);

    const res = await mineBlock(block, { yieldToEventLoop: noYield });

    expect(hv(res.block.header)).toEqual(hv(expected.header));
    expect(res.attempts).toBe(expected.attempts);
    expect(meetsTarget(blockHash(res.block.header), block.header.target)).toBe(true);
    expect(res.block.txs.map(txidHex)).toEqual(txidsBefore);
    expect(res.block.txs).toEqual(block.txs);
    expect(bytesToHex(merkleRoot(res.block.txs.map(txid)))).toBe(bytesToHex(res.block.header.merkleRoot));
    expect(bytesToHex(res.block.header.merkleRoot)).toBe(headerBefore.merkleRoot);
    expect(bytesToHex(res.block.header.prevHash)).toBe(headerBefore.prevHash);
    expect(res.block.header.timestamp).toBe(headerBefore.timestamp);

    // Input block untouched.
    expect(hv(block.header)).toEqual(headerBefore);
    expect(block.txs.map(txidHex)).toEqual(txidsBefore);
  });

  it('passes options through (chunkSize, onProgress, yield)', async () => {
    const block = { header: hardHeader(), txs: assembleBlock(params()).txs };
    const expected = sequential(block.header);
    const progress: number[] = [];
    let yields = 0;
    const res = await mineBlock(block, {
      chunkSize: 1000,
      onProgress: (t) => progress.push(t),
      yieldToEventLoop: async () => {
        yields++;
      },
    });
    const chunks = Math.ceil(expected.attempts / 1000);
    expect(res.attempts).toBe(expected.attempts);
    expect(hv(res.block.header)).toEqual(hv(expected.header));
    expect(progress).toHaveLength(chunks);
    expect(progress[chunks - 1]).toBe(expected.attempts);
    expect(yields).toBe(chunks - 1);
  });

  it('rejects with AbortError for an already-aborted signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const block = assembleBlock(params());
    await expectAbortError(mineBlock(block, { signal: ctrl.signal }));
    expect(block.header.nonce).toBe(0);
  });
});
