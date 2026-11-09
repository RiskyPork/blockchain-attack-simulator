import { describe, expect, it } from 'vitest';
import { type Block, ZERO_HASH, blockHashHex } from '../core/block';
import { hexToBytes } from '../core/hash';
import { type KeyPair, keyPairFromPrivate } from '../core/keys';
import { BLOCK_SUBSIDY, assembleBlock, mineChunk } from '../core/miner';
import { COIN, isCoinbase, txidHex } from '../core/transaction';
import { type MinerContext, SIMULATED_POW_TARGET } from '../network/mining';
import { Network } from '../network/network';
import { Chain } from '../node/chain';
import { buildPayment } from '../node/wallet';
import { HonestMiner } from './honest';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const keyN = (n: number): KeyPair => keyPairFromPrivate(hexToBytes(n.toString(16).padStart(64, '0')));
const alice = keyN(1);
const bob = keyN(2);
const carol = keyN(3);

const solve = (t: Block): Block => ({ header: mineChunk(t.header, Number.MAX_SAFE_INTEGER).header, txs: t.txs });

const GENESIS = solve(
  assembleBlock({
    prevHash: ZERO_HASH, height: 0, timestamp: 0, target: SIMULATED_POW_TARGET, minerAddress: keyN(999).address, txs: [], fees: 0,
  }),
);

function newChain(): Chain {
  const chain = new Chain({ target: SIMULATED_POW_TARGET });
  chain.submitBlock(GENESIS);
  return chain;
}

/** A context like the engine's, on a standalone chain, that keeps what the miner publishes. */
function contextOn(chain: Chain, timestamp: number) {
  const published: Block[] = [];
  const ctx: MinerContext = {
    id: 0,
    chain,
    timestamp,
    solve,
    publish: (block) => {
      published.push(block);
      return chain.submitBlock(block);
    },
  };
  return { ctx, published };
}

const coinbasePayee = (b: Block) => b.txs[0].outputs[0].address;

function runBlocks(net: Network, count: number): void {
  for (let found = 0; found < count; ) {
    const e = net.sim.step();
    if (!e) throw new Error('ran out of events');
    if (e.type === 'block-found') found++;
  }
}

/** Switch every miner off and let the blocks still on the wire arrive. */
function stopAndSettle(net: Network): void {
  for (const id of net.mining.minerIds()) net.mining.setHashPower(id, 0);
  while (net.sim.step());
}

const staleCount = (chain: Chain) => chain.tree.size - (chain.height + 1);

/**
 * Three honest miners with equal power on a fully connected network, mining
 * `blocks` blocks. With latency 4 s against a 10 s block interval, a block
 * often hasn't reached the others before one of them finds a competing block.
 */
function threeMiners(latency: number, blocks: number, seed = 3) {
  const net = new Network({ seed, genesis: GENESIS, blockInterval: 10 });
  const ids = [net.addNode(), net.addNode(), net.addNode()];
  net.connect(ids[0], ids[1], { latency });
  net.connect(ids[1], ids[2], { latency });
  net.connect(ids[0], ids[2], { latency });
  const miners = ids.map((id, i) => {
    const miner = new HonestMiner(keyN(10 + i).address);
    net.mining.setMiner(id, miner, 1);
    return miner;
  });
  runBlocks(net, blocks);
  stopAndSettle(net);
  return { net, ids, miners };
}

// ---------------------------------------------------------------------------
// The mining steps, one block at a time
// ---------------------------------------------------------------------------

describe('HonestMiner: creating a block (S2-6)', () => {
  it("builds on its node's current tip, pays itself, and publishes at once", () => {
    const chain = newChain();
    const first = contextOn(chain, 1_000);
    new HonestMiner(bob.address).onBlockFound(first.ctx); // someone else's block becomes the tip

    const { ctx, published } = contextOn(chain, 2_000);
    new HonestMiner(alice.address).onBlockFound(ctx);

    expect(published).toHaveLength(1);
    const block = published[0];
    expect(blockHashHex(block.header)).toBe(blockHashHex(chain.blocks[2].header));
    expect(block.header.prevHash).toEqual(hexToBytes(blockHashHex(first.published[0].header)));
    expect(block.header.timestamp).toBe(2_000);
    expect(isCoinbase(block.txs[0]) && block.txs[0].height).toBe(2);
    expect(coinbasePayee(block)).toBe(alice.address);
    expect(chain.height).toBe(2);
  });

  it('fills the block from its validated mempool and claims subsidy + fees', () => {
    const chain = newChain();
    const miner = new HonestMiner(alice.address);
    miner.onBlockFound(contextOn(chain, 1_000).ctx); // alice now owns a 50-coin coinbase

    const fee = 1_000;
    const payment = buildPayment(chain.confirmedUtxos(), alice, bob.address, 10 * COIN, fee);
    expect(chain.submitTransaction(payment).ok).toBe(true);
    // Step 2, validate txs: a second spend of the same coin never reaches the mempool.
    const conflict = buildPayment(chain.confirmedUtxos(), alice, carol.address, 5 * COIN, fee);
    expect(chain.submitTransaction(conflict).ok).toBe(false);

    const { ctx, published } = contextOn(chain, 2_000);
    miner.onBlockFound(ctx);

    const block = published[0];
    expect(block.txs.map(txidHex)).toEqual([txidHex(block.txs[0]), txidHex(payment)]);
    expect(block.txs[0].outputs[0].value).toBe(BLOCK_SUBSIDY + fee);
    expect(chain.txConfirmations(txidHex(payment))).toBe(1);
    expect(chain.mempool).toHaveLength(0);
    expect(chain.balanceOf(bob.address)).toBe(10 * COIN);
    expect(chain.balanceOf(alice.address)).toBe(2 * BLOCK_SUBSIDY - 10 * COIN); // fee paid to itself, so it nets out
  });
});

// ---------------------------------------------------------------------------
// Honest miners on the network
// ---------------------------------------------------------------------------

describe('HonestMiner on the network (S2-6)', () => {
  it("spreads a lone miner's blocks to every node", () => {
    const net = new Network({ seed: 1, genesis: GENESIS, blockInterval: 10 });
    const ids = [net.addNode(), net.addNode(), net.addNode()];
    net.connect(ids[0], ids[1], { latency: 1 });
    net.connect(ids[1], ids[2], { latency: 1 });
    net.mining.setMiner(ids[0], new HonestMiner(alice.address), 1);
    runBlocks(net, 20);
    stopAndSettle(net);

    const tip = blockHashHex(net.node(ids[0]).chain.blocks.at(-1)!.header);
    for (const id of ids) {
      const chain = net.node(id).chain;
      expect(chain.height).toBe(20);
      expect(blockHashHex(chain.blocks.at(-1)!.header)).toBe(tip);
      expect(chain.balanceOf(alice.address)).toBe(20 * BLOCK_SUBSIDY);
    }
  });

  it('never forks when blocks propagate instantly', () => {
    const { net, ids } = threeMiners(0, 60);
    const tip = blockHashHex(net.node(ids[0]).chain.blocks.at(-1)!.header);
    for (const id of ids) {
      const chain = net.node(id).chain;
      expect(staleCount(chain)).toBe(0);
      expect(chain.height).toBe(60);
      expect(blockHashHex(chain.blocks.at(-1)!.header)).toBe(tip);
    }
  });

  it('forks under latency, keeps the stale blocks, and settles once the next block lands', () => {
    const { net, ids } = threeMiners(4, 60);
    const found = net.mining.minedBlocks().length;
    for (const id of ids) {
      const chain = net.node(id).chain;
      expect(chain.tree.size).toBe(found + 1); // every node got every block, stale ones included
      expect(staleCount(chain)).toBeGreaterThan(0);
    }

    // Nodes may still sit on different branches of equal work (each keeps the
    // one it saw first). The next block breaks the tie, and everyone follows.
    net.mining.setHashPower(ids[0], 1);
    runBlocks(net, 1);
    stopAndSettle(net);
    const tip = blockHashHex(net.node(ids[0]).chain.blocks.at(-1)!.header);
    for (const id of ids) expect(blockHashHex(net.node(id).chain.blocks.at(-1)!.header)).toBe(tip);
  });

  it('earns the reward only for its blocks that stay on the main chain', () => {
    const { net, ids, miners } = threeMiners(4, 60);
    const chain = net.node(ids[0]).chain;
    const mainBlocks = chain.blocks.slice(1);

    let totalFound = 0;
    ids.forEach((id, i) => {
      const onMain = mainBlocks.filter((b) => coinbasePayee(b) === miners[i].rewardAddress).length;
      const found = net.mining.minedBlocks().filter((r) => r.miner === id).length;
      expect(chain.balanceOf(miners[i].rewardAddress)).toBe(onMain * BLOCK_SUBSIDY);
      expect(found).toBeGreaterThanOrEqual(onMain);
      totalFound += found;
    });
    // The difference is exactly the stale blocks, whose coinbases pay nobody.
    expect(totalFound - mainBlocks.length).toBe(staleCount(chain));
    expect(staleCount(chain)).toBeGreaterThan(0);
  });
});
