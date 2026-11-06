import { describe, expect, it } from 'vitest';
import { type Block, ZERO_HASH } from '../core/block';
import { bytesToHex, hexToBytes } from '../core/hash';
import { type KeyPair, keyPairFromPrivate } from '../core/keys';
import {
  COIN,
  type CoinbaseTx,
  type OutPoint,
  type TxOutput,
  outPointKey,
  signTransaction,
  txid,
} from '../core/transaction';
import { type Utxo, UtxoSet } from '../core/utxo';
import { validateTransaction } from '../core/validation';
import { buildPayment } from './wallet';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const keyN = (n: number): KeyPair => keyPairFromPrivate(hexToBytes(n.toString(16).padStart(64, '0')));
const alice = keyPairFromPrivate(hexToBytes('18e14a7b6a307f426a94f8114701e7c8e774e7f9a47e2c2035db29a206321725'));
const bob = keyN(1);
const carol = keyN(2);

const pay = (to: KeyPair, value: number): TxOutput => ({ value, address: to.address });
const coinbase = (height: number, outputs: TxOutput[]): CoinbaseTx => ({ kind: 'coinbase', height, outputs });
const op = (tx: CoinbaseTx, index: number): OutPoint => ({ txid: txid(tx), index });

// alice: 5, 3, 8, 1 (in cbMulti) and another 8 (in cbOther); bob: 2 and 100 (never used for alice)
const cbMulti = coinbase(1, [pay(alice, 5 * COIN), pay(alice, 3 * COIN), pay(alice, 8 * COIN), pay(alice, 1 * COIN), pay(bob, 2 * COIN)]);
const cbOther = coinbase(2, [pay(alice, 8 * COIN)]);
const cbBob = coinbase(3, [pay(bob, 100 * COIN)]);

const C5 = op(cbMulti, 0);
const C3 = op(cbMulti, 1);
const C1 = op(cbMulti, 3);
/** The spec's tie-break: txid hex string ascending, then output index ascending NUMERICALLY. */
const tieOrder = (a: OutPoint, b: OutPoint): number => {
  const ta = bytesToHex(a.txid);
  const tb = bytesToHex(b.txid);
  return ta < tb ? -1 : ta > tb ? 1 : a.index - b.index;
};
// The two 8-coin outputs (different txids), in tie-break order.
const [C8first, C8second] = [op(cbMulti, 2), op(cbOther, 0)].sort(tieOrder);
const ALICE_TOTAL = 25 * COIN;

const walletUtxos = (order: 'forward' | 'reverse' = 'forward'): UtxoSet => {
  const s = new UtxoSet();
  const txs = [cbMulti, cbOther, cbBob];
  s.applyTransactions(order === 'forward' ? txs : txs.reverse());
  return s;
};

const keys = (ops: OutPoint[]) => ops.map(outPointKey);
const inputKeys = (tx: { inputs: { prevOut: OutPoint }[] }) => tx.inputs.map((i) => outPointKey(i.prevOut));

const snapUtxos = (s: UtxoSet): string[] =>
  s
    .all()
    .map((u: Utxo) => `${bytesToHex(u.outPoint.txid)}:${u.outPoint.index}|${u.output.value}|${u.output.address}`)
    .sort();

/** The exact tx the spec prescribes for these selected coins and outputs. */
const expectedTx = (from: KeyPair, selected: OutPoint[], outputs: TxOutput[]) =>
  signTransaction(
    selected.map((prevOut) => ({ prevOut, key: from })),
    outputs,
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildPayment: coin selection', () => {
  it('fixture sanity: the two 8-coin outputs are ordered by txid hex', () => {
    expect(bytesToHex(C8first.txid) < bytesToHex(C8second.txid)).toBe(true);
    expect(walletUtxos().balanceOf(alice.address)).toBe(ALICE_TOTAL);
  });

  it('largest first, stops as soon as enough: one coin when the largest covers amount + fee', () => {
    // need 5 COIN: the largest coin (8) is taken, not the exact-fit 5
    const tx = buildPayment(walletUtxos(), alice, carol.address, 4 * COIN, COIN);
    expect(inputKeys(tx)).toEqual(keys([C8first]));
    expect(tx.outputs).toEqual([pay(carol, 4 * COIN), pay(alice, 3 * COIN)]);
  });

  it('ties between different txids are broken by txid hex ascending, independent of insertion order', () => {
    for (const order of ['forward', 'reverse'] as const) {
      const tx = buildPayment(walletUtxos(order), alice, carol.address, 7 * COIN, COIN / 2);
      expect(inputKeys(tx)).toEqual(keys([C8first]));
      const both = buildPayment(walletUtxos(order), alice, carol.address, 15 * COIN, COIN);
      expect(inputKeys(both)).toEqual(keys([C8first, C8second]));
    }
  });

  it('txid is compared before index: the lower txid wins even when its output index is higher', () => {
    // Find (deterministically) two coinbases where the one with the LOWER txid holds its 4-coin
    // output at index 5 and the one with the HIGHER txid holds its 4-coin output at index 0.
    const filler = Array.from({ length: 5 }, () => pay(bob, COIN));
    let h = 1000;
    let lowTx: CoinbaseTx;
    let highTx: CoinbaseTx;
    for (;;) {
      lowTx = coinbase(h, [...filler, pay(alice, 4 * COIN)]);
      highTx = coinbase(h + 1, [pay(alice, 4 * COIN)]);
      if (bytesToHex(txid(lowTx)) < bytesToHex(txid(highTx))) break;
      h += 2;
    }
    const lowCoin = op(lowTx, 5);
    const highCoin = op(highTx, 0);
    for (const txs of [
      [lowTx, highTx],
      [highTx, lowTx],
    ]) {
      const u = new UtxoSet();
      u.applyTransactions(txs);
      const one = buildPayment(u, alice, carol.address, 4 * COIN, 0);
      expect(inputKeys(one)).toEqual(keys([lowCoin])); // index-first ordering would pick highCoin
      const two = buildPayment(u, alice, carol.address, 7 * COIN, 0);
      expect(inputKeys(two)).toEqual(keys([lowCoin, highCoin]));
      expect(two.outputs).toEqual([pay(carol, 7 * COIN), pay(alice, COIN)]);
      expect(validateTransaction(u, two)).toEqual({ ok: true, fee: 0 });
    }
  });

  it('adds coins one by one in descending value until the sum is enough', () => {
    // need 11: 8 + 8 = 16 >= 11
    const tx = buildPayment(walletUtxos(), alice, carol.address, 10 * COIN, COIN);
    expect(inputKeys(tx)).toEqual(keys([C8first, C8second]));
    expect(tx.outputs).toEqual([pay(carol, 10 * COIN), pay(alice, 5 * COIN)]);
    // need 17: 8 + 8 + 5 = 21
    const tx2 = buildPayment(walletUtxos('reverse'), alice, carol.address, 16 * COIN, COIN);
    expect(inputKeys(tx2)).toEqual(keys([C8first, C8second, C5]));
    expect(tx2.outputs).toEqual([pay(carol, 16 * COIN), pay(alice, 4 * COIN)]);
    // need 22: 8 + 8 + 5 + 3 = 24
    const tx3 = buildPayment(walletUtxos(), alice, carol.address, 21 * COIN, COIN);
    expect(inputKeys(tx3)).toEqual(keys([C8first, C8second, C5, C3]));
    expect(tx3.outputs).toEqual([pay(carol, 21 * COIN), pay(alice, 2 * COIN)]);
  });

  it('exact amount: no change output', () => {
    const tx = buildPayment(walletUtxos(), alice, carol.address, 7 * COIN, COIN); // need 8 = one coin
    expect(inputKeys(tx)).toEqual(keys([C8first]));
    expect(tx.outputs).toEqual([pay(carol, 7 * COIN)]);
    const tx2 = buildPayment(walletUtxos(), alice, carol.address, 16 * COIN, 0); // need 16 = 8 + 8
    expect(inputKeys(tx2)).toEqual(keys([C8first, C8second]));
    expect(tx2.outputs).toEqual([pay(carol, 16 * COIN)]);
    const all = buildPayment(walletUtxos(), alice, carol.address, ALICE_TOTAL - 3, 3); // need everything
    expect(inputKeys(all)).toEqual(keys([C8first, C8second, C5, C3, C1]));
    expect(all.outputs).toEqual([pay(carol, ALICE_TOTAL - 3)]);
  });

  it('change = selected - amount - fee, to the sender, after the payment output (odd values)', () => {
    const tx = buildPayment(walletUtxos(), alice, bob.address, 123_456_789, 4_321);
    expect(inputKeys(tx)).toEqual(keys([C8first]));
    expect(tx.outputs).toEqual([
      { value: 123_456_789, address: bob.address },
      { value: 8 * COIN - 123_456_789 - 4_321, address: alice.address },
    ]);
  });

  it('change of exactly 1 unit is still created', () => {
    const tx = buildPayment(walletUtxos(), alice, carol.address, 8 * COIN - 2, 1);
    expect(tx.outputs).toEqual([pay(carol, 8 * COIN - 2), pay(alice, 1)]);
  });

  it("only the sender's coins are used", () => {
    const tx = buildPayment(walletUtxos(), alice, carol.address, 24 * COIN, 0);
    const aliceKeys = new Set(walletUtxos().utxosOf(alice.address).map((u) => outPointKey(u.outPoint)));
    expect(tx.inputs.every((i) => aliceKeys.has(outPointKey(i.prevOut)))).toBe(true);
    // bob uses only his own coins (100 is the largest)
    const tb = buildPayment(walletUtxos(), bob, carol.address, 50 * COIN, 0);
    expect(inputKeys(tb)).toEqual(keys([op(cbBob, 0)]));
    expect(tb.outputs).toEqual([pay(carol, 50 * COIN), pay(bob, 50 * COIN)]);
  });

  it('insufficient funds: uses all coins anyway, no change, and the node rejects it as overspend', () => {
    const u = walletUtxos();
    const tx = buildPayment(u, alice, carol.address, 25 * COIN + 1, COIN);
    expect(inputKeys(tx)).toEqual(keys([C8first, C8second, C5, C3, C1]));
    expect(tx.outputs).toEqual([pay(carol, 25 * COIN + 1)]);
    expect(validateTransaction(u, tx)).toEqual({
      ok: false,
      error: { code: 'overspend', inputTotal: ALICE_TOTAL, outputTotal: 25 * COIN + 1 },
    });
    const tx2 = buildPayment(u, alice, carol.address, 30 * COIN, 0);
    expect(validateTransaction(u, tx2)).toEqual({
      ok: false,
      error: { code: 'overspend', inputTotal: ALICE_TOTAL, outputTotal: 30 * COIN },
    });
  });

  it('enough for the amount but not the fee: all coins, no change, valid with a smaller fee (fee is not an output)', () => {
    const u = walletUtxos();
    const tx = buildPayment(u, alice, carol.address, ALICE_TOTAL - 1, 5);
    expect(inputKeys(tx)).toEqual(keys([C8first, C8second, C5, C3, C1]));
    expect(tx.outputs).toEqual([pay(carol, ALICE_TOTAL - 1)]);
    expect(validateTransaction(u, tx)).toEqual({ ok: true, fee: 1 });
  });

  it('no coins: a tx with no inputs (the node rejects no-inputs)', () => {
    const u = walletUtxos();
    const tx = buildPayment(u, carol, bob.address, COIN, 1_000);
    expect(tx.kind).toBe('standard');
    expect(tx.inputs).toEqual([]);
    expect(tx.outputs).toEqual([pay(bob, COIN)]);
    expect(validateTransaction(u, tx)).toEqual({ ok: false, error: { code: 'no-inputs' } });
    const empty = buildPayment(new UtxoSet(), alice, bob.address, COIN, 0);
    expect(empty.inputs).toEqual([]);
  });
});

describe('buildPayment: signatures and purity', () => {
  it('produces a fully valid tx: validateTransaction ok with fee = the requested fee', () => {
    const u = walletUtxos();
    for (const [amount, fee] of [
      [4 * COIN, COIN],
      [10 * COIN, 12_345],
      [16 * COIN, 0],
      [24 * COIN, COIN],
      [1, 0],
    ]) {
      const tx = buildPayment(u, alice, carol.address, amount, fee);
      expect(validateTransaction(u, tx)).toEqual({ ok: true, fee });
    }
  });

  it('is exactly signTransaction(selected coins in order, all signed by `from`, outputs)', () => {
    const tx = buildPayment(walletUtxos(), alice, carol.address, 16 * COIN, COIN);
    expect(tx).toEqual(expectedTx(alice, [C8first, C8second, C5], [pay(carol, 16 * COIN), pay(alice, 4 * COIN)]));
    for (const input of tx.inputs) expect(bytesToHex(input.publicKey)).toBe(bytesToHex(alice.publicKey));
  });

  it('does not modify the UTXO set', () => {
    const u = walletUtxos();
    const before = snapUtxos(u);
    buildPayment(u, alice, carol.address, 10 * COIN, COIN);
    buildPayment(u, alice, carol.address, 100 * COIN, COIN);
    buildPayment(u, carol, alice.address, COIN, 0);
    expect(snapUtxos(u)).toEqual(before);
    // building twice from the same set gives the same tx (the coins were not consumed)
    expect(buildPayment(u, alice, carol.address, 10 * COIN, COIN)).toEqual(buildPayment(u, alice, carol.address, 10 * COIN, COIN));
  });

  it('within one txid, equal coins are taken by output index NUMERICALLY (…:2 before …:10)', () => {
    // 12 equal coins in one tx. outPointKey STRING order would be :0, :1, :10, :11, :2, ... — not allowed.
    const many = coinbase(9, Array.from({ length: 12 }, () => pay(alice, COIN)));
    const coin = (i: number) => op(many, i);
    const range = (n: number) => Array.from({ length: n }, (_, i) => coin(i));
    // sanity: string order really differs from numeric order here
    expect(range(12).map(outPointKey).sort().slice(0, 3)).toEqual(keys([coin(0), coin(1), coin(10)]));
    const u = new UtxoSet();
    u.applyTransactions([many]);
    // 3 coins: :0, :1, :2 (string order would give :0, :1, :10)
    const tx3 = buildPayment(u, alice, bob.address, 3 * COIN, 0);
    expect(inputKeys(tx3)).toEqual(keys(range(3)));
    // 11 coins: :0 .. :10 in numeric order (string order would include :11 and put :10 third)
    const tx11 = buildPayment(u, alice, bob.address, 10 * COIN, COIN);
    expect(inputKeys(tx11)).toEqual(keys(range(11)));
    expect(tx11.outputs).toEqual([pay(bob, 10 * COIN)]);
    // all 12 in order :0 .. :11
    const tx12 = buildPayment(u, alice, bob.address, 11 * COIN, COIN / 2);
    expect(inputKeys(tx12)).toEqual(keys(range(12)));
    expect(tx12.outputs).toEqual([pay(bob, 11 * COIN), pay(alice, COIN / 2)]);
    expect(validateTransaction(u, tx12)).toEqual({ ok: true, fee: COIN / 2 });
  });

  it('the numeric index order does not depend on the order coins were added to the UTXO set', () => {
    const many = coinbase(9, Array.from({ length: 12 }, () => pay(alice, COIN)));
    const coin = (i: number) => op(many, i);
    const u = new UtxoSet();
    u.applyTransactions([many]);
    // Spend :0 and :2, then undo: they are re-inserted at the end of the set's iteration order.
    const spender: Block = {
      header: { prevHash: ZERO_HASH, merkleRoot: ZERO_HASH, timestamp: 0, target: 1n, nonce: 0 },
      txs: [
        signTransaction(
          [
            { prevOut: coin(0), key: alice },
            { prevOut: coin(2), key: alice },
          ],
          [pay(bob, 2 * COIN)],
        ),
      ],
    };
    u.undoBlock(spender, u.applyBlock(spender));
    const insertion = u.utxosOf(alice.address).map((x) => x.outPoint.index);
    expect(insertion).not.toEqual([...insertion].sort((a, b) => a - b)); // fixture really is scrambled
    const tx = buildPayment(u, alice, bob.address, 3 * COIN, 0);
    expect(inputKeys(tx)).toEqual(keys([coin(0), coin(1), coin(2)]));
  });
});
