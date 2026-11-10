/**
 * Honest miner: follows the protocol. Each block it finds goes through these steps:
 *
 *   sync → validate txs → validate blocks → create block → PoW → collect reward
 *
 * The first three steps are things the node does all the time, not only when
 * its miner wins, so here they show up as what the miner relies on: its
 * node's chain is already synced, every block on it has been validated, and
 * so has every tx in its mempool. Steps 4–6 are the code in onBlockFound.
 *
 * "Honest" comes down to two rules, and the attacker strategies break each one:
 *   - always build on the tip of the most-work chain you know (a double-spend
 *     attacker builds on its own private branch instead);
 *   - publish a block the moment you find it (a selfish miner withholds it).
 */
import type { Address } from '../core';
import type { MinerContext, MinerStrategy } from '../network';

export class HonestMiner implements MinerStrategy {
  /** @param rewardAddress the address this miner's coinbase pays. */
  constructor(readonly rewardAddress: Address) { }

  onBlockFound(ctx: MinerContext): void {
    // 1. Sync: gossip has given this node every block that has reached it, and
    //    fork choice keeps ctx.chain's tip on the branch with the most work.
    // 2. Validate txs: the mempool only holds txs that passed validateTransaction
    //    against the tip's UTXO set, and they are checked again after every reorg.
    // 3. Validate blocks: each block on the main chain passed validateBlock when
    //    it connected, so the tip is valid all the way back to genesis.

    // 4. Create block: on the current tip, a coinbase paying us the subsidy plus
    //    the fees, followed by the mempool's txs.
    const template = ctx.chain.createBlockTemplate(this.rewardAddress, ctx.timestamp);

    // 5. Proof of work: find a nonce with sha256d(header) <= target.
    const block = ctx.solve(template);

    // 6. Collect the reward: publish at once. The coinbase output is only worth
    //    anything while this block stays on the main chain. If a competing block
    //    wins the fork race, ours goes stale and the reward disappears with it.
    ctx.publish(block);
  }
}
