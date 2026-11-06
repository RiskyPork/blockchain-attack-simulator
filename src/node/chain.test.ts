import { describe, expect, it } from 'vitest';
import { type Block, type BlockHeader, ZERO_HASH, blockHash, blockHashHex, targetFromLeadingZeroBits } from '../core/block';
import { bytesToHex, hexToBytes } from '../core/hash';
import { type KeyPair, keyPairFromPrivate } from '../core/keys';
import { merkleRoot } from '../core/merkle';
import { BLOCK_SUBSIDY, assembleBlock, mineChunk } from '../core/miner';
import {
  COIN,
  type OutPoint,
  type StandardTx,
  type Transaction,
  type TxOutput,
  type CoinbaseTx,
  createCoinbase,
  signTransaction,
  txid,
  txidHex,
} from '../core/transaction';
import { UtxoSet } from '../core/utxo';
import { validateTransaction } from '../core/validation';
import { Rng } from '../network/rng';
import { Chain } from './chain';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const keyN = (n: number): KeyPair => keyPairFromPrivate(hexToBytes(n.toString(16).padStart(64, '0')));
const alice = keyPairFromPrivate(hexToBytes('18e14a7b6a307f426a94f8114701e7c8e774e7f9a47e2c2035db29a206321725'));
const bob = keyN(1);
const carol = keyN(2);
const miner = keyN(3);
const other = keyN(4);

const T8 = targetFromLeadingZeroBits(8);
const T7 = targetFromLeadingZeroBits(7);
const T9 = targetFromLeadingZeroBits(9);

const op = (tx: Transaction, index: number): OutPoint => ({ txid: txid(tx), index });
const pay = (to: KeyPair, value: number): TxOutput => ({ value, address: to.address });
const spend = (inputs: [OutPoint, KeyPair][], outputs: TxOutput[]): StandardTx =>
  signTransaction(
    inputs.map(([prevOut, key]) => ({ prevOut, key })),
    outputs,
  );

function mineHeaderSync(header: BlockHeader): BlockHeader {
  let h = header;
  for (;;) {
    const r = mineChunk(h, 20_000);
    if (r.found) return r.header;
    h = r.header;
  }
}
const mined = (b: Block): Block => ({ header: mineHeaderSync(b.header), txs: b.txs });

/** submitBlock's result for a block that simply extends the main chain's tip. */
const extended = (b: Block) => ({ ok: true, status: 'main', tipChange: { disconnected: [], connected: [b] } });

/** A block built by some other node on top of `chain`'s tip, with arbitrary txs. */
function foreignBlock(chain: Chain, txs: StandardTx[], fees: number, opts: { minerAddress?: string; timestamp?: number } = {}): Block {
  return mined(
    assembleBlock({
      prevHash: chain.tipHash,
      height: chain.height + 1,
      timestamp: opts.timestamp ?? 5_000,
      target: chain.target,
      minerAddress: opts.minerAddress ?? other.address,
      txs,
      fees,
    }),
  );
}

const snapUtxos = (s: UtxoSet): string[] =>
  s
    .all()
    .map((u) => `${bytesToHex(u.outPoint.txid)}:${u.outPoint.index}|${u.output.value}|${u.output.address}`)
    .sort();

const snapAny = (x: unknown): string =>
  JSON.stringify(x, (_k, v: unknown) =>
    v instanceof Uint8Array ? `bytes:${bytesToHex(v)}` : typeof v === 'bigint' ? `big:${v}` : v,
  );

/** Everything observable about a chain, for "nothing changed" assertions. */
const snapChain = (c: Chain) => ({
  height: c.height,
  tip: bytesToHex(c.tipHash),
  target: c.target,
  blocks: snapAny(c.blocks),
  mempool: c.mempool.map(txidHex),
  confirmed: snapUtxos(c.confirmedUtxos()),
  spendable: snapUtxos(c.spendableUtxos()),
});

/**
 * Chain with two blocks:
 *   height 0: coinbase 50 COIN to alice
 *   height 1: coinbase 50 COIN to bob
 */
function twoBlockChain() {
  const chain = new Chain({ target: T8 });
  const g = mined(chain.createBlockTemplate(alice.address, 1_000));
  expect(chain.submitBlock(g)).toEqual(extended(g));
  const b1 = mined(chain.createBlockTemplate(bob.address, 2_000));
  expect(chain.submitBlock(b1)).toEqual(extended(b1));
  const aliceCoin = op(g.txs[0], 0);
  const bobCoin = op(b1.txs[0], 0);
  return { chain, g, b1, aliceCoin, bobCoin };
}

// ---------------------------------------------------------------------------
// Empty chain, target
// ---------------------------------------------------------------------------

describe('Chain: empty chain', () => {
  it('has the documented empty-chain getters', () => {
    const c = new Chain({ target: T8 });
    expect(c.target).toBe(T8);
    expect(c.height).toBe(-1);
    expect(bytesToHex(c.tipHash)).toBe(bytesToHex(ZERO_HASH));
    expect(c.tipHash.length).toBe(32);
    expect(c.blocks).toEqual([]);
    expect(c.mempool).toEqual([]);
    expect(c.confirmedUtxos().size).toBe(0);
    expect(c.spendableUtxos().size).toBe(0);
    expect(c.balanceOf(alice.address)).toBe(0);
    expect(c.balanceOf(alice.address, { includeMempool: true })).toBe(0);
  });

  it('rejects txs when there is nothing to spend', () => {
    const c = new Chain({ target: T8 });
    const tx = spend([[{ txid: new Uint8Array(32).fill(1), index: 0 }, alice]], [pay(bob, 1)]);
    expect(c.submitTransaction(tx)).toEqual({ ok: false, error: { code: 'missing-input', input: 0 } });
    expect(c.mempool).toEqual([]);
  });
});

describe('Chain: target', () => {
  it.each([
    ['0', 0n],
    ['-1', -1n],
    ['2^256', 2n ** 256n],
    ['2^256 + 1', 2n ** 256n + 1n],
  ])('setter throws RangeError for %s and keeps the old target', (_n, t) => {
    const c = new Chain({ target: T8 });
    expect(() => {
      c.target = t;
    }).toThrow(RangeError);
    expect(c.target).toBe(T8);
  });

  it('setter accepts the bounds 1 and 2^256 - 1', () => {
    const c = new Chain({ target: T8 });
    c.target = 1n;
    expect(c.target).toBe(1n);
    c.target = 2n ** 256n - 1n;
    expect(c.target).toBe(2n ** 256n - 1n);
    c.target = T9;
    expect(c.target).toBe(T9);
  });

  it('a new target applies to templates built from now on', () => {
    const c = new Chain({ target: T8 });
    expect(c.createBlockTemplate(miner.address, 1).header.target).toBe(T8);
    c.target = T7;
    expect(c.createBlockTemplate(miner.address, 1).header.target).toBe(T7);
  });
});

// ---------------------------------------------------------------------------
// Genesis and block templates
// ---------------------------------------------------------------------------

describe('Chain: genesis', () => {
  it('template on an empty chain: ZERO_HASH parent, height 0, subsidy only', () => {
    const c = new Chain({ target: T8 });
    const t = c.createBlockTemplate(miner.address, 1_234);
    const cb = createCoinbase(0, miner.address, BLOCK_SUBSIDY);
    expect(t.txs).toEqual([cb]);
    expect(bytesToHex(t.header.prevHash)).toBe(bytesToHex(ZERO_HASH));
    expect(bytesToHex(t.header.merkleRoot)).toBe(bytesToHex(merkleRoot([txid(cb)])));
    expect(t.header.timestamp).toBe(1_234);
    expect(t.header.target).toBe(T8);
    expect(t.header.nonce).toBe(0);
    // creating a template does not change the chain
    expect(c.height).toBe(-1);
    expect(c.blocks).toEqual([]);
  });

  it('accepts the first block at height 0 and advances tip, blocks and UTXO set', () => {
    const c = new Chain({ target: T8 });
    const g = mined(c.createBlockTemplate(alice.address, 1_000));
    expect(c.submitBlock(g)).toEqual(extended(g));
    expect(c.height).toBe(0);
    expect(bytesToHex(c.tipHash)).toBe(bytesToHex(blockHash(g.header)));
    expect(c.blocks.length).toBe(1);
    expect(snapAny(c.blocks[0])).toBe(snapAny(g));
    expect(c.balanceOf(alice.address)).toBe(BLOCK_SUBSIDY);
    const u = c.confirmedUtxos();
    expect(u.size).toBe(1);
    expect(u.get(op(g.txs[0], 0))).toEqual({ value: BLOCK_SUBSIDY, address: alice.address });
  });

  it('holds a first block whose prevHash is not ZERO_HASH as an orphan (its parent is unknown)', () => {
    const c = new Chain({ target: T8 });
    const t = c.createBlockTemplate(alice.address, 1_000);
    const b = mined({ header: { ...t.header, prevHash: new Uint8Array(32).fill(0xab) }, txs: t.txs });
    expect(c.submitBlock(b)).toEqual({ ok: true, status: 'orphan', tipChange: null });
    expect(c.tree.isOrphan(blockHashHex(b.header))).toBe(true);
    expect(c.height).toBe(-1);
    expect(c.blocks).toEqual([]);
    expect(c.confirmedUtxos().size).toBe(0);
  });

  it('rejects a first block whose coinbase commits to height 1', () => {
    const c = new Chain({ target: T8 });
    const b = mined(
      assembleBlock({ prevHash: ZERO_HASH, height: 1, timestamp: 1, target: T8, minerAddress: alice.address, txs: [], fees: 0 }),
    );
    expect(c.submitBlock(b)).toEqual({ ok: false, error: { code: 'bad-coinbase-height', expected: 0, actual: 1 } });
    expect(c.height).toBe(-1);
  });

  it('second block: links to the genesis hash at height 1', () => {
    const { chain, g, b1 } = twoBlockChain();
    expect(bytesToHex(b1.header.prevHash)).toBe(bytesToHex(blockHash(g.header)));
    expect(b1.txs[0]).toEqual(createCoinbase(1, bob.address, BLOCK_SUBSIDY));
    expect(chain.height).toBe(1);
    expect(bytesToHex(chain.tipHash)).toBe(bytesToHex(blockHash(b1.header)));
    expect(chain.blocks.map((b) => bytesToHex(blockHash(b.header)))).toEqual([g, b1].map((b) => bytesToHex(blockHash(b.header))));
    expect(chain.balanceOf(alice.address)).toBe(BLOCK_SUBSIDY);
    expect(chain.balanceOf(bob.address)).toBe(BLOCK_SUBSIDY);
  });

  it('the same block cannot be submitted twice (duplicate)', () => {
    const { chain, b1 } = twoBlockChain();
    const before = snapChain(chain);
    expect(chain.submitBlock(b1)).toEqual({ ok: false, error: { code: 'duplicate' } });
    expect(snapChain(chain)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Mempool
// ---------------------------------------------------------------------------

describe('Chain: submitTransaction', () => {
  it('accepts a valid tx, returns its fee, appends it to the mempool; confirmed state unchanged', () => {
    const { chain, aliceCoin } = twoBlockChain();
    const confirmedBefore = snapUtxos(chain.confirmedUtxos());
    const tx = spend([[aliceCoin, alice]], [pay(carol, 10 * COIN), pay(alice, 39 * COIN)]);
    expect(chain.submitTransaction(tx)).toEqual({ ok: true, fee: COIN });
    expect(chain.mempool).toEqual([tx]);
    expect(chain.height).toBe(1);
    expect(snapUtxos(chain.confirmedUtxos())).toEqual(confirmedBefore);
  });

  it('balances: confirmed by default, mempool-inclusive on request', () => {
    const { chain, aliceCoin } = twoBlockChain();
    const tx = spend([[aliceCoin, alice]], [pay(carol, 10 * COIN), pay(alice, 39 * COIN)]);
    chain.submitTransaction(tx);
    expect(chain.balanceOf(alice.address)).toBe(50 * COIN);
    expect(chain.balanceOf(alice.address, {})).toBe(50 * COIN);
    expect(chain.balanceOf(alice.address, { includeMempool: false })).toBe(50 * COIN);
    expect(chain.balanceOf(alice.address, { includeMempool: true })).toBe(39 * COIN);
    expect(chain.balanceOf(carol.address)).toBe(0);
    expect(chain.balanceOf(carol.address, { includeMempool: true })).toBe(10 * COIN);
    expect(chain.balanceOf(bob.address, { includeMempool: true })).toBe(50 * COIN);
  });

  it('rejects invalid txs with the validateTransaction result and changes nothing', () => {
    const { chain, aliceCoin, bobCoin } = twoBlockChain();
    const before = snapChain(chain);
    const overspend = spend([[aliceCoin, alice]], [pay(carol, 50 * COIN + 1)]);
    const wrongKey = spend([[aliceCoin, bob]], [pay(carol, COIN)]);
    const signed = spend([[bobCoin, bob]], [pay(carol, COIN)]);
    const badSig: StandardTx = { ...signed, inputs: [{ ...signed.inputs[0], signature: new Uint8Array(64) }] };
    const cases: [Transaction, unknown][] = [
      [overspend, { ok: false, error: { code: 'overspend', inputTotal: 50 * COIN, outputTotal: 50 * COIN + 1 } }],
      [wrongKey, { ok: false, error: { code: 'wrong-public-key', input: 0 } }],
      [badSig, { ok: false, error: { code: 'bad-signature', input: 0 } }],
      [createCoinbase(2, alice.address, BLOCK_SUBSIDY), { ok: false, error: { code: 'unexpected-coinbase' } }],
      [{ kind: 'standard', inputs: [], outputs: [pay(carol, 1)] }, { ok: false, error: { code: 'no-inputs' } }],
      [{ kind: 'standard', inputs: signed.inputs, outputs: [{ value: 1, address: 'garbage' }] }, { ok: false, error: { code: 'invalid-address', output: 0 } }],
    ];
    for (const [tx, expected] of cases) {
      expect(chain.submitTransaction(tx)).toEqual(expected);
      expect(snapChain(chain)).toEqual(before);
    }
  });

  it('a tx may spend an unconfirmed (mempool) output', () => {
    const { chain, aliceCoin } = twoBlockChain();
    const tx1 = spend([[aliceCoin, alice]], [pay(carol, 10 * COIN), pay(alice, 39 * COIN)]);
    const tx2 = spend([[op(tx1, 0), carol]], [pay(bob, 9 * COIN)]);
    expect(chain.submitTransaction(tx2)).toEqual({ ok: false, error: { code: 'missing-input', input: 0 } }); // parent not known yet
    expect(chain.submitTransaction(tx1)).toEqual({ ok: true, fee: COIN });
    expect(chain.submitTransaction(tx2)).toEqual({ ok: true, fee: COIN });
    expect(chain.mempool).toEqual([tx1, tx2]);
    expect(chain.balanceOf(bob.address, { includeMempool: true })).toBe(59 * COIN);
    expect(chain.balanceOf(carol.address, { includeMempool: true })).toBe(0);
  });

  it('rejects a tx conflicting with the mempool, and a duplicate of a mempool tx, as missing-input', () => {
    const { chain, aliceCoin } = twoBlockChain();
    const tx1 = spend([[aliceCoin, alice]], [pay(carol, 10 * COIN), pay(alice, 39 * COIN)]);
    const conflict = spend([[aliceCoin, alice]], [pay(bob, 49 * COIN)]);
    chain.submitTransaction(tx1);
    const before = snapChain(chain);
    expect(chain.submitTransaction(conflict)).toEqual({ ok: false, error: { code: 'missing-input', input: 0 } });
    expect(chain.submitTransaction(tx1)).toEqual({ ok: false, error: { code: 'missing-input', input: 0 } });
    expect(snapChain(chain)).toEqual(before);
    expect(chain.mempool).toEqual([tx1]);
  });

  it('keeps the mempool in acceptance order', () => {
    const { chain, aliceCoin, bobCoin } = twoBlockChain();
    const txB = spend([[bobCoin, bob]], [pay(carol, 20 * COIN), pay(bob, 29 * COIN)]);
    const txA = spend([[aliceCoin, alice]], [pay(carol, 10 * COIN), pay(alice, 39 * COIN)]);
    const txC = spend(
      [
        [op(txA, 0), carol],
        [op(txB, 0), carol],
      ],
      [pay(miner, 29 * COIN)],
    );
    expect(chain.submitTransaction(txB).ok).toBe(true);
    expect(chain.submitTransaction(txA).ok).toBe(true);
    expect(chain.submitTransaction(txC).ok).toBe(true);
    expect(chain.mempool.map(txidHex)).toEqual([txB, txA, txC].map(txidHex));
  });

  it('spendableUtxos = confirmed with every mempool tx applied in order', () => {
    const { chain, aliceCoin } = twoBlockChain();
    const tx1 = spend([[aliceCoin, alice]], [pay(carol, 10 * COIN), pay(alice, 39 * COIN)]);
    const tx2 = spend([[op(tx1, 0), carol]], [pay(bob, 9 * COIN)]);
    chain.submitTransaction(tx1);
    chain.submitTransaction(tx2);
    const expected = chain.confirmedUtxos();
    expected.applyTransactions([tx1, tx2]);
    expect(snapUtxos(chain.spendableUtxos())).toEqual(snapUtxos(expected));
    expect(chain.spendableUtxos().has(op(tx1, 0))).toBe(false);
    expect(chain.spendableUtxos().has(op(tx1, 1))).toBe(true);
    expect(chain.confirmedUtxos().has(op(tx1, 1))).toBe(false);
  });

  it('the submit result equals validateTransaction against spendableUtxos()', () => {
    const { chain, aliceCoin } = twoBlockChain();
    const tx1 = spend([[aliceCoin, alice]], [pay(carol, 10 * COIN), pay(alice, 39 * COIN)]);
    const tx2 = spend([[op(tx1, 1), alice]], [pay(bob, 39 * COIN + 1)]);
    chain.submitTransaction(tx1);
    const expected = validateTransaction(chain.spendableUtxos(), tx2);
    expect(expected).toEqual({ ok: false, error: { code: 'overspend', inputTotal: 39 * COIN, outputTotal: 39 * COIN + 1 } });
    expect(chain.submitTransaction(tx2)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Block templates and block submission
// ---------------------------------------------------------------------------

/** Chain with three pending txs: txA (alice), txB (bob, independent), txC (spends txA:0). Fees 1, 2, 0.5 COIN. */
function chainWithMempool() {
  const base = twoBlockChain();
  const { chain, aliceCoin, bobCoin } = base;
  const txA = spend([[aliceCoin, alice]], [pay(carol, 10 * COIN), pay(alice, 39 * COIN)]);
  const txB = spend([[bobCoin, bob]], [pay(carol, 48 * COIN)]);
  const txC = spend([[op(txA, 0), carol]], [pay(miner, 9 * COIN + COIN / 2)]);
  expect(chain.submitTransaction(txA)).toEqual({ ok: true, fee: COIN });
  expect(chain.submitTransaction(txB)).toEqual({ ok: true, fee: 2 * COIN });
  expect(chain.submitTransaction(txC)).toEqual({ ok: true, fee: COIN / 2 });
  return { ...base, txA, txB, txC, fees: COIN + 2 * COIN + COIN / 2 };
}

describe('Chain: createBlockTemplate', () => {
  it('contains a coinbase for subsidy + fees, then all mempool txs in order, on top of the tip', () => {
    const { chain, txA, txB, txC, fees, b1 } = chainWithMempool();
    const t = chain.createBlockTemplate(miner.address, 9_999);
    const cb = createCoinbase(2, miner.address, BLOCK_SUBSIDY + fees);
    expect(t.txs).toEqual([cb, txA, txB, txC]);
    expect(bytesToHex(t.header.prevHash)).toBe(bytesToHex(blockHash(b1.header)));
    expect(bytesToHex(t.header.merkleRoot)).toBe(bytesToHex(merkleRoot([cb, txA, txB, txC].map(txid))));
    expect(t.header.timestamp).toBe(9_999);
    expect(t.header.target).toBe(T8);
    expect(t.header.nonce).toBe(0);
    // exactly what assembleBlock would produce
    expect(snapAny(t)).toBe(
      snapAny(
        assembleBlock({
          prevHash: blockHash(b1.header),
          height: 2,
          timestamp: 9_999,
          target: T8,
          minerAddress: miner.address,
          txs: [txA, txB, txC],
          fees,
        }),
      ),
    );
  });

  it('does not mine or change the chain, and is repeatable', () => {
    const { chain } = chainWithMempool();
    const before = snapChain(chain);
    const t1 = chain.createBlockTemplate(miner.address, 9_999);
    const t2 = chain.createBlockTemplate(miner.address, 9_999);
    expect(snapAny(t1)).toBe(snapAny(t2));
    expect(snapChain(chain)).toEqual(before);
    // mutating the template does not affect the chain's mempool
    t1.txs.length = 1;
    expect(chain.mempool.length).toBe(3);
    expect(snapChain(chain)).toEqual(before);
  });

  it('uses the current target', () => {
    const { chain } = chainWithMempool();
    chain.target = T9;
    expect(chain.createBlockTemplate(miner.address, 1).header.target).toBe(T9);
  });
});

describe('Chain: submitBlock', () => {
  it('accepts a mined template: height, tip, UTXO set, balances, empty mempool', () => {
    const { chain, txB, fees } = chainWithMempool();
    const confirmedBefore = chain.confirmedUtxos();
    const b = mined(chain.createBlockTemplate(miner.address, 9_999));
    expect(chain.submitBlock(b)).toEqual(extended(b));
    expect(chain.height).toBe(2);
    expect(bytesToHex(chain.tipHash)).toBe(bytesToHex(blockHash(b.header)));
    expect(chain.blocks.length).toBe(3);
    expect(snapAny(chain.blocks[2])).toBe(snapAny(b));
    expect(chain.mempool).toEqual([]);
    confirmedBefore.applyBlock(b);
    expect(snapUtxos(chain.confirmedUtxos())).toEqual(snapUtxos(confirmedBefore));
    expect(snapUtxos(chain.spendableUtxos())).toEqual(snapUtxos(confirmedBefore));
    expect(chain.balanceOf(miner.address)).toBe(BLOCK_SUBSIDY + fees + 9 * COIN + COIN / 2);
    expect(chain.balanceOf(carol.address)).toBe(48 * COIN);
    expect(chain.balanceOf(alice.address)).toBe(39 * COIN);
    expect(chain.balanceOf(bob.address)).toBe(0);
    // the new outputs are spendable right away
    const next = spend([[op(txB, 0), carol]], [pay(alice, 47 * COIN)]);
    expect(chain.submitTransaction(next)).toEqual({ ok: true, fee: COIN });
  });

  it('a block from elsewhere with a subset of the mempool removes only those txs; the rest stay in order', () => {
    const { chain, txA, txB, txC } = chainWithMempool();
    const b = foreignBlock(chain, [txA], COIN);
    expect(chain.submitBlock(b)).toEqual(extended(b));
    // txC (child of txA) is still valid: its parent is now confirmed
    expect(chain.mempool.map(txidHex)).toEqual([txB, txC].map(txidHex));
    expect(chain.balanceOf(other.address)).toBe(BLOCK_SUBSIDY + COIN);
    expect(chain.balanceOf(carol.address)).toBe(10 * COIN);
    expect(chain.balanceOf(miner.address, { includeMempool: true })).toBe(9 * COIN + COIN / 2);
  });

  it('a block containing txs not in the mempool is accepted and the mempool is untouched', () => {
    const { chain, txA, txB, txC } = chainWithMempool();
    const b = foreignBlock(chain, [], 0);
    expect(chain.submitBlock(b)).toEqual(extended(b));
    expect(chain.mempool.map(txidHex)).toEqual([txA, txB, txC].map(txidHex));
  });

  it('re-validates the mempool: drops a tx conflicting with the block (and its descendants), keeps the rest', () => {
    const { chain, aliceCoin, txB } = chainWithMempool();
    // Another node confirmed a different spend of alice's coin.
    const doubleSpend = spend([[aliceCoin, alice]], [pay(other, 49 * COIN)]);
    expect(chain.submitTransaction(doubleSpend)).toEqual({ ok: false, error: { code: 'missing-input', input: 0 } });
    const b = foreignBlock(chain, [doubleSpend], COIN);
    expect(chain.submitBlock(b)).toEqual(extended(b));
    expect(chain.mempool.map(txidHex)).toEqual([txidHex(txB)]);
    expect(chain.balanceOf(other.address)).toBe(BLOCK_SUBSIDY + COIN + 49 * COIN);
    expect(chain.balanceOf(carol.address, { includeMempool: true })).toBe(48 * COIN);
    expect(chain.balanceOf(alice.address, { includeMempool: true })).toBe(0);
    // spendable = confirmed + txB only
    const expected = chain.confirmedUtxos();
    expected.applyTransactions([txB]);
    expect(snapUtxos(chain.spendableUtxos())).toEqual(snapUtxos(expected));
  });

  it('re-validation keeps a tx that comes after a dropped one when it does not depend on it', () => {
    const { chain, aliceCoin, bobCoin } = twoBlockChain();
    const txA = spend([[aliceCoin, alice]], [pay(carol, 49 * COIN)]);
    const txB = spend([[bobCoin, bob]], [pay(carol, 49 * COIN)]);
    chain.submitTransaction(txA);
    chain.submitTransaction(txB);
    const conflictA = spend([[aliceCoin, alice]], [pay(other, 50 * COIN)]);
    expect(chain.submitBlock(foreignBlock(chain, [conflictA], 0)).ok).toBe(true);
    expect(chain.mempool.map(txidHex)).toEqual([txidHex(txB)]);
  });

  it('validates against the confirmed set, not the mempool: a block spending an unconfirmed output without its parent is rejected', () => {
    const { chain, txC } = chainWithMempool();
    const before = snapChain(chain);
    const b = foreignBlock(chain, [txC], COIN / 2);
    expect(chain.submitBlock(b)).toEqual({
      ok: false,
      error: { code: 'invalid-tx', index: 1, error: { code: 'missing-input', input: 0 } },
    });
    expect(snapChain(chain)).toEqual(before);
  });

  it('stores a block built on an old tip as stale; the main chain and mempool are unchanged', () => {
    const { chain } = chainWithMempool();
    const stale = mined(chain.createBlockTemplate(miner.address, 9_000));
    expect(chain.submitBlock(foreignBlock(chain, [], 0)).ok).toBe(true);
    const before = snapChain(chain);
    expect(chain.submitBlock(stale)).toEqual({ ok: true, status: 'stale', tipChange: null });
    expect(snapChain(chain)).toEqual(before);
    expect(chain.tree.has(blockHashHex(stale.header))).toBe(true);
    expect(chain.confirmations(blockHashHex(stale.header))).toBe(0);
  });

  it('rejects a block with the old target after chain.target changed (wrong-target) and changes nothing', () => {
    const { chain } = chainWithMempool();
    const b = mined(chain.createBlockTemplate(miner.address, 9_000));
    chain.target = T9;
    const before = snapChain(chain);
    expect(chain.submitBlock(b)).toEqual({ ok: false, error: { code: 'wrong-target' } });
    expect(snapChain(chain)).toEqual(before);
    // with the target set back, the very same block is accepted
    chain.target = T8;
    expect(chain.submitBlock(b)).toEqual(extended(b));
  });

  it('accepts blocks at a new target once chain.target changed', () => {
    const { chain } = twoBlockChain();
    chain.target = T7;
    const b = mined(chain.createBlockTemplate(miner.address, 3_000));
    expect(b.header.target).toBe(T7);
    expect(chain.submitBlock(b)).toEqual(extended(b));
    expect(chain.height).toBe(2);
  });

  it('rejects a block with an invalid tx (overspend) and changes nothing', () => {
    const { chain, bobCoin } = chainWithMempool();
    const before = snapChain(chain);
    // spend bob's coin differently; also overspends
    const over = spend([[bobCoin, bob]], [pay(other, 50 * COIN + 1)]);
    const b = mined(
      assembleBlock({
        prevHash: chain.tipHash,
        height: chain.height + 1,
        timestamp: 7,
        target: chain.target,
        minerAddress: other.address,
        txs: [over],
        fees: 0,
      }),
    );
    expect(chain.submitBlock(b)).toEqual({
      ok: false,
      error: { code: 'invalid-tx', index: 1, error: { code: 'overspend', inputTotal: 50 * COIN, outputTotal: 50 * COIN + 1 } },
    });
    expect(snapChain(chain)).toEqual(before);
  });

  it('rejects a block whose coinbase claims too much and changes nothing', () => {
    const { chain, txA } = chainWithMempool();
    const before = snapChain(chain);
    const b = foreignBlock(chain, [txA], COIN + 1); // claims 1 unit more than allowed
    expect(chain.submitBlock(b)).toEqual({
      ok: false,
      error: { code: 'coinbase-too-large', claimed: BLOCK_SUBSIDY + COIN + 1, allowed: BLOCK_SUBSIDY + COIN },
    });
    expect(snapChain(chain)).toEqual(before);
  });

  it('rejects an unmined template (bad-pow) at a hard target and changes nothing', () => {
    const { chain } = chainWithMempool();
    chain.target = targetFromLeadingZeroBits(40);
    const before = snapChain(chain);
    const t = chain.createBlockTemplate(miner.address, 1);
    expect(chain.submitBlock(t)).toEqual({ ok: false, error: { code: 'bad-pow' } });
    expect(snapChain(chain)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Copies
// ---------------------------------------------------------------------------

describe('Chain: returned values are copies', () => {
  it('mutating blocks / mempool arrays does not change the chain', () => {
    const { chain, txA } = chainWithMempool();
    const before = snapChain(chain);
    const blocks = chain.blocks as Block[];
    blocks.length = 0;
    blocks.push(blocks[0]);
    const mp = chain.mempool as StandardTx[];
    mp.reverse();
    mp.pop();
    mp.push(txA);
    expect(snapChain(chain)).toEqual(before);
    expect(chain.blocks.length).toBe(2);
    expect(chain.mempool.length).toBe(3);
  });

  it('mutating the returned UTXO sets does not change the chain', () => {
    const { chain, aliceCoin } = chainWithMempool();
    const before = snapChain(chain);
    const conf = chain.confirmedUtxos();
    conf.applyTransactions([createCoinbase(99, carol.address, 1_000 * COIN)]);
    const spendable = chain.spendableUtxos();
    spendable.applyTransactions([createCoinbase(98, carol.address, 1_000 * COIN)]);
    expect(snapChain(chain)).toEqual(before);
    expect(chain.balanceOf(carol.address)).toBe(0);
    expect(chain.balanceOf(carol.address, { includeMempool: true })).toBe(48 * COIN);
    // spending from a returned clone does not consume the coin in the chain
    const clone = chain.confirmedUtxos();
    clone.applyTransactions([spend([[aliceCoin, alice]], [pay(bob, COIN)])]);
    expect(chain.confirmedUtxos().has(aliceCoin)).toBe(true);
  });

  it('a tampered block (coinbase changed after mining) is rejected and leaves no trace', () => {
    const { chain } = twoBlockChain();
    const before = snapChain(chain);
    const bad = mined(chain.createBlockTemplate(miner.address, 1));
    const tampered: Block = { header: bad.header, txs: [createCoinbase(2, miner.address, BLOCK_SUBSIDY + 1)] };
    expect(chain.submitBlock(tampered).ok).toBe(false);
    expect(snapChain(chain)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Forks and reorgs (S2-2 block tree, S2-3 fork choice)
// ---------------------------------------------------------------------------

let stamp = 100_000;

/**
 * Mine a block on any parent (null = genesis), not just the chain's tip.
 * Every call gets a fresh timestamp, so two blocks on the same parent always differ.
 */
function mineOn(
  parent: Block | null,
  opts: { txs?: StandardTx[]; fees?: number; miner?: KeyPair; target?: bigint } = {},
): Block {
  return mined(
    assembleBlock({
      prevHash: parent ? blockHash(parent.header) : ZERO_HASH,
      height: parent ? (parent.txs[0] as CoinbaseTx).height + 1 : 0,
      timestamp: stamp++,
      target: opts.target ?? T8,
      minerAddress: (opts.miner ?? other).address,
      txs: opts.txs ?? [],
      fees: opts.fees ?? 0,
    }),
  );
}

/** A straight run of `n` empty blocks on `parent`. */
function runOn(parent: Block, n: number, opts: { target?: bigint } = {}): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < n; i++) out.push(mineOn(out.at(-1) ?? parent, opts));
  return out;
}

const hashOf = (b: Block) => blockHashHex(b.header);
const hashesOf = (bs: readonly Block[]) => bs.map(hashOf);

/** A fresh chain fed `blocks` in order: what the main chain's state must equal after any reorg. */
function replay(blocks: readonly Block[]): Chain {
  const c = new Chain({ target: T8 });
  for (const b of blocks) {
    c.target = b.header.target;
    expect(c.submitBlock(b)).toEqual(extended(b));
  }
  return c;
}

function expectMatchesReplay(chain: Chain): void {
  const fresh = replay(chain.blocks);
  expect(snapUtxos(chain.confirmedUtxos())).toEqual(snapUtxos(fresh.confirmedUtxos()));
  expect(bytesToHex(chain.tipHash)).toBe(bytesToHex(fresh.tipHash));
}

/** g (50 to alice) → base (50 to bob) → a1 (50 to miner) is the main chain. */
function forked() {
  const chain = new Chain({ target: T8 });
  const g = mineOn(null, { miner: alice });
  const base = mineOn(g, { miner: bob });
  const a1 = mineOn(base, { miner });
  for (const b of [g, base, a1]) expect(chain.submitBlock(b)).toEqual(extended(b));
  return { chain, g, base, a1, aliceCoin: op(g.txs[0], 0), bobCoin: op(base.txs[0], 0) };
}

describe('Chain: block tree', () => {
  it('stores a competing block at the same height as stale: on a tie the first block seen stays the tip', () => {
    const { chain, base, a1 } = forked();
    const before = snapChain(chain);
    const b1 = mineOn(base);
    expect(chain.submitBlock(b1)).toEqual({ ok: true, status: 'stale', tipChange: null });
    expect(snapChain(chain)).toEqual(before);
    expect(chain.tree.size).toBe(4);
    expect(chain.tree.tips().map((e) => e.hash).sort()).toEqual(hashesOf([a1, b1]).sort());
    expect(chain.isOnMainChain(hashOf(a1))).toBe(true);
    expect(chain.isOnMainChain(hashOf(b1))).toBe(false);
    expect(chain.submitBlock(b1)).toEqual({ ok: false, error: { code: 'duplicate' } });
  });

  it('holds a block whose parent is unknown as an orphan and connects it when the parent arrives', () => {
    const { chain, a1 } = forked();
    const [a2, a3] = runOn(a1, 2);
    expect(chain.submitBlock(a3)).toEqual({ ok: true, status: 'orphan', tipChange: null });
    expect(chain.tree.orphans()).toEqual([a3]);
    expect(chain.height).toBe(2);
    expect(chain.submitBlock(a3)).toEqual({ ok: false, error: { code: 'duplicate' } });
    expect(chain.submitBlock(a2)).toEqual({ ok: true, status: 'main', tipChange: { disconnected: [], connected: [a2, a3] } });
    expect(chain.tree.orphans()).toEqual([]);
    expect(chain.height).toBe(4);
    expect(bytesToHex(chain.tipHash)).toBe(hashOf(a3));
  });

  it('checks PoW before storing anything, even an orphan', () => {
    const { chain } = forked();
    chain.target = targetFromLeadingZeroBits(40);
    const orphan = assembleBlock({
      prevHash: new Uint8Array(32).fill(7),
      height: 9,
      timestamp: 1,
      target: chain.target,
      minerAddress: other.address,
      txs: [],
      fees: 0,
    });
    expect(chain.submitBlock(orphan)).toEqual({ ok: false, error: { code: 'bad-pow' } });
    expect(chain.tree.orphans()).toEqual([]);
  });

  it('checks the structure of a side-branch block on arrival; it is not stored if that fails', () => {
    const { chain, base } = forked();
    const t = mineOn(base);
    const bad = mined({ header: { ...t.header, nonce: 0, merkleRoot: new Uint8Array(32) }, txs: t.txs });
    expect(chain.submitBlock(bad)).toEqual({ ok: false, error: { code: 'bad-merkle-root' } });
    expect(chain.tree.has(hashOf(bad))).toBe(false);
    expect(chain.tree.invalidReason(hashOf(bad))).toEqual({ code: 'bad-merkle-root' });
  });
});

describe('Chain: fork choice and reorgs', () => {
  it('reorgs when the other branch gets more work: undo to the common ancestor, then apply the new branch', () => {
    const { chain, g, base, a1 } = forked();
    const [b1, b2] = runOn(base, 2);
    expect(chain.submitBlock(b1).ok).toBe(true);
    expect(chain.submitBlock(b2)).toEqual({ ok: true, status: 'main', tipChange: { disconnected: [a1], connected: [b1, b2] } });
    expect(hashesOf(chain.blocks)).toEqual(hashesOf([g, base, b1, b2]));
    expect(chain.height).toBe(3);
    expect(chain.balanceOf(miner.address)).toBe(0); // a1's reward is gone with a1
    expect(chain.balanceOf(other.address)).toBe(2 * BLOCK_SUBSIDY);
    expectMatchesReplay(chain);
    // a1 is now a stale block: still stored, no confirmations
    expect(chain.tree.has(hashOf(a1))).toBe(true);
    expect(chain.isOnMainChain(hashOf(a1))).toBe(false);
    expect(chain.confirmations(hashOf(a1))).toBe(0);
  });

  it('reorgs back and forth; the UTXO set always matches a fresh replay of the main chain', () => {
    const { chain, base, a1 } = forked();
    const [b1, b2] = runOn(base, 2);
    const [a2, a3] = runOn(a1, 2);
    chain.submitBlock(b1);
    expect(chain.submitBlock(b2).ok).toBe(true);
    expectMatchesReplay(chain);
    expect(chain.submitBlock(a2)).toEqual({ ok: true, status: 'stale', tipChange: null }); // tie: b2 was first
    expect(chain.submitBlock(a3)).toEqual({
      ok: true,
      status: 'main',
      tipChange: { disconnected: [b1, b2], connected: [a1, a2, a3] },
    });
    expectMatchesReplay(chain);
    expect(chain.tree.size).toBe(7);
  });

  it('follows the most work, not the longest chain', () => {
    const { chain, base, a1 } = forked();
    const [a2, a3] = runOn(a1, 2); // a-branch above base: 3 easy blocks, work 3 × 256
    chain.submitBlock(a2);
    chain.submitBlock(a3);
    chain.target = T9;
    const [h1, h2] = runOn(base, 2, { target: T9 }); // h-branch: 2 hard blocks, work 2 × 512
    expect(chain.submitBlock(h1)).toEqual({ ok: true, status: 'stale', tipChange: null });
    expect(chain.submitBlock(h2)).toEqual({
      ok: true,
      status: 'main',
      tipChange: { disconnected: [a1, a2, a3], connected: [h1, h2] },
    });
    expect(chain.height).toBe(3); // down from 4
    expect(chain.tree.get(hashOf(h2))!.chainWork).toBeGreaterThan(chain.tree.get(hashOf(a3))!.chainWork);
    expectMatchesReplay(chain);
  });

  it('can replace the whole chain with a branch from a different genesis', () => {
    const chain = new Chain({ target: T8 });
    const g1 = mineOn(null, { miner: alice });
    const g2 = mineOn(null, { miner: bob });
    const [c1] = runOn(g2, 1);
    chain.submitBlock(g1);
    expect(chain.submitBlock(g2)).toEqual({ ok: true, status: 'stale', tipChange: null });
    expect(chain.submitBlock(c1)).toEqual({ ok: true, status: 'main', tipChange: { disconnected: [g1], connected: [g2, c1] } });
    expect(chain.balanceOf(alice.address)).toBe(0);
    expect(chain.balanceOf(bob.address)).toBe(BLOCK_SUBSIDY);
    expectMatchesReplay(chain);
  });

  it('an orphan that arrives first takes over once its parent arrives', () => {
    const { chain, base, a1 } = forked();
    const [b1, b2] = runOn(base, 2);
    expect(chain.submitBlock(b2)).toEqual({ ok: true, status: 'orphan', tipChange: null });
    expect(chain.submitBlock(b1)).toEqual({ ok: true, status: 'main', tipChange: { disconnected: [a1], connected: [b1, b2] } });
    expectMatchesReplay(chain);
  });

  it('any delivery order of a random block tree ends on a most-work tip with a consistent UTXO set', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rng = new Rng(seed);
      const blocks = [mineOn(null, { miner: alice })];
      for (let i = 0; i < 14; i++) blocks.push(mineOn(blocks[rng.int(0, blocks.length - 1)]));
      const maxHeight = Math.max(...blocks.map((b) => (b.txs[0] as CoinbaseTx).height));
      for (let order = 0; order < 2; order++) {
        const shuffled = [...blocks];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = rng.int(0, i);
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const chain = new Chain({ target: T8 });
        for (const b of shuffled) expect(chain.submitBlock(b).ok).toBe(true);
        expect(chain.tree.size).toBe(blocks.length);
        expect(chain.tree.orphans()).toEqual([]);
        expect(chain.height).toBe(maxHeight);
        expectMatchesReplay(chain);
      }
    }
  });
});

describe('Chain: mempool after a reorg', () => {
  it('txs from disconnected blocks go back to the mempool, ahead of the txs already pending', () => {
    const { chain, base, a1, aliceCoin, bobCoin } = forked();
    const txA = spend([[aliceCoin, alice]], [pay(carol, 10 * COIN), pay(alice, 39 * COIN)]);
    const txP = spend([[bobCoin, bob]], [pay(carol, 49 * COIN)]);
    const a2 = mineOn(a1, { txs: [txA], fees: COIN });
    expect(chain.submitBlock(a2)).toEqual(extended(a2));
    expect(chain.submitTransaction(txP).ok).toBe(true);
    expect(chain.txConfirmations(txidHex(txA))).toBe(1);

    for (const b of runOn(base, 3)) chain.submitBlock(b);
    expect(chain.height).toBe(4);
    expect(chain.mempool.map(txidHex)).toEqual([txA, txP].map(txidHex));
    expect(chain.txConfirmations(txidHex(txA))).toBe(0);
    expect(chain.balanceOf(carol.address)).toBe(0);
    expect(chain.balanceOf(carol.address, { includeMempool: true })).toBe(59 * COIN);
    // the next template mines it again
    expect(chain.createBlockTemplate(miner.address, 1).txs.slice(1).map(txidHex)).toEqual([txA, txP].map(txidHex));
  });

  it('a tx confirmed on both branches stays confirmed and does not return to the mempool', () => {
    const { chain, base, a1, aliceCoin } = forked();
    const txA = spend([[aliceCoin, alice]], [pay(carol, 49 * COIN)]);
    chain.submitBlock(mineOn(a1, { txs: [txA], fees: COIN }));
    const b1 = mineOn(base, { txs: [txA], fees: COIN });
    const [b2, b3] = runOn(b1, 2);
    for (const b of [b1, b2, b3]) chain.submitBlock(b);
    expect(bytesToHex(chain.tipHash)).toBe(hashOf(b3));
    expect(chain.mempool).toEqual([]);
    expect(chain.txConfirmations(txidHex(txA))).toBe(3);
    expect(chain.balanceOf(carol.address)).toBe(49 * COIN);
  });

  it('double spend: a tx that conflicts with the new branch is dropped, so the payment vanishes', () => {
    const { chain, base, a1, aliceCoin } = forked();
    const toMerchant = spend([[aliceCoin, alice]], [pay(carol, 49 * COIN)]);
    const toSelf = spend([[aliceCoin, alice]], [pay(other, 49 * COIN)]);
    chain.submitBlock(mineOn(a1, { txs: [toMerchant], fees: COIN }));
    expect(chain.balanceOf(carol.address)).toBe(49 * COIN);
    expect(chain.txConfirmations(txidHex(toMerchant))).toBe(1);

    // a branch with more work confirms the conflicting tx instead
    const b1 = mineOn(base, { txs: [toSelf], fees: COIN });
    for (const b of [b1, ...runOn(b1, 2)]) chain.submitBlock(b);
    expect(chain.mempool).toEqual([]);
    expect(chain.txConfirmations(txidHex(toMerchant))).toBe(0);
    expect(chain.txConfirmations(txidHex(toSelf))).toBe(3);
    expect(chain.balanceOf(carol.address)).toBe(0);
    expect(chain.balanceOf(other.address)).toBe(3 * BLOCK_SUBSIDY + COIN + 49 * COIN);
  });

  it('a tx spending the coinbase of a disconnected block is dropped (that reward only existed on its branch)', () => {
    const { chain, base, a1 } = forked();
    const fromReward = spend([[op(a1.txs[0], 0), miner]], [pay(carol, 49 * COIN)]);
    expect(chain.submitTransaction(fromReward).ok).toBe(true);
    for (const b of runOn(base, 2)) chain.submitBlock(b);
    expect(chain.mempool).toEqual([]);
  });

  it('a pending tx that neither branch touches survives the reorg', () => {
    const { chain, base, bobCoin } = forked();
    const txP = spend([[bobCoin, bob]], [pay(carol, 49 * COIN)]);
    chain.submitTransaction(txP);
    for (const b of runOn(base, 2)) chain.submitBlock(b);
    expect(chain.mempool).toEqual([txP]);
  });
});

describe('Chain: invalid blocks on a side branch', () => {
  const fakeCoin: OutPoint = { txid: new Uint8Array(32).fill(9), index: 0 };
  const ghostSpend = () => spend([[fakeCoin, alice]], [pay(carol, COIN)]);
  const missingInput = { code: 'invalid-tx', index: 1, error: { code: 'missing-input', input: 0 } };

  it('a stale block with invalid spends is stored, then rejected when its branch tries to take over', () => {
    const { chain, base } = forked();
    const bad1 = mineOn(base, { txs: [ghostSpend()] });
    // stage 1 only checks header and structure, so a side-branch block is stored
    expect(chain.submitBlock(bad1)).toEqual({ ok: true, status: 'stale', tipChange: null });
    const before = snapChain(chain);

    // stage 2 runs when the branch would take over: bad1's spend fails and the node stays put
    const [bad2, bad3] = runOn(bad1, 2);
    expect(chain.submitBlock(bad2)).toEqual({ ok: false, error: { code: 'invalid-parent' } });
    expect(snapChain(chain)).toEqual(before);
    expectMatchesReplay(chain);
    expect(chain.tree.has(hashOf(bad1))).toBe(false);
    expect(chain.tree.invalidReason(hashOf(bad1))).toEqual(missingInput);
    expect(chain.submitBlock(bad1)).toEqual({ ok: false, error: missingInput });
    expect(chain.submitBlock(bad3)).toEqual({ ok: false, error: { code: 'invalid-parent' } });
  });

  it("an invalid block on the main chain's tip is rejected straight away with its own error", () => {
    const { chain, a1 } = forked();
    const before = snapChain(chain);
    expect(chain.submitBlock(mineOn(a1, { txs: [ghostSpend()] }))).toEqual({ ok: false, error: missingInput });
    expect(snapChain(chain)).toEqual(before);
  });

  it('a failure part-way through a reorg rolls back to the best branch that is still valid', () => {
    const { chain, base, a1, bobCoin } = forked();
    chain.submitBlock(mineOn(a1));
    chain.submitTransaction(spend([[bobCoin, bob]], [pay(carol, 49 * COIN)]));
    const b1 = mineOn(base);
    const b2 = mineOn(b1, { txs: [ghostSpend()] });
    const [b3] = runOn(b2, 1);
    expect(chain.submitBlock(b1)).toMatchObject({ ok: true, status: 'stale' });
    expect(chain.submitBlock(b2)).toMatchObject({ ok: true, status: 'stale' });
    const before = snapChain(chain);
    // b3 gives the b-branch more work: the node undoes a2 and a1, applies b1, then b2 fails
    expect(chain.submitBlock(b3)).toEqual({ ok: false, error: { code: 'invalid-parent' } });
    expect(snapChain(chain)).toEqual(before);
    expectMatchesReplay(chain);
    expect(chain.tree.has(hashOf(b1))).toBe(true); // b1 itself is valid, so it stays as a stale block
    expect(chain.tree.has(hashOf(b2))).toBe(false);
  });
});

describe('Chain: confirmations', () => {
  it('counts main-chain blocks from a block to the tip, inclusive', () => {
    const { chain, g, base, a1 } = forked();
    expect(chain.confirmations(hashOf(a1))).toBe(1);
    expect(chain.confirmations(hashOf(g))).toBe(3);
    const more = runOn(a1, 5);
    for (const b of more) chain.submitBlock(b);
    expect(chain.confirmations(hashOf(a1))).toBe(6);
    expect(chain.confirmations(hashOf(base))).toBe(7);
    expect(chain.confirmations(hashOf(more[4]))).toBe(1);
  });

  it('is 0 for stale, orphan and unknown blocks', () => {
    const { chain, base, a1 } = forked();
    const stale = mineOn(base);
    const orphan = runOn(a1, 2)[1];
    chain.submitBlock(stale);
    chain.submitBlock(orphan);
    expect(chain.confirmations(hashOf(stale))).toBe(0);
    expect(chain.confirmations(hashOf(orphan))).toBe(0);
    expect(chain.confirmations('00'.repeat(32))).toBe(0);
  });

  it('a tx has the confirmations of its main-chain block; 0 in the mempool or unknown', () => {
    const { chain, g, aliceCoin } = forked();
    expect(chain.txConfirmations(txidHex(g.txs[0]))).toBe(3);
    const tx = spend([[aliceCoin, alice]], [pay(carol, 49 * COIN)]);
    chain.submitTransaction(tx);
    expect(chain.txConfirmations(txidHex(tx))).toBe(0);
    const b = mined(chain.createBlockTemplate(miner.address, 1));
    chain.submitBlock(b);
    expect(chain.txConfirmations(txidHex(tx))).toBe(1);
    chain.submitBlock(mineOn(b));
    expect(chain.txConfirmations(txidHex(tx))).toBe(2);
    expect(chain.txConfirmations('ab'.repeat(32))).toBe(0);
  });
});
