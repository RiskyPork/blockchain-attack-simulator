import { describe, expect, it } from 'vitest';
import { type Block, ZERO_HASH, targetFromLeadingZeroBits } from './block';
import { bytesToHex, hexToBytes, sha256d, utf8ToBytes } from './hash';
import { type KeyPair, keyPairFromPrivate } from './keys';
import { merkleRoot } from './merkle';
import {
  COIN,
  type CoinbaseTx,
  type OutPoint,
  type StandardTx,
  type Transaction,
  type TxOutput,
  createCoinbase,
  outPointKey,
  signTransaction,
  txid,
} from './transaction';
import { type BlockUndo, type Utxo, UtxoSet, txFee } from './utxo';
import { Rng } from '../network/rng';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const keyN = (n: number): KeyPair => keyPairFromPrivate(hexToBytes(n.toString(16).padStart(64, '0')));

// Fixed keys for reproducibility.
const alice = keyPairFromPrivate(hexToBytes('18e14a7b6a307f426a94f8114701e7c8e774e7f9a47e2c2035db29a206321725'));
const bob = keyN(1);
const carol = keyN(2);
const dave = keyN(3);

/** A block around `txs` with a correct merkle root (UtxoSet does not check headers anyway). */
const mkBlock = (txs: Transaction[]): Block => ({
  header: {
    prevHash: ZERO_HASH,
    merkleRoot: merkleRoot(txs.map(txid)),
    timestamp: 1_000,
    target: targetFromLeadingZeroBits(1),
    nonce: 0,
  },
  txs,
});

const cb = (height: number, who: KeyPair, value = 50 * COIN): CoinbaseTx => createCoinbase(height, who.address, value);

const op = (tx: Transaction, index: number): OutPoint => ({ txid: txid(tx), index });

const pay = (to: KeyPair, value: number): TxOutput => ({ value, address: to.address });

/** Properly signed spend. */
const spend = (inputs: [OutPoint, KeyPair][], outputs: TxOutput[]): StandardTx =>
  signTransaction(
    inputs.map(([prevOut, key]) => ({ prevOut, key })),
    outputs,
  );

/** Unsigned standard tx (empty witnesses): UtxoSet only does outpoint bookkeeping. */
const rawTx = (prevOuts: OutPoint[], outputs: TxOutput[]): StandardTx => ({
  kind: 'standard',
  inputs: prevOuts.map((prevOut) => ({ prevOut, publicKey: new Uint8Array(), signature: new Uint8Array() })),
  outputs,
});

const utxoKey = (u: Utxo): string => `${outPointKey(u.outPoint)}|${u.output.value}|${u.output.address}`;

/** Canonical snapshot of the whole set (sorted keys + values), with internal-consistency checks. */
function snap(s: UtxoSet): string[] {
  const all = s.all();
  expect(s.size).toBe(all.length);
  for (const u of all) {
    expect(s.has(u.outPoint)).toBe(true);
    expect(s.get(u.outPoint)).toEqual(u.output);
  }
  const keys = all.map(utxoKey).sort();
  expect(new Set(keys.map((k) => k.split('|')[0])).size).toBe(keys.length); // no duplicate outpoints
  return keys;
}

const undoKeys = (u: BlockUndo): string[] => u.spent.map(utxoKey).sort();

const expectedKeys = (...entries: [Transaction, number][]): string[] =>
  entries
    .map(([tx, i]) => utxoKey({ outPoint: op(tx, i), output: tx.outputs[i] }))
    .sort();

/** Expects `f` to throw and the set to be exactly as before. */
function expectThrowsAtomically(s: UtxoSet, f: () => unknown): void {
  const before = snap(s);
  expect(f).toThrow();
  expect(snap(s)).toEqual(before);
}

// A small standard history used by many tests:
//   b1: coinbase -> alice 50
//   b2: coinbase -> bob 50; alice pays carol 30, change 19.99 to herself (fee 0.01... = 1000 units)
const cb1 = cb(1, alice);
const b1 = mkBlock([cb1]);
const cb2 = cb(2, bob);
const t2 = spend([[op(cb1, 0), alice]], [pay(carol, 30 * COIN), pay(alice, 20 * COIN - 1000)]);
const b2 = mkBlock([cb2, t2]);

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

describe('empty UtxoSet', () => {
  it('has nothing', () => {
    const s = new UtxoSet();
    expect(s.size).toBe(0);
    expect(s.all()).toEqual([]);
    expect(s.has(op(cb1, 0))).toBe(false);
    expect(s.get(op(cb1, 0))).toBeUndefined();
    expect(s.utxosOf(alice.address)).toEqual([]);
    expect(s.balanceOf(alice.address)).toBe(0);
  });
});

describe('applyBlock', () => {
  it('a coinbase-only block funds the miner', () => {
    const s = new UtxoSet();
    const u = s.applyBlock(b1);
    expect(u.spent).toEqual([]);
    expect(s.size).toBe(1);
    expect(s.has(op(cb1, 0))).toBe(true);
    expect(s.get(op(cb1, 0))).toEqual({ value: 50 * COIN, address: alice.address });
    expect(s.balanceOf(alice.address)).toBe(50 * COIN);
    expect(s.balanceOf(bob.address)).toBe(0);
    const mine = s.utxosOf(alice.address);
    expect(mine).toHaveLength(1);
    expect(bytesToHex(mine[0].outPoint.txid)).toBe(bytesToHex(txid(cb1)));
    expect(mine[0].outPoint.index).toBe(0);
    expect(mine[0].output).toEqual({ value: 50 * COIN, address: alice.address });
    expect(snap(s)).toEqual(expectedKeys([cb1, 0]));
  });

  it('a coinbase with several outputs adds each at its own index', () => {
    const multi: CoinbaseTx = {
      kind: 'coinbase',
      height: 5,
      outputs: [pay(alice, 10), pay(bob, 20), pay(alice, 30)],
    };
    const s = new UtxoSet();
    s.applyBlock(mkBlock([multi]));
    expect(snap(s)).toEqual(expectedKeys([multi, 0], [multi, 1], [multi, 2]));
    expect(s.get(op(multi, 1))).toEqual(pay(bob, 20));
    expect(s.has(op(multi, 3))).toBe(false);
    expect(s.balanceOf(alice.address)).toBe(40);
    expect(s.balanceOf(bob.address)).toBe(20);
  });

  it('spending removes the input and adds every output, including change', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    const u = s.applyBlock(b2);
    expect(s.has(op(cb1, 0))).toBe(false);
    expect(s.get(op(cb1, 0))).toBeUndefined();
    expect(snap(s)).toEqual(expectedKeys([cb2, 0], [t2, 0], [t2, 1]));
    expect(s.size).toBe(3);
    expect(s.balanceOf(alice.address)).toBe(20 * COIN - 1000);
    expect(s.balanceOf(bob.address)).toBe(50 * COIN);
    expect(s.balanceOf(carol.address)).toBe(30 * COIN);
    expect(s.balanceOf(dave.address)).toBe(0);
    // Undo data: exactly the one output removed, with its full output.
    expect(u.spent).toHaveLength(1);
    expect(undoKeys(u)).toEqual(expectedKeys([cb1, 0]));
  });

  it('handles several inputs from different owners in one tx', () => {
    const cbA = cb(1, alice);
    const cbB = cb(2, bob, 7 * COIN);
    const joint = spend(
      [
        [op(cbA, 0), alice],
        [op(cbB, 0), bob],
      ],
      [pay(dave, 56 * COIN), pay(alice, COIN - 10)],
    );
    const s = new UtxoSet();
    s.applyBlock(mkBlock([cbA]));
    s.applyBlock(mkBlock([cbB]));
    const u = s.applyBlock(mkBlock([cb(3, carol), joint]));
    expect(undoKeys(u)).toEqual(expectedKeys([cbA, 0], [cbB, 0]));
    expect(snap(s)).toEqual(expectedKeys([cb(3, carol), 0], [joint, 0], [joint, 1]));
    expect(s.balanceOf(dave.address)).toBe(56 * COIN);
    expect(s.balanceOf(alice.address)).toBe(COIN - 10);
    expect(s.balanceOf(bob.address)).toBe(0);
  });

  it('a later tx may spend an output created earlier in the same block', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    const tA = spend([[op(cb1, 0), alice]], [pay(bob, 40 * COIN), pay(alice, 10 * COIN)]);
    const tB = spend([[op(tA, 0), bob]], [pay(carol, 39 * COIN)]);
    const cb3 = cb(2, dave);
    const tC = spend([[op(cb3, 0), dave]], [pay(dave, 50 * COIN)]); // spends this block's own coinbase
    const u = s.applyBlock(mkBlock([cb3, tA, tB, tC]));
    expect(snap(s)).toEqual(expectedKeys([tA, 1], [tB, 0], [tC, 0]));
    expect(s.has(op(tA, 0))).toBe(false);
    expect(s.has(op(cb3, 0))).toBe(false);
    expect(undoKeys(u)).toEqual(expectedKeys([cb1, 0], [tA, 0], [cb3, 0]));
    expect(s.balanceOf(carol.address)).toBe(39 * COIN);
    expect(s.balanceOf(bob.address)).toBe(0);
  });

  it('order matters: spending an output created LATER in the block throws (atomically)', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    const tA = spend([[op(cb1, 0), alice]], [pay(bob, 50 * COIN)]);
    const tB = spend([[op(tA, 0), bob]], [pay(carol, 50 * COIN)]);
    expectThrowsAtomically(s, () => s.applyBlock(mkBlock([cb(2, dave), tB, tA])));
    expect(snap(s)).toEqual(expectedKeys([cb1, 0]));
  });

  it('double spend across blocks throws and leaves the set unchanged', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    s.applyBlock(b2);
    const again = spend([[op(cb1, 0), alice]], [pay(dave, 50 * COIN)]);
    expectThrowsAtomically(s, () => s.applyBlock(mkBlock([cb(3, dave), again])));
    expect(snap(s)).toEqual(expectedKeys([cb2, 0], [t2, 0], [t2, 1]));
  });

  it('double spend within one block (two txs) throws atomically', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    const first = spend([[op(cb1, 0), alice]], [pay(bob, 50 * COIN)]);
    const second = spend([[op(cb1, 0), alice]], [pay(carol, 50 * COIN)]);
    expectThrowsAtomically(s, () => s.applyBlock(mkBlock([cb(2, dave), first, second])));
    expect(snap(s)).toEqual(expectedKeys([cb1, 0]));
  });

  it('the same outpoint twice in one tx throws atomically', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    const twice = rawTx([op(cb1, 0), op(cb1, 0)], [pay(bob, 100 * COIN)]);
    expectThrowsAtomically(s, () => s.applyBlock(mkBlock([cb(2, dave), twice])));
  });

  it('an unknown input throws atomically, even after valid txs in the same block', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    s.applyBlock(mkBlock([cb(2, bob)]));
    const valid = spend([[op(cb1, 0), alice]], [pay(carol, 50 * COIN)]);
    const ghostTxid = rawTx([{ txid: sha256d(utf8ToBytes('no such tx')), index: 0 }], [pay(dave, 1)]);
    const wrongIndex = rawTx([op(cb(2, bob), 1)], [pay(dave, 1)]); // tx exists, index doesn't
    const ok = mkBlock([cb(3, dave), valid]);

    expectThrowsAtomically(s, () => s.applyBlock(mkBlock([cb(3, dave), valid, ghostTxid])));
    expectThrowsAtomically(s, () => s.applyBlock(mkBlock([cb(3, dave), valid, wrongIndex])));
    expectThrowsAtomically(s, () => s.applyBlock(mkBlock([ghostTxid])));
    // The set is still fully usable afterwards.
    s.applyBlock(ok);
    expect(s.balanceOf(carol.address)).toBe(50 * COIN);
    expect(s.balanceOf(dave.address)).toBe(50 * COIN);
  });

  it('applying the same block twice throws atomically', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    expectThrowsAtomically(s, () => s.applyBlock(b1)); // coinbase outpoint already exists
    s.applyBlock(b2);
    expectThrowsAtomically(s, () => s.applyBlock(b2));
  });

  it('creating an outpoint that already exists throws atomically', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    // Different block, but the coinbase is identical (same height/address/value), so same txid
    // as cb1, whose output is still unspent. The first (valid) coinbase must be rolled back.
    expectThrowsAtomically(s, () => s.applyBlock(mkBlock([cb(2, bob), cb(1, alice)])));
    // Two identical coinbases inside one block.
    const s2 = new UtxoSet();
    expectThrowsAtomically(s2, () => s2.applyBlock(mkBlock([cb(9, dave), cb(9, dave)])));
    expect(s2.size).toBe(0);
  });

  it('re-creating an outpoint that was already spent is allowed (only current membership matters)', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    s.applyBlock(b2); // cb1:0 now spent
    s.applyBlock(mkBlock([cb(1, alice)])); // recreates cb1:0 (not present at that moment)
    expect(s.has(op(cb1, 0))).toBe(true);
  });

  it('does not check signatures, values, merkle root or PoW', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    // Unsigned, and creates more value than it spends.
    const bogus = rawTx([op(cb1, 0)], [pay(bob, 1000 * COIN)]);
    const block: Block = {
      header: { ...mkBlock([cb1]).header, merkleRoot: sha256d(utf8ToBytes('wrong')), target: 1n },
      txs: [cb(2, dave, 999 * COIN), bogus],
    };
    expect(() => s.applyBlock(block)).not.toThrow();
    expect(s.balanceOf(bob.address)).toBe(1000 * COIN);
    expect(s.balanceOf(dave.address)).toBe(999 * COIN);
  });
});

// ---------------------------------------------------------------------------
// undoBlock
// ---------------------------------------------------------------------------

describe('undoBlock', () => {
  it('is the exact inverse of applyBlock for one block', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    const before = snap(s);
    const u = s.applyBlock(b2);
    s.undoBlock(b2, u);
    expect(snap(s)).toEqual(before);
    expect(s.get(op(cb1, 0))).toEqual({ value: 50 * COIN, address: alice.address });
    expect(s.balanceOf(alice.address)).toBe(50 * COIN);
    expect(s.balanceOf(carol.address)).toBe(0);
    // And the block can be applied again afterwards.
    s.applyBlock(b2);
    expect(snap(s)).toEqual(expectedKeys([cb2, 0], [t2, 0], [t2, 1]));
  });

  it('undoing the first block returns to an empty set', () => {
    const s = new UtxoSet();
    const u = s.applyBlock(b1);
    s.undoBlock(b1, u);
    expect(s.size).toBe(0);
    expect(s.all()).toEqual([]);
    expect(s.balanceOf(alice.address)).toBe(0);
  });

  it('restores exactly the pre-block state for a block with intra-block spends', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    s.applyBlock(mkBlock([cb(2, bob)]));
    const before = snap(s);
    const tA = spend([[op(cb1, 0), alice]], [pay(bob, 40 * COIN), pay(alice, 10 * COIN)]);
    const tB = spend(
      [
        [op(tA, 0), bob],
        [op(cb(2, bob), 0), bob],
      ],
      [pay(carol, 90 * COIN)],
    );
    const tC = spend([[op(tB, 0), carol]], [pay(dave, 45 * COIN), pay(carol, 45 * COIN)]);
    const blk = mkBlock([cb(3, dave), tA, tB, tC]);
    const u = s.applyBlock(blk);
    expect(snap(s)).toEqual(expectedKeys([cb(3, dave), 0], [tA, 1], [tC, 0], [tC, 1]));
    s.undoBlock(blk, u);
    // tA:0 and tB:0 were created AND spent in this block: they must not reappear.
    expect(s.has(op(tA, 0))).toBe(false);
    expect(s.has(op(tB, 0))).toBe(false);
    expect(snap(s)).toEqual(before);
  });

  it('several blocks undone in reverse order revisit every intermediate state', () => {
    const s = new UtxoSet();
    const t3 = spend([[op(t2, 0), carol]], [pay(dave, 10 * COIN), pay(carol, 20 * COIN)]);
    const t4 = spend(
      [
        [op(t3, 1), carol],
        [op(cb2, 0), bob],
      ],
      [pay(alice, 69 * COIN)],
    );
    const chain = [b1, b2, mkBlock([cb(3, carol), t3]), mkBlock([cb(4, alice), t4])];
    const snaps = [snap(s)];
    const undos: BlockUndo[] = [];
    for (const b of chain) {
      undos.push(s.applyBlock(b));
      snaps.push(snap(s));
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      s.undoBlock(chain[i], undos[i]);
      expect(snap(s)).toEqual(snaps[i]);
    }
    expect(s.size).toBe(0);
  });

  it('throws atomically when the block is not the tip', () => {
    // b1' creates cb1':0, tX:0, tX:1; the next block spends only tX:0.
    const s = new UtxoSet();
    const base = mkBlock([cb(0, dave)]);
    s.applyBlock(base);
    const cbA = cb(1, bob);
    const tX = spend([[op(cb(0, dave), 0), dave]], [pay(carol, 20 * COIN), pay(dave, 30 * COIN)]);
    const blockA = mkBlock([cbA, tX]);
    const uA = s.applyBlock(blockA);
    const tY = spend([[op(tX, 0), carol]], [pay(alice, 20 * COIN)]);
    const blockB = mkBlock([cb(2, alice), tY]);
    const uB = s.applyBlock(blockB);

    // blockA is not the tip: tX:0 is gone, so undo must refuse and change nothing
    // (no partial removal of cbA:0 / tX:1, no restoring of dave's coinbase).
    expectThrowsAtomically(s, () => s.undoBlock(blockA, uA));
    expect(s.has(op(cbA, 0))).toBe(true);
    expect(s.has(op(tX, 1))).toBe(true);
    expect(s.has(op(cb(0, dave), 0))).toBe(false);

    // Proper order works.
    s.undoBlock(blockB, uB);
    s.undoBlock(blockA, uA);
    expect(snap(s)).toEqual(expectedKeys([cb(0, dave), 0]));
  });

  it('throws atomically when undoing a block twice or a block never applied', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    const u2 = s.applyBlock(b2);
    s.undoBlock(b2, u2);
    expectThrowsAtomically(s, () => s.undoBlock(b2, u2));

    const never = mkBlock([cb(77, dave)]);
    expectThrowsAtomically(s, () => s.undoBlock(never, { spent: [] }));
    expect(snap(s)).toEqual(expectedKeys([cb1, 0]));
  });
});

// ---------------------------------------------------------------------------
// Lookups by value, balances, clone
// ---------------------------------------------------------------------------

describe('has / get compare outpoints by value', () => {
  it('a different Uint8Array with the same bytes is the same outpoint', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    s.applyBlock(b2);
    const copy = new Uint8Array(txid(t2)); // fresh buffer
    expect(s.has({ txid: copy, index: 1 })).toBe(true);
    expect(s.get({ txid: Uint8Array.from(copy), index: 1 })).toEqual(pay(alice, 20 * COIN - 1000));
    expect(s.get({ txid: hexToBytes(bytesToHex(txid(t2))), index: 0 })).toEqual(pay(carol, 30 * COIN));
  });

  it('a different index or a different byte is a different outpoint', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    expect(s.has({ txid: txid(cb1), index: 1 })).toBe(false);
    const flipped = new Uint8Array(txid(cb1));
    flipped[31] ^= 1;
    expect(s.has({ txid: flipped, index: 0 })).toBe(false);
    expect(s.get({ txid: flipped, index: 0 })).toBeUndefined();
  });

  it('spending works with an input whose txid is a separate copy', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    const t = rawTx([{ txid: new Uint8Array(txid(cb1)), index: 0 }], [pay(bob, 50 * COIN)]);
    s.applyBlock(mkBlock([cb(2, dave), t]));
    expect(s.has(op(cb1, 0))).toBe(false);
    expect(s.balanceOf(bob.address)).toBe(50 * COIN);
  });
});

describe('utxosOf / balanceOf', () => {
  it('lists exactly the address’s outputs and sums them', () => {
    const multi: CoinbaseTx = {
      kind: 'coinbase',
      height: 1,
      outputs: [pay(alice, 5), pay(bob, 7), pay(alice, 11), pay(carol, 13)],
    };
    const s = new UtxoSet();
    s.applyBlock(mkBlock([multi]));
    s.applyBlock(mkBlock([cb(2, alice, 17)]));
    const mine = s.utxosOf(alice.address);
    expect(mine.map(utxoKey).sort()).toEqual(expectedKeys([multi, 0], [multi, 2], [cb(2, alice, 17), 0]));
    for (const u of mine) expect(u.output.address).toBe(alice.address);
    expect(s.balanceOf(alice.address)).toBe(5 + 11 + 17);
    expect(s.balanceOf(bob.address)).toBe(7);
    expect(s.balanceOf(carol.address)).toBe(13);
    expect(s.utxosOf(dave.address)).toEqual([]);
    expect(s.balanceOf(dave.address)).toBe(0);
  });

  it('track spends and undos', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    const u = s.applyBlock(b2);
    expect(s.utxosOf(alice.address).map(utxoKey)).toEqual(expectedKeys([t2, 1]));
    s.undoBlock(b2, u);
    expect(s.utxosOf(alice.address).map(utxoKey)).toEqual(expectedKeys([cb1, 0]));
    expect(s.utxosOf(carol.address)).toEqual([]);
  });
});

describe('clone', () => {
  it('starts equal and is fully independent in both directions', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    const c = s.clone();
    expect(snap(c)).toEqual(snap(s));

    // Apply on clone: original untouched.
    const u2 = c.applyBlock(b2);
    expect(snap(s)).toEqual(expectedKeys([cb1, 0]));
    expect(snap(c)).toEqual(expectedKeys([cb2, 0], [t2, 0], [t2, 1]));

    // Apply a conflicting block on the original: clone untouched.
    const other = spend([[op(cb1, 0), alice]], [pay(dave, 50 * COIN)]);
    const ob = mkBlock([cb(2, dave), other]);
    const uo = s.applyBlock(ob);
    expect(snap(c)).toEqual(expectedKeys([cb2, 0], [t2, 0], [t2, 1]));
    expect(s.balanceOf(dave.address)).toBe(100 * COIN);
    expect(c.balanceOf(dave.address)).toBe(0);

    // Undo on each side independently.
    c.undoBlock(b2, u2);
    expect(snap(s)).toEqual(expectedKeys([cb(2, dave), 0], [other, 0]));
    s.undoBlock(ob, uo);
    expect(snap(s)).toEqual(snap(c));
    expect(snap(c)).toEqual(expectedKeys([cb1, 0]));
  });

  it('cloning an empty set gives an independent empty set', () => {
    const s = new UtxoSet();
    const c = s.clone();
    c.applyBlock(b1);
    expect(s.size).toBe(0);
    expect(c.size).toBe(1);
  });

  it('a failed apply on a clone does not affect the original', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    const c = s.clone();
    expectThrowsAtomically(c, () => c.applyBlock(mkBlock([cb(2, bob), rawTx([op(t2, 0)], [])])));
    expect(snap(s)).toEqual(expectedKeys([cb1, 0]));
  });
});

// ---------------------------------------------------------------------------
// Property-style: random chains, apply then undo everything
// ---------------------------------------------------------------------------

describe('random chains (seeded)', () => {
  const keys = [alice, bob, carol, dave];

  it.each([1, 2, 3, 2730])('seed %i: model matches after each block; undo revisits every snapshot', (seed) => {
    const rng = new Rng(seed);
    const pick = <T>(xs: readonly T[]): T => xs[rng.int(0, xs.length - 1)];

    const s = new UtxoSet();
    const model = new Map<string, Utxo>(); // independent reference model
    const modelSnap = () => [...model.values()].map(utxoKey).sort();
    const spentEver: OutPoint[] = [];

    const blocks: Block[] = [];
    const undos: BlockUndo[] = [];
    const snaps: string[][] = [snap(s)];
    let intraBlockSpends = 0;

    for (let h = 1; h <= 20; h++) {
      const txs: Transaction[] = [];
      const removed: Utxo[] = [];
      const createdHere = new Set<string>();
      const addOutputs = (tx: Transaction) => {
        tx.outputs.forEach((output, index) => {
          const u: Utxo = { outPoint: { txid: txid(tx), index }, output };
          model.set(outPointKey(u.outPoint), u);
          createdHere.add(outPointKey(u.outPoint));
        });
      };

      const coinbase = cb(h, pick(keys), 50 * COIN + rng.int(0, 5000));
      txs.push(coinbase);
      addOutputs(coinbase);

      const nTx = rng.int(0, 3);
      for (let t = 0; t < nTx && model.size > 0; t++) {
        const pool = [...model.keys()];
        const fresh = pool.filter((k) => createdHere.has(k));
        const nIn = rng.int(1, Math.min(2, pool.length));
        const chosen = new Set<string>();
        // Bias towards spending outputs created in this very block.
        if (fresh.length > 0 && rng.next() < 0.5) chosen.add(pick(fresh));
        while (chosen.size < nIn) chosen.add(pick(pool));

        const ins = [...chosen].map((k) => model.get(k) as Utxo);
        for (const k of chosen) if (createdHere.has(k)) intraBlockSpends++;
        const total = ins.reduce((sum, u) => sum + u.output.value, 0);
        const nOut = Math.min(rng.int(1, 3), total);
        const fee = rng.int(0, Math.min(1000, total - nOut));
        let remaining = total - fee;
        const outputs: TxOutput[] = [];
        for (let i = 0; i < nOut - 1; i++) {
          const v = rng.int(1, remaining - (nOut - 1 - i));
          outputs.push(pay(pick(keys), v));
          remaining -= v;
        }
        outputs.push(pay(pick(keys), remaining));

        const tx = rawTx(
          ins.map((u) => u.outPoint),
          outputs,
        );
        for (const u of ins) {
          model.delete(outPointKey(u.outPoint));
          removed.push(u);
          spentEver.push(u.outPoint);
        }
        // txFee against the pre-block set works whenever all inputs predate this block.
        if (!ins.some((u) => createdHere.has(outPointKey(u.outPoint)))) expect(txFee(s, tx)).toBe(fee);
        txs.push(tx);
        addOutputs(tx);
      }

      const block = mkBlock(txs);
      const u = s.applyBlock(block);
      blocks.push(block);
      undos.push(u);

      const now = snap(s);
      expect(now).toEqual(modelSnap());
      expect(undoKeys(u)).toEqual(removed.map(utxoKey).sort());
      for (const k of keys) {
        const want = [...model.values()]
          .filter((m) => m.output.address === k.address)
          .reduce((sum, m) => sum + m.output.value, 0);
        expect(s.balanceOf(k.address)).toBe(want);
        expect(s.utxosOf(k.address).map(utxoKey).sort()).toEqual(
          [...model.values()].filter((m) => m.output.address === k.address).map(utxoKey).sort(),
        );
      }
      snaps.push(now);

      // Invalid blocks never change the set: re-applying, and a valid prefix followed by a double spend.
      expectThrowsAtomically(s, () => s.applyBlock(block));
      if (spentEver.length > 0 && model.size > 0) {
        const live = pick([...model.values()]);
        const dead = pick(spentEver);
        const bad = mkBlock([
          cb(10_000 + h, pick(keys)),
          rawTx([live.outPoint], [pay(pick(keys), live.output.value)]),
          rawTx([dead], [pay(pick(keys), 1)]),
        ]);
        expectThrowsAtomically(s, () => s.applyBlock(bad));
      }
      expect(snap(s)).toEqual(now);
    }

    expect(intraBlockSpends).toBeGreaterThan(0);

    // Outputs a block leaves in the set (created and not spent within the same block).
    const netCreated = (b: Block): OutPoint[] => {
      const spentHere = new Set(
        b.txs.flatMap((tx) => (tx.kind === 'standard' ? tx.inputs.map((i) => outPointKey(i.prevOut)) : [])),
      );
      return b.txs
        .flatMap((tx) => tx.outputs.map((_, i) => op(tx, i)))
        .filter((o) => !spentHere.has(outPointKey(o)));
    };

    for (let i = blocks.length - 1; i >= 0; i--) {
      // Undoing the block below the tip must fail without effect if the tip spent its outputs.
      if (i > 0 && netCreated(blocks[i - 1]).some((o) => !s.has(o))) {
        expectThrowsAtomically(s, () => s.undoBlock(blocks[i - 1], undos[i - 1]));
      }
      s.undoBlock(blocks[i], undos[i]);
      expect(snap(s)).toEqual(snaps[i]);
    }
    expect(s.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// txFee
// ---------------------------------------------------------------------------

describe('txFee', () => {
  it('is 0 for a coinbase, even on an empty set', () => {
    expect(txFee(new UtxoSet(), cb1)).toBe(0);
    expect(txFee(new UtxoSet(), cb(3, bob, 12_345))).toBe(0);
  });

  it('is inputs minus outputs for a standard tx', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    expect(txFee(s, t2)).toBe(1000);
    expect(s.size).toBe(1); // read-only
    expect(s.has(op(cb1, 0))).toBe(true);
  });

  it('sums several inputs', () => {
    const s = new UtxoSet();
    const cbA = cb(1, alice, 7);
    const cbB = cb(2, bob, 11);
    s.applyBlock(mkBlock([cbA]));
    s.applyBlock(mkBlock([cbB]));
    expect(txFee(s, rawTx([op(cbA, 0), op(cbB, 0)], [pay(carol, 3), pay(dave, 4)]))).toBe(11);
    expect(txFee(s, rawTx([op(cbA, 0), op(cbB, 0)], []))).toBe(18);
  });

  it('may be negative (no validation)', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    expect(txFee(s, rawTx([op(cb1, 0)], [pay(bob, 60 * COIN)]))).toBe(-10 * COIN);
  });

  it('throws if an input is missing from the set', () => {
    const s = new UtxoSet();
    s.applyBlock(b1);
    expect(() => txFee(s, rawTx([op(cb1, 0), op(cb1, 1)], [pay(bob, 1)]))).toThrow();
    expect(() => txFee(new UtxoSet(), t2)).toThrow();
    // Spent outputs count as missing.
    s.applyBlock(b2);
    expect(() => txFee(s, t2)).toThrow();
  });
});
