import { describe, expect, it } from 'vitest';
import { type Block, ZERO_HASH, blockHashHex } from '../core/block';
import { bytesToHex, hexToBytes } from '../core/hash';
import { type KeyPair, keyPairFromPrivate } from '../core/keys';
import { assembleBlock, mineChunk } from '../core/miner';
import { chainMetrics, revenueShare } from '../experiments/metrics';
import { selfishRevenue } from '../experiments/theory';
import { type MinerContext, SIMULATED_POW_TARGET } from '../network/mining';
import { Network, type NodeId } from '../network/network';
import { Chain } from '../node/chain';
import { HonestMiner, type TieBreak } from './honest';
import { SelfishMiner } from './selfish';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const keyN = (n: number): KeyPair => keyPairFromPrivate(hexToBytes(n.toString(16).padStart(64, '0')));
const selfishKey = keyN(1);
const honestKey = keyN(2);

const solve = (t: Block): Block => ({ header: mineChunk(t.header, 1).header, txs: t.txs });

const GENESIS = solve(
  assembleBlock({
    prevHash: ZERO_HASH, height: 0, timestamp: 0, target: SIMULATED_POW_TARGET, minerAddress: keyN(999).address, txs: [], fees: 0,
  }),
);

const hashOf = (b: Block) => blockHashHex(b.header);
const payee = (b: Block) => b.txs[0].outputs[0].address;
const knows = (chain: Chain, b: Block) => chain.tree.has(hashOf(b));
/** Who found each main-chain block after genesis: 'S' for the selfish miner, 'H' for honest. */
const mainChainBy = (chain: Chain) => chain.blocks.slice(1).map((b) => (payee(b) === selfishKey.address ? 'S' : 'H')).join('');

/**
 * Selfish miner S, honest miner H, and an observer O that doesn't mine, all
 * linked with 1 s latency. Nobody mines until a test hands out hash power.
 */
function setup(tieBreak?: Omit<TieBreak, 'favour'>) {
  const net = new Network({ seed: 11, genesis: GENESIS });
  const [S, H, O] = [net.addNode(), net.addNode(), net.addNode()];
  net.connect(S, H, { latency: 1 });
  net.connect(H, O, { latency: 1 });
  net.connect(S, O, { latency: 1 });
  const selfish = new SelfishMiner(selfishKey.address);
  net.mining.setMiner(S, selfish, 0);
  net.mining.setMiner(H, new HonestMiner(honestKey.address, tieBreak && { tieBreak: { favour: selfishKey.address, ...tieBreak } }), 0);
  const all = [S, H, O].map((id) => net.node(id).chain);
  const status = () => selfish.status(net.node(S).chain);
  return { net, S, H, all, selfish, status };
}

function runBlocks(net: Network, n: number): void {
  for (let found = 0; found < n; ) {
    const e = net.sim.step();
    if (!e) throw new Error('ran out of events');
    if (e.type === 'block-found') found++;
  }
}

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
// The state machine, one transition at a time (Eyal & Sirer, Algorithm 1)
// ---------------------------------------------------------------------------

describe('SelfishMiner: state machine', () => {
  it('state 0 → 1 → 2: keeps the blocks it finds to itself', () => {
    const { net, S, all, selfish, status } = setup();
    expect(status()).toEqual({ state: '0', lead: 0, withheld: 0 });
    mineBy(net, S, 1);
    expect(status()).toEqual({ state: '1', lead: 1, withheld: 1 });
    mineBy(net, S, 1);
    expect(status()).toEqual({ state: '2', lead: 2, withheld: 2 });
    for (const chain of all) {
      expect(chain.height).toBe(0);
      for (const b of selfish.withheld) expect(knows(chain, b)).toBe(false);
    }
    // They extend each other.
    expect(selfish.withheld[1].header.prevHash).toEqual(hexToBytes(hashOf(selfish.withheld[0])));
  });

  it('state 0, honest block: nothing to hide, so it simply mines on the new tip', () => {
    const { net, S, H, all, status } = setup();
    mineBy(net, H, 1);
    expect(status()).toEqual({ state: '0', lead: 0, withheld: 0 });
    mineBy(net, S, 1);
    expect(status()).toEqual({ state: '1', lead: 1, withheld: 1 });
    mineBy(net, H, 1); // caught up, so the race begins (next test)
    for (const chain of all) expect(chain.blocks[1].txs[0].outputs[0].address).toBe(honestKey.address);
  });

  it("state 1, honest block: publishes its block to tie (→ 0′); nodes keep the block they saw first", () => {
    const { net, S, H, all, selfish, status } = setup();
    mineBy(net, S, 1);
    const ours = selfish.withheld[0];
    mineBy(net, H, 1);
    expect(status()).toEqual({ state: "0'", lead: 0, withheld: 0 });
    expect(selfish.counters.races).toBe(1);
    for (const chain of all) {
      expect(knows(chain, ours)).toBe(true);
      expect(chain.height).toBe(1);
      expect(payee(chain.blocks[1])).toBe(honestKey.address); // the honest block reached everyone first
    }
  });

  it("state 0′, selfish block: publishes at once and wins both blocks (→ 0)", () => {
    const { net, S, H, all, selfish, status } = setup();
    mineBy(net, S, 1);
    mineBy(net, H, 1);
    mineBy(net, S, 1);
    expect(status()).toEqual({ state: '0', lead: 0, withheld: 0 });
    expect(selfish.counters).toMatchObject({ racesWonByUs: 1, overrides: 1 });
    for (const chain of all) {
      expect(mainChainBy(chain)).toBe('SS');
      expect(chain.tree.size).toBe(4); // genesis, two selfish blocks and the stale honest one
    }
  });

  it("state 0′, honest block on the honest side (γ = 0): the selfish block goes stale (→ 0)", () => {
    const { net, S, H, all, status } = setup({ gamma: 0 });
    mineBy(net, S, 1);
    mineBy(net, H, 1);
    mineBy(net, H, 1);
    expect(status()).toEqual({ state: '0', lead: 0, withheld: 0 });
    for (const chain of all) expect(mainChainBy(chain)).toBe('HH');
  });

  it("state 0′, honest block on the selfish side (γ = 1): the selfish block is kept, the honest one goes stale (→ 0)", () => {
    const { net, S, H, all, status } = setup({ gamma: 1 });
    mineBy(net, S, 1);
    mineBy(net, H, 1);
    mineBy(net, H, 1);
    expect(status()).toEqual({ state: '0', lead: 0, withheld: 0 });
    for (const chain of all) expect(mainChainBy(chain)).toBe('SH');
  });

  it('state 2, honest block: publishes everything and overrides the public chain (→ 0)', () => {
    const { net, S, H, all, selfish, status } = setup();
    mineBy(net, S, 2);
    mineBy(net, H, 1);
    expect(status()).toEqual({ state: '0', lead: 0, withheld: 0 });
    expect(selfish.counters.overrides).toBe(1);
    for (const chain of all) {
      expect(mainChainBy(chain)).toBe('SS');
      expect(chain.tree.size).toBe(4); // the honest block is stale
    }
  });

  it('state n > 2, honest block: publishes one block to match, then cashes in at lead 1', () => {
    const { net, S, H, all, selfish, status } = setup();
    mineBy(net, S, 4);
    const ours = [...selfish.withheld];
    expect(status()).toEqual({ state: '>2', lead: 4, withheld: 4 });

    mineBy(net, H, 1); // 4 → 3: our block #1 comes out; nodes keep the honest #1, seen first
    expect(status()).toEqual({ state: '>2', lead: 3, withheld: 3 });
    for (const chain of all) {
      expect(knows(chain, ours[0])).toBe(true);
      expect(knows(chain, ours[1])).toBe(false);
      expect(mainChainBy(chain)).toBe('H');
    }

    mineBy(net, H, 1); // 3 → 2: our #2 comes out
    expect(status()).toEqual({ state: '2', lead: 2, withheld: 2 });
    for (const chain of all) expect(mainChainBy(chain)).toBe('HH');

    mineBy(net, H, 1); // 2 → 0: our lead would be 1, so all of it comes out and wins
    expect(status()).toEqual({ state: '0', lead: 0, withheld: 0 });
    for (const chain of all) {
      expect(mainChainBy(chain)).toBe('SSSS');
      expect(chain.tree.size).toBe(8); // three honest blocks went stale
    }
  });

  it('throws its private blocks away if the public chain gets ahead in one go', () => {
    // Two nodes. The honest node's first block takes 100 s to arrive; its
    // second takes 1 s, gets there first and waits as an orphan. When the
    // first lands, the public chain jumps from height 0 to 2, past our 1.
    const net = new Network({ seed: 3, genesis: GENESIS, blockInterval: 1 });
    const [S, H] = [net.addNode(), net.addNode()];
    net.connect(S, H, { latency: 1 });
    const selfish = new SelfishMiner(selfishKey.address);
    net.mining.setMiner(S, selfish, 0);
    net.mining.setMiner(H, new HonestMiner(honestKey.address), 0);
    mineBy(net, S, 1);

    net.updateLink(S, H, { latency: 100 });
    net.mining.setHashPower(H, 1);
    runBlocks(net, 1);
    net.updateLink(S, H, { latency: 1 });
    runBlocks(net, 1);
    settle(net);

    const chain = net.node(S).chain;
    expect(selfish.status(chain)).toEqual({ state: '0', lead: 0, withheld: 0 });
    expect(selfish.counters.discarded).toBe(1);
    expect(mainChainBy(chain)).toBe('HH');
  });

  it('releaseAll publishes every withheld block at the end of a run, and every node takes the longer branch', () => {
    const { net, S, H, all, selfish, status } = setup();
    mineBy(net, H, 1);
    mineBy(net, S, 3);
    const hidden = [...selfish.withheld];
    expect(hidden).toHaveLength(3);
    expect(selfish.releaseAll(net.mining.nodeContext(S))).toBe(3);
    settle(net);
    expect(status()).toEqual({ state: '0', lead: 0, withheld: 0 });
    for (const chain of all) {
      expect(mainChainBy(chain)).toBe('HSSS');
      for (const b of hidden) expect(chain.isOnMainChain(hashOf(b))).toBe(true);
    }
    expect(selfish.releaseAll(net.mining.nodeContext(S))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// γ: which side of a tie honest miners build on
// ---------------------------------------------------------------------------

describe('HonestMiner tie-break, the γ of selfish mining', () => {
  const block = (payTo: KeyPair, t: number) =>
    solve(assembleBlock({ prevHash: hexToBytes(hashOf(GENESIS)), height: 1, timestamp: t, target: SIMULATED_POW_TARGET, minerAddress: payTo.address, txs: [], fees: 0 }));
  const selfishBlock = block(selfishKey, 1);
  const honestBlock = block(keyN(3), 2);

  /** A chain that saw `first` and then `second`: a tie, with `first` as its tip. */
  function tied(first: Block, second: Block) {
    const chain = new Chain({ target: SIMULATED_POW_TARGET });
    chain.submitBlock(GENESIS);
    chain.submitBlock(first);
    chain.submitBlock(second);
    return chain;
  }

  /** The parent of the block an honest miner with this γ builds, given the draw `r`. */
  function parentChosen(chain: Chain, gamma: number, r: number): string {
    const published: Block[] = [];
    const ctx: MinerContext = {
      id: 0, chain, timestamp: 10, solve, random: () => r,
      publish: (b) => (published.push(b), chain.submitBlock(b)),
      broadcastTransaction: (tx) => chain.submitTransaction(tx),
    };
    new HonestMiner(honestKey.address, { tieBreak: { favour: selfishKey.address, gamma } }).onBlockFound(ctx);
    return bytesToHex(published[0].header.prevHash);
  }

  it('builds on the selfish block with probability γ, whichever block the node saw first', () => {
    for (const chain of [() => tied(honestBlock, selfishBlock), () => tied(selfishBlock, honestBlock)]) {
      expect(parentChosen(chain(), 0, 0)).toBe(hashOf(honestBlock));
      expect(parentChosen(chain(), 1, 0.999)).toBe(hashOf(selfishBlock));
      expect(parentChosen(chain(), 0.5, 0.3)).toBe(hashOf(selfishBlock));
      expect(parentChosen(chain(), 0.5, 0.7)).toBe(hashOf(honestBlock));
    }
  });

  it('only applies to a tie between the favoured miner and someone else', () => {
    const plain = new Chain({ target: SIMULATED_POW_TARGET });
    plain.submitBlock(GENESIS);
    plain.submitBlock(honestBlock);
    expect(parentChosen(plain, 1, 0)).toBe(hashOf(honestBlock)); // no tie at all

    const twoHonest = tied(honestBlock, block(keyN(4), 3));
    expect(parentChosen(twoHonest, 1, 0)).toBe(hashOf(honestBlock)); // a tie, but not with the favoured miner
  });

  it('rejects a γ outside [0, 1]', () => {
    expect(() => new HonestMiner(honestKey.address, { tieBreak: { favour: selfishKey.address, gamma: 1.5 } })).toThrow(RangeError);
    expect(() => new HonestMiner(honestKey.address, { tieBreak: { favour: selfishKey.address, gamma: NaN } })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Revenue against the paper
// ---------------------------------------------------------------------------

describe('SelfishMiner revenue matches Eyal & Sirer', () => {
  /**
   * A long run with no latency: the honest side acts as one miner, as in the
   * paper, and ties are split by γ alone. Returns the selfish miner's share
   * of the main chain.
   */
  function revenue(alpha: number, gamma: number, blocks: number, seed = 5): number {
    const net = new Network({ seed, genesis: GENESIS });
    const [S, H] = [net.addNode(), net.addNode()];
    net.connect(S, H, { latency: 0 });
    net.mining.setMiner(S, new SelfishMiner(selfishKey.address), alpha);
    net.mining.setMiner(H, new HonestMiner(honestKey.address, { tieBreak: { favour: selfishKey.address, gamma } }), 1 - alpha);
    runBlocks(net, blocks);
    settle(net);
    return revenueShare(chainMetrics(net.node(H).chain, net.mining.minedBlocks()), S);
  }

  it.each([
    [0.4, 0],
    [0.4, 0.5],
    [0.3, 0.5],
  ])('α = %s, γ = %s: within 0.03 of the formula, and above the fair share α', (alpha, gamma) => {
    const r = revenue(alpha, gamma, 3000);
    expect(Math.abs(r - selfishRevenue(alpha, gamma))).toBeLessThan(0.03);
    expect(r).toBeGreaterThan(alpha);
  });

  it('below the threshold (α = 0.25, γ = 0) it earns less than honest mining would', () => {
    const r = revenue(0.25, 0, 3000);
    expect(Math.abs(r - selfishRevenue(0.25, 0))).toBeLessThan(0.03);
    expect(r).toBeLessThan(0.25);
  });
});
