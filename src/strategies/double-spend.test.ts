import { describe, expect, it } from 'vitest';
import { type Block, ZERO_HASH, blockHashHex } from '../core/block';
import { hexToBytes } from '../core/hash';
import { type KeyPair, keyPairFromPrivate } from '../core/keys';
import { BLOCK_SUBSIDY, assembleBlock, mineChunk } from '../core/miner';
import { COIN, outPointKey, txidHex } from '../core/transaction';
import { SIMULATED_POW_TARGET } from '../network/mining';
import { Network, type NodeId } from '../network/network';
import type { Chain } from '../node/chain';
import { DEFAULT_ATTACK_FEE, DoubleSpendAttacker, type DoubleSpendOptions } from './double-spend';
import { HonestMiner } from './honest';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const keyN = (n: number): KeyPair => keyPairFromPrivate(hexToBytes(n.toString(16).padStart(64, '0')));
const attackerKey = keyN(1);
const merchantKey = keyN(2);
const honestKey = keyN(3);

/** With simulated PoW the first nonce always works. */
const solve = (t: Block): Block => ({ header: mineChunk(t.header, 1).header, txs: t.txs });

/** Genesis pays the attacker 50 coins, so it can launch straight away. */
const GENESIS = solve(
  assembleBlock({
    prevHash: ZERO_HASH, height: 0, timestamp: 0, target: SIMULATED_POW_TARGET, minerAddress: attackerKey.address, txs: [], fees: 0,
  }),
);

const PAY = 10 * COIN;

const hashOf = (b: Block) => blockHashHex(b.header);
const tipOf = (chain: Chain) => hashOf(chain.blocks.at(-1)!);
const coinbasePayee = (b: Block) => b.txs[0].outputs[0].address;
/** Whether the node has stored the block anywhere: main chain, side branch or orphan pool. */
const knows = (chain: Chain, b: Block) => chain.tree.has(hashOf(b)) || chain.tree.isOrphan(hashOf(b));

interface Latencies {
  ah?: number;
  hm?: number;
  am?: number;
}

/**
 * A triangle of nodes: the attacker A, an honest miner H, and the merchant's
 * node M, which doesn't mine. Nobody mines until a test hands out hash power.
 * The merchant waits for 2 confirmations; the attacker gives up 3 blocks behind.
 */
function setup(opts: Partial<DoubleSpendOptions> = {}, latency: Latencies = {}) {
  const net = new Network({ seed: 7, genesis: GENESIS });
  const [A, H, M] = [net.addNode(), net.addNode(), net.addNode()];
  net.connect(A, H, { latency: latency.ah ?? 1 });
  net.connect(H, M, { latency: latency.hm ?? 1 });
  net.connect(A, M, { latency: latency.am ?? 1 });
  const attacker = new DoubleSpendAttacker({
    key: attackerKey, merchant: merchantKey.address, amount: PAY, confirmations: 2, maxDeficit: 3, ...opts,
  });
  net.mining.setMiner(A, attacker, 0);
  net.mining.setMiner(H, new HonestMiner(honestKey.address), 0);
  const all = [A, H, M].map((id) => net.node(id).chain);
  return { net, A, H, M, all, attacker, launch: () => attacker.launch(net.mining.nodeContext(A)) };
}

/** Fire events until `n` more blocks have been found. */
function runBlocks(net: Network, n: number): void {
  for (let found = 0; found < n; ) {
    const e = net.sim.step();
    if (!e) throw new Error('ran out of events');
    if (e.type === 'block-found') found++;
  }
}

/** Switch every miner off and deliver every block still on the wire. */
function settle(net: Network): void {
  for (const id of net.mining.minerIds()) net.mining.setHashPower(id, 0);
  while (net.sim.step());
}

/** Only node `id` mines, until it has found `n` blocks; then everything on the wire is delivered. */
function mineBy(net: Network, id: NodeId, n: number): void {
  for (const m of net.mining.minerIds()) net.mining.setHashPower(m, m === id ? 1 : 0);
  runBlocks(net, n);
  settle(net);
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

describe('DoubleSpendAttacker: launch', () => {
  it('broadcasts the payment and keeps a conflicting tx that pays itself', () => {
    const { net, H, all, attacker, launch } = setup();
    launch();
    const payment = attacker.payment!;
    const doubleSpend = attacker.doubleSpend!;

    expect(payment.outputs[0]).toEqual({ value: PAY, address: merchantKey.address });
    // The same coins, all of it back to the attacker, less the same fee.
    expect(doubleSpend.inputs.map((i) => outPointKey(i.prevOut))).toEqual(payment.inputs.map((i) => outPointKey(i.prevOut)));
    expect(doubleSpend.outputs).toEqual([{ value: 50 * COIN - DEFAULT_ATTACK_FEE, address: attackerKey.address }]);

    for (const chain of all) expect(chain.mempool.map(txidHex)).toEqual([txidHex(payment)]);
    // The replacement could never be broadcast: every mempool already holds the payment.
    expect(net.node(H).chain.submitTransaction(doubleSpend).ok).toBe(false);

    expect(attacker.phase).toBe('mining');
    expect(attacker.outcome).toBe('pending');
    expect(attacker.forkHeight).toBe(0);
    expect(attacker.race()).toEqual({ privateBlocks: 0, publicBlocks: 0, confirmations: 0 });
  });

  it("refuses to launch without the coins to pay, and doesn't launch twice", () => {
    const poor = setup({ amount: 50 * COIN }); // 50 coins, but amount + fee is 50.001
    expect(poor.launch).toThrow(/needs 50\.001 coins/);
    expect(poor.attacker.phase).toBe('idle');
    expect(poor.attacker.race()).toBeNull();
    for (const chain of poor.all) expect(chain.mempool).toHaveLength(0);

    const { attacker, launch } = setup();
    launch();
    expect(launch).toThrow(/already been launched/);
    expect(attacker.phase).toBe('mining');
  });

  it('checks its options', () => {
    const base: DoubleSpendOptions = { key: attackerKey, merchant: merchantKey.address, amount: PAY, confirmations: 1, maxDeficit: 1 };
    expect(() => new DoubleSpendAttacker({ ...base, amount: 0 })).toThrow(RangeError);
    expect(() => new DoubleSpendAttacker({ ...base, fee: -1 })).toThrow(RangeError);
    expect(() => new DoubleSpendAttacker({ ...base, confirmations: 0 })).toThrow(RangeError);
    expect(() => new DoubleSpendAttacker({ ...base, maxDeficit: 1.5 })).toThrow(RangeError);
    expect(() => new DoubleSpendAttacker({ ...base, maxDeficit: NaN })).toThrow(RangeError);
    expect(() => new DoubleSpendAttacker({ ...base, maxDeficit: Infinity })).not.toThrow();
    expect(() => new DoubleSpendAttacker({ ...base, merchant: 'not an address' })).toThrow(/merchant/);
  });

  it('mines honestly until it is launched', () => {
    const { net, A, all, attacker } = setup();
    mineBy(net, A, 2);
    for (const chain of all) {
      expect(chain.height).toBe(2);
      expect(chain.balanceOf(attackerKey.address)).toBe(50 * COIN + 2 * BLOCK_SUBSIDY);
    }
    expect(attacker.privateBranch).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The race, one block at a time
// ---------------------------------------------------------------------------

describe('DoubleSpendAttacker: the race', () => {
  it('withholds its branch through a tie, then releases it with more work and reverses the payment', () => {
    const { net, A, H, M, all, attacker, launch } = setup();
    launch();
    const paymentId = txidHex(attacker.payment!);
    const doubleSpendId = txidHex(attacker.doubleSpend!);

    mineBy(net, H, 2); // two confirmations: the merchant ships
    expect(net.node(M).chain.txConfirmations(paymentId)).toBe(2);
    expect(net.node(M).chain.balanceOf(merchantKey.address)).toBe(PAY);

    mineBy(net, A, 2); // level with the public chain: not enough, since nodes keep the branch they saw first
    expect(attacker.phase).toBe('mining');
    expect(attacker.race()).toEqual({ privateBlocks: 2, publicBlocks: 2, confirmations: 2 });
    for (const chain of all) for (const b of attacker.privateBranch) expect(knows(chain, b)).toBe(false);
    for (const b of attacker.privateBranch) expect(net.mining.minedBlock(hashOf(b))?.miner).toBe(A);

    mineBy(net, A, 1); // one block ahead: release
    expect(attacker.phase).toBe('released');
    expect(attacker.outcome).toBe('success');
    expect(attacker.race()).toEqual({ privateBlocks: 3, publicBlocks: 2, confirmations: 2 });
    expect(attacker.privateBranch[0].txs.map(txidHex)).toContain(doubleSpendId);

    for (const chain of all) {
      expect(tipOf(chain)).toBe(hashOf(attacker.privateBranch[2]));
      expect(chain.txConfirmations(doubleSpendId)).toBe(3);
      expect(chain.txConfirmations(paymentId)).toBe(0);
      expect(chain.mempool).toHaveLength(0); // the payment can't come back: its coins are spent
      expect(chain.balanceOf(merchantKey.address)).toBe(0);
      // Its 50 coins back (D's fee returns in its own coinbase), plus three block rewards.
      expect(chain.balanceOf(attackerKey.address)).toBe(50 * COIN + 3 * BLOCK_SUBSIDY);
      expect(chain.balanceOf(honestKey.address)).toBe(0);
    }
  });

  it("waits for the merchant's confirmations even when ahead, and releases on the block that brings the last one", () => {
    const { net, A, H, M, all, attacker, launch } = setup();
    launch();
    mineBy(net, A, 3); // well ahead, but the payment isn't confirmed: the merchant hasn't shipped
    expect(attacker.phase).toBe('mining');
    expect(net.node(M).chain.height).toBe(0);

    mineBy(net, H, 1);
    expect(attacker.phase).toBe('mining');
    expect(attacker.race()).toEqual({ privateBlocks: 3, publicBlocks: 1, confirmations: 1 });

    mineBy(net, H, 1); // the second confirmation reaches the attacker's node, which releases at once
    expect(attacker.phase).toBe('released');
    expect(attacker.race()).toEqual({ privateBlocks: 3, publicBlocks: 2, confirmations: 2 });
    expect(attacker.outcome).toBe('success');
    for (const chain of all) {
      expect(tipOf(chain)).toBe(hashOf(attacker.privateBranch[2]));
      expect(chain.balanceOf(merchantKey.address)).toBe(0);
    }
  });

  it('gives up maxDeficit blocks behind, never publishes the branch, and mines honestly again', () => {
    const { net, A, H, all, attacker, launch } = setup();
    launch();
    const paymentId = txidHex(attacker.payment!);
    mineBy(net, A, 1);
    mineBy(net, H, 3); // 2 behind: keep going
    expect(attacker.phase).toBe('mining');

    mineBy(net, H, 1); // 3 behind
    expect(attacker.phase).toBe('abandoned');
    expect(attacker.outcome).toBe('failed');
    const final = { privateBlocks: 1, publicBlocks: 4, confirmations: 4 };
    expect(attacker.race()).toEqual(final);

    mineBy(net, A, 1); // honest again: on the public tip, published at once
    expect(attacker.race()).toEqual(final);
    for (const chain of all) {
      expect(chain.height).toBe(5);
      expect(coinbasePayee(chain.blocks[5])).toBe(attackerKey.address);
      expect(chain.txConfirmations(paymentId)).toBe(5);
      expect(chain.balanceOf(merchantKey.address)).toBe(PAY);
      expect(knows(chain, attacker.privateBranch[0])).toBe(false);
    }
  });

  it('reads the outcome live: a released branch can still lose to an honest block that was on the wire', () => {
    // The attacker is 100 s from everyone; the honest miner and the merchant are next to each other.
    const { net, A, H, all, attacker, launch } = setup({ confirmations: 1, maxDeficit: 5 }, { ah: 100, hm: 0, am: 100 });
    const [chainA, chainH, chainM] = all;
    launch();
    const paymentId = txidHex(attacker.payment!);
    mineBy(net, A, 2);

    // Two honest blocks in quick succession. When the first reaches the attacker,
    // it brings the merchant's confirmation and the attacker (2 blocks against 1)
    // releases, not knowing the second is already on its way.
    net.mining.blockInterval = 1;
    net.mining.setHashPower(H, 1);
    runBlocks(net, 2);
    settle(net);
    expect(attacker.phase).toBe('released');
    expect(attacker.race()).toEqual({ privateBlocks: 2, publicBlocks: 1, confirmations: 1 });
    // Every node now holds both branches at equal work, and each keeps the one it saw first.
    expect(tipOf(chainA)).toBe(hashOf(attacker.privateBranch[1]));
    expect(tipOf(chainH)).toBe(tipOf(chainM));
    expect(chainH.txConfirmations(paymentId)).toBe(2);
    expect(attacker.outcome).toBe('success'); // as the attacker's node sees it, for now

    mineBy(net, H, 1); // the honest side breaks the tie
    expect(attacker.outcome).toBe('failed');
    for (const chain of all) {
      expect(chain.height).toBe(3);
      expect(chain.txConfirmations(paymentId)).toBe(3);
      expect(chain.balanceOf(merchantKey.address)).toBe(PAY);
    }
  });
});

// ---------------------------------------------------------------------------
// Hash power decides
// ---------------------------------------------------------------------------

describe('DoubleSpendAttacker: hash power decides', () => {
  /**
   * One attack from launch to release or give-up, with both sides mining
   * freely. Zero latency, so no honest block is ever on the wire when the
   * attacker releases, and the outcome is final.
   */
  function trial(seed: number, attackerShare: number, opts: Pick<DoubleSpendOptions, 'confirmations' | 'maxDeficit'>) {
    const net = new Network({ seed, genesis: GENESIS });
    const [A, H] = [net.addNode(), net.addNode()];
    net.connect(A, H, { latency: 0 });
    const attacker = new DoubleSpendAttacker({ key: attackerKey, merchant: merchantKey.address, amount: PAY, ...opts });
    net.mining.setMiner(A, attacker, attackerShare);
    net.mining.setMiner(H, new HonestMiner(honestKey.address), 1 - attackerShare);
    attacker.launch(net.mining.nodeContext(A));
    for (let events = 0; attacker.phase === 'mining'; events++) {
      if (events > 100_000) throw new Error('the attack never ended');
      net.sim.step();
    }
    settle(net);

    // Every node agrees with the attacker's verdict.
    const chain = net.node(H).chain;
    const reversed = chain.txConfirmations(txidHex(attacker.doubleSpend!)) > 0;
    expect(reversed).toBe(attacker.outcome === 'success');
    expect(chain.txConfirmations(txidHex(attacker.payment!)) > 0).toBe(!reversed);
    return attacker.outcome;
  }

  const successes = (seeds: number, share: number, opts: Pick<DoubleSpendOptions, 'confirmations' | 'maxDeficit'>) =>
    Array.from({ length: seeds }, (_, i) => trial(i + 1, share, opts)).filter((o) => o === 'success').length;

  it('with more than half the hash power it gets there in the end, however long the merchant waits', () => {
    expect(successes(25, 0.55, { confirmations: 6, maxDeficit: 60 })).toBe(25);
  });

  it('the 51% attack: never giving up, it succeeds every time, even from far behind', () => {
    expect(successes(25, 0.55, { confirmations: 6, maxDeficit: Infinity })).toBe(25);
    expect(successes(10, 0.55, { confirmations: 20, maxDeficit: Infinity })).toBe(10);
  });

  it('with a minority it mostly fails, and more confirmations make it fail more often', () => {
    const quick = successes(60, 0.3, { confirmations: 1, maxDeficit: 10 });
    const careful = successes(60, 0.3, { confirmations: 6, maxDeficit: 10 });
    expect(quick).toBeLessThan(30);
    expect(careful).toBeLessThan(quick);
  });
});
