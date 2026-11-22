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
 *
 * The protocol leaves one choice open: when two branches have exactly the same
 * work, either tip is "the most-work chain". By default a node keeps the one
 * it saw first. A TieBreak replaces that rule, see below.
 */
import { type Address, type Block, assembleBlock, bytesToHex, hexToBytes } from '../core';
import type { MinerContext, MinerStrategy } from '../network';
import type { TreeEntry } from '../node';

/**
 * Selfish mining's γ (Eyal & Sirer 2014): when the selfish miner publishes a
 * block that ties the public chain, the fraction of honest hash power that
 * mines on the attacker's block rather than on the honest one.
 *
 * On a real network γ comes from the attacker's head start in propagation:
 * honest miners that hear its block first mine on it. Here it is a dial
 * instead, so experiments can set it exactly as the paper does: each time an
 * honest miner finds a block while its node sees such a tie, it builds on the
 * attacker's side with probability γ, whichever block its node saw first.
 */
export interface TieBreak {
  /** The selfish miner's reward address. A block whose coinbase pays it is the attacker's. */
  favour: Address;
  /** In [0, 1]. */
  gamma: number;
}

export interface HonestMinerOptions {
  tieBreak?: TieBreak;
}

export class HonestMiner implements MinerStrategy {
  readonly tieBreak: TieBreak | undefined;

  /** @param rewardAddress the address this miner's coinbase pays. */
  constructor(
    readonly rewardAddress: Address,
    opts: HonestMinerOptions = {},
  ) {
    const tb = opts.tieBreak;
    if (tb && !(tb.gamma >= 0 && tb.gamma <= 1)) throw new RangeError('gamma must be in [0, 1]');
    this.tieBreak = tb;
  }

  onBlockFound(ctx: MinerContext): void {
    // 1. Sync: gossip has given this node every block that has reached it, and
    //    fork choice keeps ctx.chain's tip on the branch with the most work.
    // 2. Validate txs: the mempool only holds txs that passed validateTransaction
    //    against the tip's UTXO set, and they are checked again after every reorg.
    // 3. Validate blocks: each block on the main chain passed validateBlock when
    //    it connected, so the tip is valid all the way back to genesis.

    // 4. Create block: on the current tip, a coinbase paying us the subsidy plus
    //    the fees, followed by the mempool's txs.
    const other = this.tieBreak && this.pickTieSide(ctx, this.tieBreak);
    const template = other
      ? // The other tip of a tie. The mempool was checked against our own tip's
        // UTXO set, so its txs may not be valid on this branch: coinbase only.
        assembleBlock({
          prevHash: hexToBytes(other.hash),
          height: other.height + 1,
          timestamp: ctx.timestamp,
          target: ctx.chain.target,
          minerAddress: this.rewardAddress,
          txs: [],
          fees: 0,
        })
      : ctx.chain.createBlockTemplate(this.rewardAddress, ctx.timestamp);

    // 5. Proof of work: find a nonce with sha256d(header) <= target.
    const block = ctx.solve(template);

    // 6. Collect the reward: publish at once. The coinbase output is only worth
    //    anything while this block stays on the main chain. If a competing block
    //    wins the fork race, ours goes stale and the reward disappears with it.
    ctx.publish(block);
  }

  /**
   * If this node's main tip is tied with another tip and exactly one side is
   * the favoured miner's, pick a side (the favoured one with probability γ).
   * Returns the other tip to mine on, or null to mine on the main tip.
   */
  private pickTieSide(ctx: MinerContext, tb: TieBreak): TreeEntry | null {
    const chain = ctx.chain;
    const main = chain.tree.get(bytesToHex(chain.tipHash));
    if (!main) return null;
    const rivals = chain.tree.tips().filter((t) => t !== main && t.chainWork === main.chainWork);
    if (rivals.length === 0) return null;
    const mainIsFavoured = paysTo(main.block, tb.favour);
    // A rival on the other side of the tie, first seen first.
    const rival = rivals.sort((a, b) => a.seq - b.seq).find((t) => paysTo(t.block, tb.favour) !== mainIsFavoured);
    if (!rival) return null;
    const mineFavoured = ctx.random() < tb.gamma;
    return mineFavoured === mainIsFavoured ? null : rival;
  }
}

function paysTo(block: Block, address: Address): boolean {
  return block.txs[0]?.outputs[0]?.address === address;
}
