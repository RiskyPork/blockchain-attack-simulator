import { describe, expect, it } from 'vitest';
import { base58CheckEncode } from './base58';
import { type Block, type BlockHeader, ZERO_HASH, blockHash, meetsTarget, targetFromLeadingZeroBits } from './block';
import { bytesToHex, concatBytes, hash160, hexToBytes, sha256d, utf8ToBytes } from './hash';
import { type KeyPair, keyPairFromPrivate } from './keys';
import { merkleRoot } from './merkle';
import { BLOCK_SUBSIDY, mineChunk } from './miner';
import {
  COIN,
  type CoinbaseTx,
  type OutPoint,
  type StandardTx,
  type Transaction,
  type TxOutput,
  createCoinbase,
  signTransaction,
  txid,
} from './transaction';
import { UtxoSet } from './utxo';
import {
  type BlockContext,
  type BlockError,
  type TxError,
  MAX_MONEY,
  checkTxStructure,
  describeBlockError,
  describeTxError,
  validateBlock,
  validateTransaction,
} from './validation';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const keyN = (n: number): KeyPair => keyPairFromPrivate(hexToBytes(n.toString(16).padStart(64, '0')));

// Fixed keys so every txid / merkle root / block hash is reproducible.
const alice = keyPairFromPrivate(hexToBytes('18e14a7b6a307f426a94f8114701e7c8e774e7f9a47e2c2035db29a206321725'));
const bob = keyN(1);
const carol = keyN(2);
const miner = keyN(3);

const op = (tx: Transaction, index: number): OutPoint => ({ txid: txid(tx), index });
const pay = (to: KeyPair, value: number): TxOutput => ({ value, address: to.address });

/** Properly signed standard tx. */
const spend = (inputs: [OutPoint, KeyPair][], outputs: TxOutput[]): StandardTx =>
  signTransaction(
    inputs.map(([prevOut, key]) => ({ prevOut, key })),
    outputs,
  );

/** Unsigned standard tx (empty witnesses), for context-free structure checks. */
const rawTx = (prevOuts: OutPoint[], outputs: TxOutput[]): StandardTx => ({
  kind: 'standard',
  inputs: prevOuts.map((prevOut) => ({ prevOut, publicKey: new Uint8Array(), signature: new Uint8Array() })),
  outputs,
});

/** Coinbase with arbitrary outputs. */
const coinbase = (height: number, outputs: TxOutput[]): CoinbaseTx => ({ kind: 'coinbase', height, outputs });

// Funding: three outputs that exist in the base UTXO set.
const fundA = createCoinbase(100, alice.address, 1_000_000_000); // alice, 10 COIN
const fundA2 = createCoinbase(101, alice.address, 500_000_000); // alice, 5 COIN
const fundB = createCoinbase(102, bob.address, 2_000_000_000); // bob, 20 COIN
const A = op(fundA, 0);
const A2 = op(fundA2, 0);
const B = op(fundB, 0);
/** An outpoint that is not in any UTXO set used here. */
const NOWHERE: OutPoint = { txid: sha256d(utf8ToBytes('never existed')), index: 0 };

const baseUtxos = (): UtxoSet => {
  const s = new UtxoSet();
  s.applyTransactions([fundA, fundA2, fundB]);
  return s;
};

// Standard txs used in blocks.
// t1: alice 10 -> bob 6 + alice 3.9, fee 0.1
const t1 = spend([[A, alice]], [pay(bob, 600_000_000), pay(alice, 390_000_000)]);
const F1 = 10_000_000;
// t2: spends t1:0 (bob 6) -> carol 5.95, fee 0.05  (depends on t1)
const t2 = spend([[op(t1, 0), bob]], [pay(carol, 595_000_000)]);
const F2 = 5_000_000;
// t3: bob 20 -> carol 19, fee 1 (independent)
const t3 = spend([[B, bob]], [pay(carol, 1_900_000_000)]);
const F3 = 100_000_000;
// t1x: conflicts with t1 (spends A as well)
const t1x = spend([[A, alice]], [pay(carol, 900_000_000)]);

const MAX_U32 = 0xffffffff;
const T8 = targetFromLeadingZeroBits(8);
const T20 = targetFromLeadingZeroBits(20);
const PARENT = sha256d(utf8ToBytes('parent block'));
const HEIGHT = 7;

const ctxOf = (over: Partial<BlockContext> = {}): BlockContext => ({
  utxos: baseUtxos(),
  parentHash: new Uint8Array(PARENT), // a copy: comparison must be byte-wise
  height: HEIGHT,
  target: T8,
  ...over,
});

const cbOf = (value: number = BLOCK_SUBSIDY, height = HEIGHT): CoinbaseTx => createCoinbase(height, miner.address, value);

/** Calls f; if it throws, fails the test with a clear message (the spec says these never throw). */
function noThrow<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    throw new Error(`expected no exception, but it threw: ${String(e)}`);
  }
}

/** Loop the synchronous miner until a nonce meets header.target. */
function mine(header: BlockHeader): BlockHeader {
  let h = header;
  for (;;) {
    const r = mineChunk(h, 20_000);
    if (r.found) return r.header;
    h = r.header;
  }
}

/** First nonce >= 0 whose hash does NOT meet `header.target`. */
function failPow(header: BlockHeader): BlockHeader {
  let h = { ...header, nonce: 0 };
  while (meetsTarget(blockHash(h), h.target)) h = { ...h, nonce: h.nonce + 1 };
  return h;
}

interface BlockOpts {
  prevHash?: Uint8Array;
  target?: bigint;
  timestamp?: number;
  /** Header merkle root; default merkleRoot(txs.map(txid)). */
  merkleRoot?: Uint8Array;
  /** 'mine' (default): meets target; 'fail': does not meet target. */
  pow?: 'mine' | 'fail';
}

/** A block around `txs` that passes every header rule unless told otherwise. */
function makeBlock(txs: Transaction[], o: BlockOpts = {}): Block {
  const header: BlockHeader = {
    prevHash: o.prevHash ?? PARENT,
    merkleRoot: o.merkleRoot ?? merkleRoot(txs.map(txid)),
    timestamp: o.timestamp ?? 1_000,
    target: o.target ?? T8,
    nonce: 0,
  };
  return { header: o.pow === 'fail' ? failPow(header) : mine(header), txs };
}

/** Block with a coinbase claiming exactly subsidy + fees, then `txs`. */
const fullBlock = (txs: StandardTx[], fees: number, o: BlockOpts = {}): Block =>
  makeBlock([cbOf(BLOCK_SUBSIDY + fees), ...txs], o);

/** Canonical snapshot of a UTXO set. */
const snapUtxos = (s: UtxoSet): string[] =>
  s
    .all()
    .map((u) => `${bytesToHex(u.outPoint.txid)}:${u.outPoint.index}|${u.output.value}|${u.output.address}`)
    .sort();

/** Deep snapshot of any tx/block (Uint8Array -> hex, bigint -> string). */
const snapAny = (x: unknown): string =>
  JSON.stringify(x, (_k, v: unknown) =>
    v instanceof Uint8Array ? `bytes:${bytesToHex(v)}` : typeof v === 'bigint' ? `big:${v}` : Number.isNaN(v) ? 'NaN' : v,
  );

const txErr = (error: TxError) => ({ ok: false, error });
const blkErr = (error: BlockError) => ({ ok: false, error });
const invalidTx = (index: number, error: TxError) => blkErr({ code: 'invalid-tx', index, error });

// Malformed / non-standard addresses.
const wrongVersionAddress = base58CheckEncode(concatBytes(Uint8Array.of(0x05), hash160(alice.publicKey)));
const shortPayloadAddress = base58CheckEncode(concatBytes(Uint8Array.of(0x00), hash160(alice.publicKey).slice(0, 19)));
const badChecksumAddress = alice.address.slice(0, -1) + (alice.address.endsWith('1') ? '2' : '1');
const GARBAGE_ADDRESSES: [string, string][] = [
  ['garbage text', 'not-an-address!'],
  ['empty string', ''],
  ['wrong version byte', wrongVersionAddress],
  ['19-byte payload', shortPayloadAddress],
  ['bad checksum', badChecksumAddress],
];

// ---------------------------------------------------------------------------
// MAX_MONEY
// ---------------------------------------------------------------------------

describe('MAX_MONEY', () => {
  it('is 21 million coins in base units', () => {
    expect(MAX_MONEY).toBe(21_000_000 * COIN);
    expect(MAX_MONEY).toBe(2_100_000_000_000_000);
  });
});

// ---------------------------------------------------------------------------
// checkTxStructure
// ---------------------------------------------------------------------------

describe('checkTxStructure', () => {
  it('accepts a well-formed standard tx and a well-formed coinbase', () => {
    expect(checkTxStructure(t1)).toBeNull();
    expect(checkTxStructure(rawTx([A, A2, B], [pay(bob, 1)]))).toBeNull();
    expect(checkTxStructure(cbOf())).toBeNull();
    expect(checkTxStructure(coinbase(0, [pay(bob, 1), pay(carol, 2)]))).toBeNull();
  });

  it('is context-free: an unsigned tx spending unknown outputs is structurally fine', () => {
    expect(checkTxStructure(rawTx([NOWHERE], [pay(bob, 5)]))).toBeNull();
  });

  it('no-inputs for a standard tx with zero inputs', () => {
    expect(checkTxStructure(rawTx([], [pay(bob, 1)]))).toEqual({ code: 'no-inputs' });
  });

  it('a coinbase (no inputs by construction) is never no-inputs', () => {
    expect(checkTxStructure(coinbase(3, [pay(bob, 1)]))).toBeNull();
  });

  it('no-outputs for a standard tx and for a coinbase with zero outputs', () => {
    expect(checkTxStructure(rawTx([A], []))).toEqual({ code: 'no-outputs' });
    expect(checkTxStructure(coinbase(3, []))).toEqual({ code: 'no-outputs' });
  });

  it('no-inputs is reported before no-outputs', () => {
    expect(checkTxStructure(rawTx([], []))).toEqual({ code: 'no-inputs' });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['MAX_MONEY + 1', MAX_MONEY + 1],
    ['unsafe huge integer', 2 ** 60],
  ])('invalid-output-value for a %s value', (_name, value) => {
    expect(checkTxStructure(rawTx([A], [pay(bob, value)]))).toEqual({ code: 'invalid-output-value', output: 0 });
    expect(checkTxStructure(coinbase(1, [pay(bob, value)]))).toEqual({ code: 'invalid-output-value', output: 0 });
  });

  it('invalid-output-value for a non-number value', () => {
    const tx = rawTx([A], [{ value: '5' as unknown as number, address: bob.address }]);
    expect(checkTxStructure(tx)).toEqual({ code: 'invalid-output-value', output: 0 });
  });

  it('boundary values: 1 and MAX_MONEY are valid', () => {
    expect(checkTxStructure(rawTx([A], [pay(bob, 1)]))).toBeNull();
    expect(checkTxStructure(rawTx([A], [pay(bob, MAX_MONEY)]))).toBeNull();
    expect(checkTxStructure(coinbase(1, [pay(bob, MAX_MONEY)]))).toBeNull();
  });

  it('reports the index of the first output with a bad value', () => {
    const tx = rawTx([A], [pay(bob, 1), pay(bob, 2), pay(bob, 0), pay(bob, -5)]);
    expect(checkTxStructure(tx)).toEqual({ code: 'invalid-output-value', output: 2 });
  });

  it('running total: exactly MAX_MONEY in total is fine, one more fails at the output that crosses it', () => {
    expect(checkTxStructure(rawTx([A], [pay(bob, MAX_MONEY - 1), pay(bob, 1)]))).toBeNull();
    expect(checkTxStructure(rawTx([A], [pay(bob, MAX_MONEY), pay(bob, 1)]))).toEqual({
      code: 'invalid-output-value',
      output: 1,
    });
    expect(checkTxStructure(rawTx([A], [pay(bob, 1), pay(bob, MAX_MONEY)]))).toEqual({
      code: 'invalid-output-value',
      output: 1,
    });
    const half = MAX_MONEY / 2;
    expect(checkTxStructure(rawTx([A], [pay(bob, half), pay(bob, half), pay(bob, 1), pay(bob, 1)]))).toEqual({
      code: 'invalid-output-value',
      output: 2,
    });
    expect(checkTxStructure(coinbase(1, [pay(bob, MAX_MONEY), pay(carol, 1)]))).toEqual({
      code: 'invalid-output-value',
      output: 1,
    });
  });

  it('running total is checked per output, not after all values (an overflow at i wins over a bad value at i+1)', () => {
    expect(checkTxStructure(rawTx([A], [pay(bob, MAX_MONEY), pay(bob, 1), pay(bob, 0)]))).toEqual({
      code: 'invalid-output-value',
      output: 1,
    });
  });

  it.each(GARBAGE_ADDRESSES)('invalid-address for %s', (_name, address) => {
    expect(checkTxStructure(rawTx([A], [{ value: 5, address }]))).toEqual({ code: 'invalid-address', output: 0 });
    expect(checkTxStructure(coinbase(1, [{ value: 5, address }]))).toEqual({ code: 'invalid-address', output: 0 });
  });

  it('invalid-address for a non-string address, without throwing', () => {
    for (const address of [undefined, null, 42]) {
      const tx = rawTx([A], [{ value: 5, address: address as unknown as string }]);
      expect(() => checkTxStructure(tx)).not.toThrow();
      expect(checkTxStructure(tx)).toEqual({ code: 'invalid-address', output: 0 });
    }
  });

  it('reports the index of the first output with a bad address', () => {
    const tx = rawTx([A], [pay(bob, 1), pay(carol, 1), { value: 1, address: 'xyz' }, { value: 1, address: '' }]);
    expect(checkTxStructure(tx)).toEqual({ code: 'invalid-address', output: 2 });
  });

  it('per output, the value is checked before the address', () => {
    expect(checkTxStructure(rawTx([A], [{ value: 0, address: 'garbage' }]))).toEqual({
      code: 'invalid-output-value',
      output: 0,
    });
    // running-total overflow at output 1 is reported before output 1's bad address
    expect(checkTxStructure(rawTx([A], [pay(bob, MAX_MONEY), { value: 1, address: 'garbage' }]))).toEqual({
      code: 'invalid-output-value',
      output: 1,
    });
  });

  it('outputs are checked in order: a bad address at 0 wins over a bad value at 1', () => {
    expect(checkTxStructure(rawTx([A], [{ value: 1, address: 'garbage' }, pay(bob, 0)]))).toEqual({
      code: 'invalid-address',
      output: 0,
    });
  });

  it('duplicate-input reports the second occurrence', () => {
    expect(checkTxStructure(rawTx([A, A], [pay(bob, 1)]))).toEqual({ code: 'duplicate-input', input: 1 });
    expect(checkTxStructure(rawTx([A, B, A2, B], [pay(bob, 1)]))).toEqual({ code: 'duplicate-input', input: 3 });
    expect(checkTxStructure(rawTx([A, B, A, A], [pay(bob, 1)]))).toEqual({ code: 'duplicate-input', input: 2 });
  });

  it('duplicate detection compares outpoints by value, not by object identity', () => {
    const copy: OutPoint = { txid: new Uint8Array(A.txid), index: A.index };
    expect(checkTxStructure(rawTx([A, copy], [pay(bob, 1)]))).toEqual({ code: 'duplicate-input', input: 1 });
  });

  it('same txid with a different index, or same index with a different txid, is not a duplicate', () => {
    const t = sha256d(utf8ToBytes('some tx'));
    const t2b = new Uint8Array(t);
    t2b[31] ^= 1;
    expect(
      checkTxStructure(
        rawTx(
          [
            { txid: t, index: 0 },
            { txid: t, index: 1 },
            { txid: t2b, index: 0 },
          ],
          [pay(bob, 1)],
        ),
      ),
    ).toBeNull();
  });

  it('output errors are reported before duplicate inputs; no-outputs before duplicates', () => {
    expect(checkTxStructure(rawTx([A, A], [pay(bob, 0)]))).toEqual({ code: 'invalid-output-value', output: 0 });
    expect(checkTxStructure(rawTx([A, A], [{ value: 1, address: 'x' }]))).toEqual({ code: 'invalid-address', output: 0 });
    expect(checkTxStructure(rawTx([A, A], []))).toEqual({ code: 'no-outputs' });
  });

  it('never throws on malformed outpoints (31-byte / empty txid, out-of-range index)', () => {
    const bad31: OutPoint = { txid: new Uint8Array(31), index: 0 };
    const tx = rawTx([bad31, { txid: new Uint8Array(0), index: -1 }, { txid: A.txid, index: 2 ** 32 }], [pay(bob, 1)]);
    expect(() => checkTxStructure(tx)).not.toThrow();
    expect(checkTxStructure(tx)).toBeNull();
    expect(checkTxStructure(rawTx([bad31, { txid: new Uint8Array(31), index: 0 }], [pay(bob, 1)]))).toEqual({
      code: 'duplicate-input',
      input: 1,
    });
  });

  it('does not mutate the tx', () => {
    const tx = rawTx([A, A], [pay(bob, 0)]);
    const before = snapAny(tx);
    checkTxStructure(tx);
    checkTxStructure(t1);
    expect(snapAny(tx)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// validateTransaction
// ---------------------------------------------------------------------------

describe('validateTransaction', () => {
  it('accepts a valid signed tx and returns the exact fee', () => {
    expect(validateTransaction(baseUtxos(), t1)).toEqual({ ok: true, fee: F1 });
    expect(validateTransaction(baseUtxos(), t3)).toEqual({ ok: true, fee: F3 });
  });

  it('multi-input fee = sum of spent values - sum of outputs', () => {
    const tx = spend(
      [
        [A, alice],
        [B, bob],
        [A2, alice],
      ],
      [pay(carol, 3_000_000_000), pay(bob, 400_000_000)],
    );
    expect(validateTransaction(baseUtxos(), tx)).toEqual({ ok: true, fee: 3_500_000_000 - 3_400_000_000 });
  });

  it('fee 0 (outputs exactly equal inputs) is valid', () => {
    const tx = spend(
      [
        [A, alice],
        [A2, alice],
      ],
      [pay(bob, 1_500_000_000)],
    );
    expect(validateTransaction(baseUtxos(), tx)).toEqual({ ok: true, fee: 0 });
  });

  it('overspend by exactly 1 fails with exact totals', () => {
    const tx = spend(
      [
        [A, alice],
        [A2, alice],
      ],
      [pay(bob, 1_000_000_000), pay(carol, 500_000_001)],
    );
    expect(validateTransaction(baseUtxos(), tx)).toEqual(
      txErr({ code: 'overspend', inputTotal: 1_500_000_000, outputTotal: 1_500_000_001 }),
    );
  });

  it('unexpected-coinbase for a coinbase, before any structure check', () => {
    expect(validateTransaction(baseUtxos(), cbOf())).toEqual(txErr({ code: 'unexpected-coinbase' }));
    expect(validateTransaction(baseUtxos(), coinbase(1, []))).toEqual(txErr({ code: 'unexpected-coinbase' }));
    expect(validateTransaction(baseUtxos(), coinbase(1, [{ value: -1, address: 'x' }]))).toEqual(
      txErr({ code: 'unexpected-coinbase' }),
    );
  });

  it('returns the structure error first (before existence / signatures)', () => {
    const u = baseUtxos();
    expect(validateTransaction(u, rawTx([], [pay(bob, 1)]))).toEqual(txErr({ code: 'no-inputs' }));
    expect(validateTransaction(u, rawTx([NOWHERE], []))).toEqual(txErr({ code: 'no-outputs' }));
    expect(validateTransaction(u, rawTx([NOWHERE], [pay(bob, 0)]))).toEqual(
      txErr({ code: 'invalid-output-value', output: 0 }),
    );
    expect(validateTransaction(u, rawTx([NOWHERE], [pay(bob, 1), { value: 1, address: 'zz' }]))).toEqual(
      txErr({ code: 'invalid-address', output: 1 }),
    );
    // signed, existing inputs, but duplicated -> duplicate-input (not overspend/bad-signature)
    const dup = spend(
      [
        [A, alice],
        [A, alice],
      ],
      [pay(bob, 1_900_000_000)],
    );
    expect(validateTransaction(u, dup)).toEqual(txErr({ code: 'duplicate-input', input: 1 }));
    // duplicate of a missing outpoint -> duplicate-input, not missing-input
    expect(validateTransaction(u, rawTx([NOWHERE, NOWHERE], [pay(bob, 1)]))).toEqual(
      txErr({ code: 'duplicate-input', input: 1 }),
    );
  });

  it('missing-input for an outpoint that never existed, with its index', () => {
    const u = baseUtxos();
    expect(validateTransaction(u, spend([[NOWHERE, alice]], [pay(bob, 1)]))).toEqual(
      txErr({ code: 'missing-input', input: 0 }),
    );
    const tx = spend(
      [
        [A, alice],
        [A2, alice],
        [{ txid: A.txid, index: 1 }, alice], // fundA has only output 0
      ],
      [pay(bob, 1)],
    );
    expect(validateTransaction(u, tx)).toEqual(txErr({ code: 'missing-input', input: 2 }));
  });

  it('missing-input for an output that was already spent', () => {
    const u = baseUtxos();
    u.applyTransactions([t1]); // spends A
    expect(validateTransaction(u, t1x)).toEqual(txErr({ code: 'missing-input', input: 0 }));
    expect(validateTransaction(u, t1)).toEqual(txErr({ code: 'missing-input', input: 0 }));
    // and t2, which spends t1's output, is now valid
    expect(validateTransaction(u, t2)).toEqual({ ok: true, fee: F2 });
  });

  it('all inputs are checked for existence before any signature', () => {
    // input 0 exists but has a bad signature, input 1 is missing -> missing-input(1)
    const good = spend(
      [
        [A, alice],
        [NOWHERE, alice],
      ],
      [pay(bob, 1)],
    );
    const tx: StandardTx = { ...good, inputs: [{ ...good.inputs[0], signature: new Uint8Array(64) }, good.inputs[1]] };
    expect(validateTransaction(baseUtxos(), tx)).toEqual(txErr({ code: 'missing-input', input: 1 }));
    // input 0 signed by the wrong key, input 1 missing -> missing-input(1)
    const wrong = spend(
      [
        [A, bob],
        [NOWHERE, alice],
      ],
      [pay(bob, 1)],
    );
    expect(validateTransaction(baseUtxos(), wrong)).toEqual(txErr({ code: 'missing-input', input: 1 }));
  });

  it('missing-input is reported for the first missing input', () => {
    const other: OutPoint = { txid: sha256d(utf8ToBytes('other')), index: 3 };
    const tx = spend(
      [
        [A, alice],
        [other, alice],
        [NOWHERE, alice],
      ],
      [pay(bob, 1)],
    );
    expect(validateTransaction(baseUtxos(), tx)).toEqual(txErr({ code: 'missing-input', input: 1 }));
  });

  it('wrong-public-key when the spender is not the owner (signed with their own valid key)', () => {
    const tx = spend([[A, bob]], [pay(bob, 1)]); // A belongs to alice
    expect(validateTransaction(baseUtxos(), tx)).toEqual(txErr({ code: 'wrong-public-key', input: 0 }));
  });

  it('wrong-public-key reported with the input index', () => {
    const tx = spend(
      [
        [A, alice],
        [B, alice], // B belongs to bob
      ],
      [pay(bob, 1)],
    );
    expect(validateTransaction(baseUtxos(), tx)).toEqual(txErr({ code: 'wrong-public-key', input: 1 }));
  });

  it("bad-signature: right public key, signature by someone else's key", () => {
    const byBob = spend([[A, bob]], [pay(bob, 1)]);
    const tx: StandardTx = { ...byBob, inputs: [{ ...byBob.inputs[0], publicKey: alice.publicKey }] };
    expect(validateTransaction(baseUtxos(), tx)).toEqual(txErr({ code: 'bad-signature', input: 0 }));
  });

  it('bad-signature: outputs changed after signing (signature is over txid)', () => {
    const tx: StandardTx = { ...t1, outputs: [pay(bob, 600_000_000), pay(carol, 390_000_000)] };
    expect(validateTransaction(baseUtxos(), tx)).toEqual(txErr({ code: 'bad-signature', input: 0 }));
    const lower: StandardTx = { ...t1, outputs: [pay(bob, 599_999_999), pay(alice, 390_000_000)] };
    expect(validateTransaction(baseUtxos(), lower)).toEqual(txErr({ code: 'bad-signature', input: 0 }));
  });

  it('bad-signature: signature valid for another tx (replayed)', () => {
    const other = spend([[A, alice]], [pay(carol, 1)]);
    const tx: StandardTx = { ...t1, inputs: [{ ...t1.inputs[0], signature: other.inputs[0].signature }] };
    expect(validateTransaction(baseUtxos(), tx)).toEqual(txErr({ code: 'bad-signature', input: 0 }));
  });

  it('bad-signature reported with the input index', () => {
    const good = spend(
      [
        [A, alice],
        [A2, alice],
      ],
      [pay(bob, 1)],
    );
    const tx: StandardTx = { ...good, inputs: [good.inputs[0], { ...good.inputs[1], signature: t1.inputs[0].signature }] };
    expect(validateTransaction(baseUtxos(), tx)).toEqual(txErr({ code: 'bad-signature', input: 1 }));
  });

  it('within one input, wrong-public-key is reported before bad-signature', () => {
    const tx = spend([[A, bob]], [pay(bob, 1)]);
    const broken: StandardTx = { ...tx, inputs: [{ ...tx.inputs[0], signature: new Uint8Array(64).fill(7) }] };
    expect(validateTransaction(baseUtxos(), broken)).toEqual(txErr({ code: 'wrong-public-key', input: 0 }));
  });

  it('authorization runs input by input: bad-signature(0) wins over wrong-public-key(1)', () => {
    const good = spend(
      [
        [A, alice],
        [B, alice],
      ],
      [pay(bob, 1)],
    );
    const tx: StandardTx = { ...good, inputs: [{ ...good.inputs[0], signature: new Uint8Array(64) }, good.inputs[1]] };
    expect(validateTransaction(baseUtxos(), tx)).toEqual(txErr({ code: 'bad-signature', input: 0 }));
  });

  it('authorization is checked before overspend', () => {
    const over = spend([[A, alice]], [pay(bob, 2_000_000_000)]);
    expect(validateTransaction(baseUtxos(), over)).toEqual(
      txErr({ code: 'overspend', inputTotal: 1_000_000_000, outputTotal: 2_000_000_000 }),
    );
    const overBadSig: StandardTx = { ...over, inputs: [{ ...over.inputs[0], signature: new Uint8Array(64) }] };
    expect(validateTransaction(baseUtxos(), overBadSig)).toEqual(txErr({ code: 'bad-signature', input: 0 }));
    const overWrongKey = spend([[A, bob]], [pay(bob, 2_000_000_000)]);
    expect(validateTransaction(baseUtxos(), overWrongKey)).toEqual(txErr({ code: 'wrong-public-key', input: 0 }));
  });

  it('existence is checked before overspend', () => {
    const tx = spend([[NOWHERE, alice]], [pay(bob, MAX_MONEY)]);
    expect(validateTransaction(baseUtxos(), tx)).toEqual(txErr({ code: 'missing-input', input: 0 }));
  });

  it('uses the values of the spent outputs from the UTXO set (not anything in the tx)', () => {
    const tx = spend([[A2, alice]], [pay(bob, 500_000_000)]);
    expect(validateTransaction(baseUtxos(), tx)).toEqual({ ok: true, fee: 0 });
    const tx2 = spend([[A2, alice]], [pay(bob, 500_000_001)]);
    expect(validateTransaction(baseUtxos(), tx2)).toEqual(
      txErr({ code: 'overspend', inputTotal: 500_000_000, outputTotal: 500_000_001 }),
    );
  });

  it('never returns spent-in-block (that code is only for validateBlock)', () => {
    const u = baseUtxos();
    u.applyTransactions([t1]);
    const r = validateTransaction(u, t1x);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('missing-input');
  });

  describe('never throws on malformed input', () => {
    const signedA = spend([[A, alice]], [pay(bob, 1)]);
    const cases: [string, () => StandardTx, TxError][] = [
      ['31-byte prevOut txid', () => rawTx([{ txid: new Uint8Array(31), index: 0 }], [pay(bob, 1)]), { code: 'missing-input', input: 0 }],
      ['33-byte prevOut txid', () => rawTx([{ txid: new Uint8Array(33), index: 0 }], [pay(bob, 1)]), { code: 'missing-input', input: 0 }],
      ['empty prevOut txid', () => rawTx([{ txid: new Uint8Array(0), index: 0 }], [pay(bob, 1)]), { code: 'missing-input', input: 0 }],
      ['negative prevOut index', () => rawTx([A, { txid: A.txid, index: -1 }], [pay(bob, 1)]), { code: 'missing-input', input: 1 }],
      ['prevOut index 2^32', () => rawTx([{ txid: A.txid, index: 2 ** 32 }], [pay(bob, 1)]), { code: 'missing-input', input: 0 }],
      ['fractional prevOut index', () => rawTx([{ txid: A.txid, index: 0.5 }], [pay(bob, 1)]), { code: 'missing-input', input: 0 }],
      ['NaN output value', () => rawTx([A], [pay(bob, Number.NaN)]), { code: 'invalid-output-value', output: 0 }],
      ['negative output value', () => rawTx([A], [pay(bob, 5), pay(bob, -5)]), { code: 'invalid-output-value', output: 1 }],
      ['fractional output value', () => rawTx([A], [pay(bob, 0.5)]), { code: 'invalid-output-value', output: 0 }],
      ['Infinity output value', () => rawTx([A], [pay(bob, Infinity)]), { code: 'invalid-output-value', output: 0 }],
      ['garbage address', () => rawTx([A], [{ value: 1, address: '0OIl+/' }]), { code: 'invalid-address', output: 0 }],
      ['empty public key', () => ({ ...signedA, inputs: [{ ...signedA.inputs[0], publicKey: new Uint8Array(0) }] }), { code: 'wrong-public-key', input: 0 }],
      ['300-byte public key', () => ({ ...signedA, inputs: [{ ...signedA.inputs[0], publicKey: new Uint8Array(300).fill(2) }] }), { code: 'wrong-public-key', input: 0 }],
      ['empty signature', () => ({ ...signedA, inputs: [{ ...signedA.inputs[0], signature: new Uint8Array(0) }] }), { code: 'bad-signature', input: 0 }],
      ['300-byte signature', () => ({ ...signedA, inputs: [{ ...signedA.inputs[0], signature: new Uint8Array(300).fill(9) }] }), { code: 'bad-signature', input: 0 }],
      ['all-0xff 64-byte signature', () => ({ ...signedA, inputs: [{ ...signedA.inputs[0], signature: new Uint8Array(64).fill(0xff) }] }), { code: 'bad-signature', input: 0 }],
    ];
    it.each(cases)('%s', (_name, make, expected) => {
      const tx = make();
      const u = baseUtxos();
      const r = noThrow(() => validateTransaction(u, tx));
      expect(r).toEqual(txErr(expected));
    });
  });

  it('does not mutate the UTXO set or the tx (valid and invalid)', () => {
    const u = baseUtxos();
    const before = snapUtxos(u);
    const txs: Transaction[] = [
      t1,
      t3,
      t1x,
      t2, // missing (t1 is not applied)
      spend([[A, bob]], [pay(bob, 1)]),
      spend([[A, alice]], [pay(bob, 2_000_000_000)]),
      cbOf(),
    ];
    const txSnaps = txs.map(snapAny);
    for (const tx of txs) validateTransaction(u, tx);
    expect(snapUtxos(u)).toEqual(before);
    expect(txs.map(snapAny)).toEqual(txSnaps);
    // and validating twice gives the same answer (nothing was consumed)
    expect(validateTransaction(u, t1)).toEqual({ ok: true, fee: F1 });
    expect(validateTransaction(u, t1x)).toEqual({ ok: true, fee: 100_000_000 });
  });
});

// ---------------------------------------------------------------------------
// validateBlock
// ---------------------------------------------------------------------------

describe('validateBlock: happy paths', () => {
  it('fixture sanity: a mined block meets T8, and the failPow helper does not meet its target', () => {
    const b = fullBlock([t1], F1);
    expect(meetsTarget(blockHash(b.header), T8)).toBe(true);
    const f = makeBlock([cbOf()], { target: T20, pow: 'fail' });
    expect(meetsTarget(blockHash(f.header), T20)).toBe(false);
  });

  it('accepts a coinbase-only block with fees 0', () => {
    expect(validateBlock(makeBlock([cbOf()]), ctxOf())).toEqual({ ok: true, fees: 0 });
  });

  it('accepts a full block and returns the sum of fees', () => {
    expect(validateBlock(fullBlock([t1, t3], F1 + F3), ctxOf())).toEqual({ ok: true, fees: F1 + F3 });
  });

  it('allows a later tx to spend an output created by an earlier tx in the same block', () => {
    expect(validateBlock(fullBlock([t1, t2], F1 + F2), ctxOf())).toEqual({ ok: true, fees: F1 + F2 });
    expect(validateBlock(fullBlock([t1, t3, t2], F1 + F2 + F3), ctxOf())).toEqual({ ok: true, fees: F1 + F2 + F3 });
  });

  it('a chain of three dependent txs in one block', () => {
    const t2b = spend([[op(t2, 0), carol]], [pay(alice, 590_000_000)]);
    const fees = F1 + F2 + 5_000_000;
    expect(validateBlock(fullBlock([t1, t2, t2b], fees), ctxOf())).toEqual({ ok: true, fees });
  });

  it('a coinbase claiming less than allowed is valid; fees still reports the full sum of fees', () => {
    expect(validateBlock(makeBlock([cbOf(1), t1, t3]), ctxOf())).toEqual({ ok: true, fees: F1 + F3 });
    expect(validateBlock(makeBlock([cbOf(BLOCK_SUBSIDY + F1 - 1), t1]), ctxOf())).toEqual({ ok: true, fees: F1 });
  });

  it('a coinbase with several outputs summing to exactly subsidy + fees is valid', () => {
    const cb = coinbase(HEIGHT, [pay(miner, BLOCK_SUBSIDY), pay(alice, F1 - 1), pay(bob, 1)]);
    expect(validateBlock(makeBlock([cb, t1]), ctxOf())).toEqual({ ok: true, fees: F1 });
  });

  it('a genesis-style block: ZERO_HASH parent at height 0', () => {
    const b = makeBlock([cbOf(BLOCK_SUBSIDY, 0)], { prevHash: ZERO_HASH });
    expect(validateBlock(b, ctxOf({ parentHash: new Uint8Array(32), height: 0, utxos: new UtxoSet() }))).toEqual({
      ok: true,
      fees: 0,
    });
  });

  it('a fee-0 tx is fine inside a block', () => {
    const zero = spend([[A2, alice]], [pay(bob, 500_000_000)]);
    expect(validateBlock(fullBlock([zero], 0), ctxOf())).toEqual({ ok: true, fees: 0 });
  });
});

describe('validateBlock: header rules', () => {
  const okTxs = (): Transaction[] => [cbOf(BLOCK_SUBSIDY + F1), t1];
  const unminedHeader = (over: Partial<BlockHeader>): Block => {
    const txs = okTxs();
    return {
      header: { prevHash: PARENT, merkleRoot: merkleRoot(txs.map(txid)), timestamp: 1_000, target: T8, nonce: 0, ...over },
      txs,
    };
  };

  it.each<[string, Partial<BlockHeader>]>([
    ['31-byte prevHash', { prevHash: new Uint8Array(31) }],
    ['33-byte prevHash', { prevHash: new Uint8Array(33) }],
    ['31-byte merkleRoot', { merkleRoot: new Uint8Array(31) }],
    ['empty merkleRoot', { merkleRoot: new Uint8Array(0) }],
    ['negative timestamp', { timestamp: -1 }],
    ['fractional timestamp', { timestamp: 1.5 }],
    ['NaN timestamp', { timestamp: Number.NaN }],
    ['unsafe timestamp', { timestamp: 2 ** 53 }],
    ['target 0', { target: 0n }],
    ['negative target', { target: -5n }],
    ['target 2^256', { target: 2n ** 256n }],
    ['negative nonce', { nonce: -1 }],
    ['nonce 2^32', { nonce: MAX_U32 + 1 }],
    ['fractional nonce', { nonce: 0.5 }],
    ['NaN nonce', { nonce: Number.NaN }],
  ])('malformed-header for %s (no throw)', (_name, over) => {
    const b = unminedHeader(over);
    const r = noThrow(() => validateBlock(b, ctxOf()));
    expect(r).toEqual(blkErr({ code: 'malformed-header' }));
  });

  it('nonce MAX_U32 and timestamp 0 are in range (not malformed)', () => {
    const r1 = validateBlock(unminedHeader({ nonce: MAX_U32, target: T20 }), ctxOf({ target: T20 }));
    // either PoW passes (astronomically unlikely) or bad-pow, but never malformed-header
    expect(r1.ok ? 'ok' : r1.error.code).not.toBe('malformed-header');
    const b = makeBlock(okTxs(), { timestamp: 0 });
    expect(validateBlock(b, ctxOf())).toEqual({ ok: true, fees: F1 });
  });

  it('malformed-header wins over every later header rule', () => {
    const b = unminedHeader({ nonce: -1, prevHash: sha256d(utf8ToBytes('elsewhere')), target: T20 });
    expect(validateBlock(b, ctxOf())).toEqual(blkErr({ code: 'malformed-header' }));
    const b2: Block = { header: { ...unminedHeader({ timestamp: -1 }).header }, txs: [] };
    expect(validateBlock(b2, ctxOf())).toEqual(blkErr({ code: 'malformed-header' }));
    // a 31-byte prevHash is also "not the parent", but malformed-header comes first
    expect(validateBlock(unminedHeader({ prevHash: PARENT.slice(0, 31) }), ctxOf())).toEqual(
      blkErr({ code: 'malformed-header' }),
    );
  });

  it('unknown-parent when prevHash differs from ctx.parentHash', () => {
    const b = makeBlock(okTxs(), { prevHash: sha256d(utf8ToBytes('some other block')) });
    expect(validateBlock(b, ctxOf())).toEqual(blkErr({ code: 'unknown-parent' }));
  });

  it('unknown-parent when prevHash differs in only the last byte', () => {
    const p = new Uint8Array(PARENT);
    p[31] ^= 0x01;
    expect(validateBlock(makeBlock(okTxs(), { prevHash: p }), ctxOf())).toEqual(blkErr({ code: 'unknown-parent' }));
    const q = new Uint8Array(PARENT);
    q[0] ^= 0x80;
    expect(validateBlock(makeBlock(okTxs(), { prevHash: q }), ctxOf())).toEqual(blkErr({ code: 'unknown-parent' }));
  });

  it('unknown-parent for a ZERO_HASH prevHash when a real parent is expected, and vice versa', () => {
    expect(validateBlock(makeBlock(okTxs(), { prevHash: ZERO_HASH }), ctxOf())).toEqual(blkErr({ code: 'unknown-parent' }));
    expect(validateBlock(makeBlock(okTxs()), ctxOf({ parentHash: ZERO_HASH }))).toEqual(blkErr({ code: 'unknown-parent' }));
  });

  it('unknown-parent wins over wrong-target and bad-pow', () => {
    const b = makeBlock(okTxs(), { prevHash: ZERO_HASH, target: T20, pow: 'fail' });
    expect(validateBlock(b, ctxOf())).toEqual(blkErr({ code: 'unknown-parent' }));
  });

  it('wrong-target when the header target is easier than the network target', () => {
    const easier = targetFromLeadingZeroBits(7);
    expect(validateBlock(makeBlock(okTxs(), { target: easier }), ctxOf())).toEqual(blkErr({ code: 'wrong-target' }));
  });

  it('wrong-target even when the header target is harder (must be equal exactly)', () => {
    const harder = targetFromLeadingZeroBits(9);
    const b = makeBlock(okTxs(), { target: harder });
    expect(meetsTarget(blockHash(b.header), T8)).toBe(true); // it would satisfy the network target
    expect(validateBlock(b, ctxOf())).toEqual(blkErr({ code: 'wrong-target' }));
    expect(validateBlock(makeBlock(okTxs(), { target: T8 - 1n }), ctxOf())).toEqual(blkErr({ code: 'wrong-target' }));
  });

  it('wrong-target wins over bad-pow', () => {
    const b = makeBlock(okTxs(), { target: T20, pow: 'fail' });
    expect(validateBlock(b, ctxOf())).toEqual(blkErr({ code: 'wrong-target' }));
  });

  it('bad-pow when the header hash does not meet the (correct) target', () => {
    const b = makeBlock(okTxs(), { target: T20, pow: 'fail' });
    expect(validateBlock(b, ctxOf({ target: T20 }))).toEqual(blkErr({ code: 'bad-pow' }));
  });

  it('bad-pow with target 1', () => {
    const txs = okTxs();
    const b: Block = {
      header: { prevHash: PARENT, merkleRoot: merkleRoot(txs.map(txid)), timestamp: 1_000, target: 1n, nonce: 12345 },
      txs,
    };
    expect(validateBlock(b, ctxOf({ target: 1n }))).toEqual(blkErr({ code: 'bad-pow' }));
  });

  it('bad-pow: a block mined for one header is invalid once a header field changes', () => {
    const b = makeBlock(okTxs(), { target: T20 });
    expect(validateBlock(b, ctxOf({ target: T20 }))).toEqual({ ok: true, fees: F1 });
    // bump timestamp until the hash no longer meets T20 (almost always the first try)
    let h = { ...b.header, timestamp: b.header.timestamp + 1 };
    while (meetsTarget(blockHash(h), T20)) h = { ...h, timestamp: h.timestamp + 1 };
    expect(validateBlock({ header: h, txs: b.txs }, ctxOf({ target: T20 }))).toEqual(blkErr({ code: 'bad-pow' }));
  });

  it('bad-pow wins over every transaction rule', () => {
    const empty = makeBlock([], { merkleRoot: ZERO_HASH, target: T20, pow: 'fail' });
    expect(validateBlock(empty, ctxOf({ target: T20 }))).toEqual(blkErr({ code: 'bad-pow' }));
    const noCb = makeBlock([t1], { target: T20, pow: 'fail' });
    expect(validateBlock(noCb, ctxOf({ target: T20 }))).toEqual(blkErr({ code: 'bad-pow' }));
    const badRoot = makeBlock(okTxs(), { merkleRoot: ZERO_HASH, target: T20, pow: 'fail' });
    expect(validateBlock(badRoot, ctxOf({ target: T20 }))).toEqual(blkErr({ code: 'bad-pow' }));
  });
});

describe('validateBlock: transaction rules', () => {
  it('no-transactions for an empty tx list (no throw)', () => {
    const b = makeBlock([], { merkleRoot: ZERO_HASH });
    const r = noThrow(() => validateBlock(b, ctxOf()));
    expect(r).toEqual(blkErr({ code: 'no-transactions' }));
  });

  it('first-tx-not-coinbase', () => {
    expect(validateBlock(makeBlock([t1]), ctxOf())).toEqual(blkErr({ code: 'first-tx-not-coinbase' }));
    expect(validateBlock(makeBlock([t1, t3]), ctxOf())).toEqual(blkErr({ code: 'first-tx-not-coinbase' }));
  });

  it('first-tx-not-coinbase wins over multiple-coinbase', () => {
    expect(validateBlock(makeBlock([t1, cbOf()]), ctxOf())).toEqual(blkErr({ code: 'first-tx-not-coinbase' }));
  });

  it('multiple-coinbase reports the first extra coinbase index', () => {
    expect(validateBlock(makeBlock([cbOf(), cbOf(1, HEIGHT + 1)]), ctxOf())).toEqual(
      blkErr({ code: 'multiple-coinbase', index: 1 }),
    );
    expect(validateBlock(makeBlock([cbOf(), t1, cbOf(5, 99), cbOf(6, 98)]), ctxOf())).toEqual(
      blkErr({ code: 'multiple-coinbase', index: 2 }),
    );
  });

  it('multiple-coinbase wins over bad-coinbase-height and over invalid txs', () => {
    expect(validateBlock(makeBlock([cbOf(BLOCK_SUBSIDY, HEIGHT + 3), cbOf()]), ctxOf())).toEqual(
      blkErr({ code: 'multiple-coinbase', index: 1 }),
    );
    const noIn = rawTx([], [pay(bob, 1)]);
    expect(validateBlock(makeBlock([cbOf(), noIn, cbOf(1, 50)]), ctxOf())).toEqual(
      blkErr({ code: 'multiple-coinbase', index: 2 }),
    );
  });

  it('bad-coinbase-height with exact expected / actual', () => {
    expect(validateBlock(makeBlock([cbOf(BLOCK_SUBSIDY, HEIGHT + 1)]), ctxOf())).toEqual(
      blkErr({ code: 'bad-coinbase-height', expected: HEIGHT, actual: HEIGHT + 1 }),
    );
    expect(validateBlock(makeBlock([cbOf(BLOCK_SUBSIDY, 0)]), ctxOf())).toEqual(
      blkErr({ code: 'bad-coinbase-height', expected: HEIGHT, actual: 0 }),
    );
    expect(validateBlock(makeBlock([cbOf(BLOCK_SUBSIDY, HEIGHT)]), ctxOf({ height: 3 }))).toEqual(
      blkErr({ code: 'bad-coinbase-height', expected: 3, actual: HEIGHT }),
    );
  });

  it('bad-coinbase-height wins over coinbase structure errors and every later rule', () => {
    const cb = coinbase(HEIGHT + 1, []);
    expect(validateBlock(makeBlock([cb]), ctxOf())).toEqual(
      blkErr({ code: 'bad-coinbase-height', expected: HEIGHT, actual: HEIGHT + 1 }),
    );
    const bad = makeBlock([cbOf(BLOCK_SUBSIDY * 3, HEIGHT - 1), t1x, t1], { merkleRoot: ZERO_HASH });
    expect(validateBlock(bad, ctxOf())).toEqual(blkErr({ code: 'bad-coinbase-height', expected: HEIGHT, actual: HEIGHT - 1 }));
  });

  it('invalid-tx(0, ...) for coinbase structure errors', () => {
    expect(validateBlock(makeBlock([coinbase(HEIGHT, [])]), ctxOf())).toEqual(invalidTx(0, { code: 'no-outputs' }));
    expect(validateBlock(makeBlock([cbOf(0)]), ctxOf())).toEqual(invalidTx(0, { code: 'invalid-output-value', output: 0 }));
    // structure (step 9) comes before coinbase-too-large (step 12)
    expect(validateBlock(makeBlock([cbOf(MAX_MONEY + 1)]), ctxOf())).toEqual(
      invalidTx(0, { code: 'invalid-output-value', output: 0 }),
    );
    expect(
      validateBlock(makeBlock([coinbase(HEIGHT, [pay(miner, MAX_MONEY), pay(miner, 1)])]), ctxOf()),
    ).toEqual(invalidTx(0, { code: 'invalid-output-value', output: 1 }));
  });

  it('invalid-tx(0, invalid-address) for a coinbase paying a garbage address (txid not computable, no throw)', () => {
    const cb = coinbase(HEIGHT, [pay(miner, 1), { value: 1, address: 'garbage' }]);
    const b = makeBlock([cb], { merkleRoot: ZERO_HASH });
    const r = noThrow(() => validateBlock(b, ctxOf()));
    expect(r).toEqual(invalidTx(0, { code: 'invalid-address', output: 1 }));
  });

  it('invalid-tx for standard tx structure errors, with the tx index', () => {
    expect(validateBlock(makeBlock([cbOf(), rawTx([], [pay(bob, 1)])]), ctxOf())).toEqual(
      invalidTx(1, { code: 'no-inputs' }),
    );
    const dup = spend(
      [
        [A2, alice],
        [A, alice],
        [A2, alice],
      ],
      [pay(bob, 1)],
    );
    expect(validateBlock(makeBlock([cbOf(), t3, dup]), ctxOf())).toEqual(invalidTx(2, { code: 'duplicate-input', input: 2 }));
    const nan = rawTx([A], [pay(bob, Number.NaN)]);
    expect(validateBlock(makeBlock([cbOf(), t3, nan], { merkleRoot: ZERO_HASH }), ctxOf())).toEqual(
      invalidTx(2, { code: 'invalid-output-value', output: 0 }),
    );
  });

  it('structure of every tx is checked before contextual validation of any tx', () => {
    // tx 1 spends a missing output (contextual), tx 2 is structurally invalid -> tx 2 reported
    const missing = spend([[NOWHERE, alice]], [pay(bob, 1)]);
    const dup = rawTx([B, B], [pay(bob, 1)]);
    expect(validateBlock(makeBlock([cbOf(), missing, dup]), ctxOf())).toEqual(invalidTx(2, { code: 'duplicate-input', input: 1 }));
  });

  it('structure errors win over a bad merkle root', () => {
    const dup = rawTx([B, B], [pay(bob, 1)]);
    expect(validateBlock(makeBlock([cbOf(), dup], { merkleRoot: merkleRoot([txid(cbOf())]) }), ctxOf())).toEqual(
      invalidTx(1, { code: 'duplicate-input', input: 1 }),
    );
  });

  it('bad-merkle-root when the header commits to different txs', () => {
    const b = makeBlock([cbOf(BLOCK_SUBSIDY + F3), t3], { merkleRoot: merkleRoot([cbOf(BLOCK_SUBSIDY + F1), t1].map(txid)) });
    expect(validateBlock(b, ctxOf())).toEqual(blkErr({ code: 'bad-merkle-root' }));
  });

  it('bad-merkle-root when txs are reordered', () => {
    const txs = [cbOf(BLOCK_SUBSIDY + F1 + F3), t1, t3];
    const b = makeBlock([txs[0], t3, t1], { merkleRoot: merkleRoot(txs.map(txid)) });
    expect(validateBlock(b, ctxOf())).toEqual(blkErr({ code: 'bad-merkle-root' }));
  });

  it('bad-merkle-root when a tx is dropped or added', () => {
    const txs = [cbOf(BLOCK_SUBSIDY + F1 + F3), t1, t3];
    const root = merkleRoot(txs.map(txid));
    expect(validateBlock(makeBlock(txs.slice(0, 2), { merkleRoot: root }), ctxOf())).toEqual(blkErr({ code: 'bad-merkle-root' }));
    // duplicating the last tx gives the same Bitcoin-style root for an odd count; use an even count
    const even = [cbOf(BLOCK_SUBSIDY + F1), t1];
    expect(validateBlock(makeBlock([...even, t3], { merkleRoot: merkleRoot(even.map(txid)) }), ctxOf())).toEqual(
      blkErr({ code: 'bad-merkle-root' }),
    );
  });

  it('bad-merkle-root when the coinbase is changed after the root was computed (not coinbase-too-large)', () => {
    const honest = [cbOf(BLOCK_SUBSIDY + F1), t1];
    const greedy = [cbOf(BLOCK_SUBSIDY * 2), t1];
    const b = makeBlock(greedy, { merkleRoot: merkleRoot(honest.map(txid)) });
    expect(validateBlock(b, ctxOf())).toEqual(blkErr({ code: 'bad-merkle-root' }));
  });

  it('bad-merkle-root wins over contextual tx errors', () => {
    const missing = spend([[NOWHERE, alice]], [pay(bob, 1)]);
    expect(validateBlock(makeBlock([cbOf(), missing], { merkleRoot: ZERO_HASH }), ctxOf())).toEqual(
      blkErr({ code: 'bad-merkle-root' }),
    );
  });

  it('the merkle root uses txid (witness-free): a tampered signature keeps the root valid and fails as bad-signature', () => {
    const forged: StandardTx = { ...t1, inputs: [{ ...t1.inputs[0], signature: t3.inputs[0].signature }] };
    expect(txid(forged)).toEqual(txid(t1));
    const b = makeBlock([cbOf(BLOCK_SUBSIDY + F1), forged]);
    expect(validateBlock(b, ctxOf())).toEqual(invalidTx(1, { code: 'bad-signature', input: 0 }));
  });

  it('a structurally fine tx whose txid cannot be computed (31-byte prevOut txid) gives an error result, not a throw', () => {
    const weird = rawTx([{ txid: new Uint8Array(31), index: 0 }], [pay(bob, 1)]);
    for (const merkle of [ZERO_HASH, merkleRoot([txid(cbOf())])]) {
      const b = makeBlock([cbOf(), weird], { merkleRoot: merkle });
      const r = noThrow(() => validateBlock(b, ctxOf()));
      expect(r.ok).toBe(false);
    }
    const negIndex = rawTx([{ txid: A.txid, index: -1 }], [pay(bob, 1)]);
    const b2 = makeBlock([cbOf(), negIndex], { merkleRoot: ZERO_HASH });
    expect(() => validateBlock(b2, ctxOf())).not.toThrow();
    expect(validateBlock(b2, ctxOf()).ok).toBe(false);
  });
});

describe('validateBlock: contextual tx validation', () => {
  it('a tx spending an output of a LATER tx in the block is missing-input', () => {
    expect(validateBlock(fullBlock([t2, t1], F1 + F2), ctxOf())).toEqual(invalidTx(1, { code: 'missing-input', input: 0 }));
  });

  it("the block's own coinbase outputs are not spendable in the same block", () => {
    const cb = cbOf(BLOCK_SUBSIDY);
    const spendCb = spend([[op(cb, 0), miner]], [pay(bob, COIN)]);
    expect(validateBlock(makeBlock([cb, spendCb]), ctxOf())).toEqual(invalidTx(1, { code: 'missing-input', input: 0 }));
  });

  it('spent-in-block when a later tx spends what an earlier tx of the block spent', () => {
    expect(validateBlock(fullBlock([t1, t1x], F1), ctxOf())).toEqual(invalidTx(2, { code: 'spent-in-block', input: 0 }));
    expect(validateBlock(fullBlock([t3, t1, t1x], F1 + F3), ctxOf())).toEqual(
      invalidTx(3, { code: 'spent-in-block', input: 0 }),
    );
  });

  it('spent-in-block reports the input index', () => {
    const tx = spend(
      [
        [A2, alice],
        [A, alice],
      ],
      [pay(carol, 1)],
    );
    expect(validateBlock(fullBlock([t1, tx], F1), ctxOf())).toEqual(invalidTx(2, { code: 'spent-in-block', input: 1 }));
  });

  it('spent-in-block for an output created AND spent earlier in the same block', () => {
    const t2x = spend([[op(t1, 0), bob]], [pay(alice, 1)]);
    expect(validateBlock(fullBlock([t1, t2, t2x], F1 + F2), ctxOf())).toEqual(
      invalidTx(3, { code: 'spent-in-block', input: 0 }),
    );
  });

  it('existence is checked input by input: the first failing input decides missing vs spent-in-block', () => {
    const missingFirst = spend(
      [
        [NOWHERE, alice],
        [A, alice],
      ],
      [pay(carol, 1)],
    );
    expect(validateBlock(fullBlock([t1, missingFirst], F1), ctxOf())).toEqual(
      invalidTx(2, { code: 'missing-input', input: 0 }),
    );
    const spentFirst = spend(
      [
        [A, alice],
        [NOWHERE, alice],
      ],
      [pay(carol, 1)],
    );
    expect(validateBlock(fullBlock([t1, spentFirst], F1), ctxOf())).toEqual(
      invalidTx(2, { code: 'spent-in-block', input: 0 }),
    );
  });

  it('missing-input (not spent-in-block) for an output already spent before this block', () => {
    const u = baseUtxos();
    u.applyTransactions([t1]); // A spent in an earlier block
    expect(validateBlock(fullBlock([t1x], 0), ctxOf({ utxos: u }))).toEqual(invalidTx(1, { code: 'missing-input', input: 0 }));
  });

  it('existence is checked for all inputs before signatures (spent-in-block beats an earlier bad key)', () => {
    const tx = spend(
      [
        [A2, bob], // wrong key
        [B, bob], // already spent by t3
      ],
      [pay(carol, 1)],
    );
    expect(validateBlock(fullBlock([t3, tx], F3), ctxOf())).toEqual(invalidTx(2, { code: 'spent-in-block', input: 1 }));
  });

  it('wrong-public-key wrapped as invalid-tx', () => {
    const tx = spend([[A, bob]], [pay(bob, 1)]);
    expect(validateBlock(makeBlock([cbOf(), t3, tx]), ctxOf())).toEqual(invalidTx(2, { code: 'wrong-public-key', input: 0 }));
  });

  it('wrong-public-key for an intra-block output spent by the wrong key', () => {
    const tx = spend([[op(t1, 0), alice]], [pay(alice, 1)]); // t1:0 belongs to bob
    expect(validateBlock(makeBlock([cbOf(), t1, tx]), ctxOf())).toEqual(invalidTx(2, { code: 'wrong-public-key', input: 0 }));
  });

  it('bad-signature wrapped as invalid-tx', () => {
    const tx: StandardTx = { ...t3, inputs: [{ ...t3.inputs[0], signature: new Uint8Array(64) }] };
    expect(validateBlock(makeBlock([cbOf(), t1, tx]), ctxOf())).toEqual(invalidTx(2, { code: 'bad-signature', input: 0 }));
  });

  it('overspend wrapped as invalid-tx, with exact totals', () => {
    const tx = spend([[A, alice]], [pay(bob, 1_000_000_001)]);
    expect(validateBlock(makeBlock([cbOf(), tx]), ctxOf())).toEqual(
      invalidTx(1, { code: 'overspend', inputTotal: 1_000_000_000, outputTotal: 1_000_000_001 }),
    );
  });

  it('overspend of an intra-block output uses that output value', () => {
    const tx = spend([[op(t1, 0), bob]], [pay(carol, 600_000_001)]);
    expect(validateBlock(makeBlock([cbOf(), t1, tx]), ctxOf())).toEqual(
      invalidTx(2, { code: 'overspend', inputTotal: 600_000_000, outputTotal: 600_000_001 }),
    );
    // spending exactly its value is fine
    const exact = spend([[op(t1, 0), bob]], [pay(carol, 600_000_000)]);
    expect(validateBlock(fullBlock([t1, exact], F1), ctxOf())).toEqual({ ok: true, fees: F1 });
  });

  it('mixing an intra-block output and a ctx.utxos output in one tx', () => {
    const tx = spend(
      [
        [op(t1, 1), alice], // 390_000_000 created by t1
        [A2, alice], // 500_000_000 from ctx.utxos
      ],
      [pay(carol, 880_000_000)],
    );
    expect(validateBlock(fullBlock([t1, tx], F1 + 10_000_000), ctxOf())).toEqual({ ok: true, fees: F1 + 10_000_000 });
  });

  it('the first invalid tx (by index) is reported', () => {
    const over = spend([[A, alice]], [pay(bob, 1_000_000_001)]);
    const missing = spend([[NOWHERE, alice]], [pay(bob, 1)]);
    expect(validateBlock(makeBlock([cbOf(), t3, over, missing]), ctxOf())).toEqual(
      invalidTx(2, { code: 'overspend', inputTotal: 1_000_000_000, outputTotal: 1_000_000_001 }),
    );
  });

  it('contextual tx errors win over coinbase-too-large', () => {
    const missing = spend([[NOWHERE, alice]], [pay(bob, 1)]);
    expect(validateBlock(makeBlock([cbOf(BLOCK_SUBSIDY * 10), missing]), ctxOf())).toEqual(
      invalidTx(1, { code: 'missing-input', input: 0 }),
    );
  });

  it('a tx spending an output that exists neither in ctx.utxos nor earlier in the block is missing-input', () => {
    expect(validateBlock(fullBlock([t2], F2), ctxOf())).toEqual(invalidTx(1, { code: 'missing-input', input: 0 }));
  });
});

describe('validateBlock: coinbase value', () => {
  it('coinbase-too-large with exact claimed/allowed (coinbase only)', () => {
    expect(validateBlock(makeBlock([cbOf(BLOCK_SUBSIDY + 1)]), ctxOf())).toEqual(
      blkErr({ code: 'coinbase-too-large', claimed: BLOCK_SUBSIDY + 1, allowed: BLOCK_SUBSIDY }),
    );
  });

  it('coinbase-too-large by 1 with fees', () => {
    const fees = F1 + F2 + F3;
    expect(validateBlock(makeBlock([cbOf(BLOCK_SUBSIDY + fees + 1), t1, t2, t3]), ctxOf())).toEqual(
      blkErr({ code: 'coinbase-too-large', claimed: BLOCK_SUBSIDY + fees + 1, allowed: BLOCK_SUBSIDY + fees }),
    );
  });

  it('claimed sums all coinbase outputs', () => {
    const cb = coinbase(HEIGHT, [pay(miner, BLOCK_SUBSIDY), pay(alice, F1), pay(bob, 1)]);
    expect(validateBlock(makeBlock([cb, t1]), ctxOf())).toEqual(
      blkErr({ code: 'coinbase-too-large', claimed: BLOCK_SUBSIDY + F1 + 1, allowed: BLOCK_SUBSIDY + F1 }),
    );
  });

  it('claiming exactly subsidy + fees is valid', () => {
    expect(validateBlock(makeBlock([cbOf(BLOCK_SUBSIDY + F1 + F3), t1, t3]), ctxOf())).toEqual({ ok: true, fees: F1 + F3 });
  });
});

describe('validateBlock: purity', () => {
  it('never modifies ctx.utxos or the block (valid and invalid blocks with intra-block spends)', () => {
    const ctx = ctxOf();
    const before = snapUtxos(ctx.utxos);
    const blocks = [
      fullBlock([t1, t2, t3], F1 + F2 + F3),
      fullBlock([t1, t3, t1x], F1 + F3), // fails at the last tx after earlier ones "applied"
      fullBlock([t1, spend([[op(t1, 0), bob]], [pay(carol, 600_000_001)])], F1),
      makeBlock([cbOf(BLOCK_SUBSIDY + F1 + 1), t1]),
    ];
    const blockSnaps = blocks.map(snapAny);
    const results = blocks.map((b) => validateBlock(b, ctx));
    expect(results[0]).toEqual({ ok: true, fees: F1 + F2 + F3 });
    expect(results.slice(1).every((r) => !r.ok)).toBe(true);
    expect(snapUtxos(ctx.utxos)).toEqual(before);
    expect(blocks.map(snapAny)).toEqual(blockSnaps);
    // repeatable: nothing was consumed by the first run
    expect(blocks.map((b) => validateBlock(b, ctx))).toEqual(results);
    expect(snapUtxos(ctx.utxos)).toEqual(before);
  });

  it('does not modify ctx.parentHash', () => {
    const ctx = ctxOf();
    const p = bytesToHex(ctx.parentHash);
    validateBlock(fullBlock([t1], F1), ctx);
    validateBlock(makeBlock([cbOf()], { prevHash: ZERO_HASH }), ctx);
    expect(bytesToHex(ctx.parentHash)).toBe(p);
  });
});

// ---------------------------------------------------------------------------
// describe*Error
// ---------------------------------------------------------------------------

describe('describeTxError / describeBlockError', () => {
  const txErrors: TxError[] = [
    { code: 'unexpected-coinbase' },
    { code: 'no-inputs' },
    { code: 'no-outputs' },
    { code: 'invalid-output-value', output: 2 },
    { code: 'invalid-address', output: 1 },
    { code: 'duplicate-input', input: 1 },
    { code: 'spent-in-block', input: 0 },
    { code: 'missing-input', input: 3 },
    { code: 'wrong-public-key', input: 0 },
    { code: 'bad-signature', input: 0 },
    { code: 'overspend', inputTotal: 10, outputTotal: 11 },
  ];
  const blockErrors: BlockError[] = [
    { code: 'malformed-header' },
    { code: 'unknown-parent' },
    { code: 'wrong-target' },
    { code: 'bad-pow' },
    { code: 'no-transactions' },
    { code: 'first-tx-not-coinbase' },
    { code: 'multiple-coinbase', index: 2 },
    { code: 'bad-coinbase-height', expected: 3, actual: 4 },
    ...txErrors.map((error, index): BlockError => ({ code: 'invalid-tx', index, error })),
    { code: 'bad-merkle-root' },
    { code: 'coinbase-too-large', claimed: 11, allowed: 10 },
  ];

  it.each(txErrors.map((e) => [e.code, e] as const))('describeTxError(%s) is a non-empty string', (_c, e) => {
    const s = describeTxError(e);
    expect(typeof s).toBe('string');
    expect(s.trim().length).toBeGreaterThan(0);
  });

  it.each(blockErrors.map((e) => [e.code, e] as const))('describeBlockError(%s) is a non-empty string', (_c, e) => {
    const s = describeBlockError(e);
    expect(typeof s).toBe('string');
    expect(s.trim().length).toBeGreaterThan(0);
  });

  it('covers every code', () => {
    expect(new Set(txErrors.map((e) => e.code)).size).toBe(11);
    expect(new Set(blockErrors.map((e) => e.code)).size).toBe(11);
  });
});
