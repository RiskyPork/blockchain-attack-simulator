/**
 * Selfish miner (Eyal & Sirer, "Majority is not Enough", 2014).
 *
 * An honest miner publishes every block at once. A selfish miner keeps the
 * blocks it finds to itself, building a private branch, and only publishes
 * when that will throw away honest work. Honest miners then spend part of
 * their hash power on blocks that end up stale, so the selfish miner's share
 * of the main chain can exceed its share α of the hash power. Bitcoin's
 * incentives assume the honest strategy pays best; selfish mining shows they
 * don't once α passes (1 − γ) / (3 − 2γ): 1/3 with γ = 0, 1/4 with γ = 1/2.
 *
 * The state is the private branch's lead over the public chain. The paper's
 * state machine (its Algorithm 1), with the two kinds of event:
 *
 *   state   selfish miner finds a block        honest network finds a block
 *   0       withhold it → 1                    adopt the public chain → 0
 *   0′      publish it, win both → 0           adopt the winner → 0
 *   1       withhold it → 2                    publish ours, tie → 0′
 *   2       withhold it → 3                    publish all, win → 0
 *   n > 2   withhold it → n + 1                publish one, to match → n − 1
 *
 *   0′ is the race after a tie: two branches of equal length, one ours, and
 *   all of it published. Honest miners split: a fraction γ mine on our block
 *   (see TieBreak in honest.ts), the rest on theirs.
 *
 * In state 2 our lead is about to drop to 1, where one lucky honest block
 * could tie us, so we cash in. From state n > 2 we can afford to wait: we
 * publish just enough to match the public height (honest nodes keep the
 * branch they saw first, so this changes nothing yet) and keep mining.
 *
 * Mapping that onto a network with latency: the "public chain" is the main
 * chain of the selfish miner's own node, and its height is what we compare
 * the private tip with. Honest forks among honest nodes (which the paper
 * leaves out) only show up here as a public block that doesn't raise that
 * height, and those are ignored, just as the paper's miner only reacts to
 * the public chain growing.
 *
 * Private blocks hold only a coinbase. Revenue in the paper is counted in
 * blocks, and the mempool's txs were checked against the public tip, so
 * they might not be valid on a private branch.
 */
import { type Address, type Block, assembleBlock, blockHash } from '../core';
import type { MinerContext, MinerStrategy, NodeContext } from '../network';
import type { Chain } from '../node';

/** The paper's state names: lead 0, the 0′ race, 1, 2, and anything above 2. */
export type SelfishState = '0' | "0'" | '1' | '2' | '>2';

export interface SelfishStatus {
  state: SelfishState;
  /** Height of the private tip minus the public chain's (0 while there is no private branch). */
  lead: number;
  /** Blocks found and not yet published. */
  withheld: number;
}

export interface SelfishCounters {
  /** Times we published to tie the public chain (state 1 → 0′). */
  races: number;
  /** Races we won by finding the next block ourselves. */
  racesWonByUs: number;
  /** Times we published a lead and overrode the public chain (state 2 → 0, or 0′ → 0). */
  overrides: number;
  /** Private blocks thrown away because the public chain got ahead before we published them. */
  discarded: number;
}

interface PrivateTip {
  hash: Uint8Array;
  height: number;
}

export class SelfishMiner implements MinerStrategy {
  /** What we mine on. Null means the node's main tip: we have no branch of our own. */
  private tip: PrivateTip | null = null;
  /** Found but not published, oldest first. They extend each other, ending at `tip`. */
  private readonly hidden: { block: Block; height: number }[] = [];
  /** State 0′: our branch, all published, ties the public chain. */
  private racing = false;
  /** Height of our node's main chain the last time we looked: a public block only matters if it raises this. */
  private publicHeight = 0;
  private readonly _counters: SelfishCounters = { races: 0, racesWonByUs: 0, overrides: 0, discarded: 0 };

  /** @param rewardAddress the address this miner's coinbases pay. */
  constructor(readonly rewardAddress: Address) {}

  get counters(): Readonly<SelfishCounters> {
    return { ...this._counters };
  }

  /** The blocks we are sitting on, oldest first. */
  get withheld(): readonly Block[] {
    return this.hidden.map((h) => h.block);
  }

  /** Where the state machine is, against `chain` (this miner's own node's chain). */
  status(chain: Chain): SelfishStatus {
    const lead = this.tip ? this.tip.height - chain.height : 0;
    let state: SelfishState;
    if (this.racing) state = "0'";
    else if (lead <= 0) state = '0';
    else if (lead <= 2) state = String(lead) as '1' | '2';
    else state = '>2';
    return { state, lead: Math.max(0, lead), withheld: this.hidden.length };
  }

  onBlockFound(ctx: MinerContext): void {
    const parent = this.tip ?? { hash: ctx.chain.tipHash, height: ctx.chain.height };
    const block = ctx.solve(
      assembleBlock({
        prevHash: parent.hash,
        height: parent.height + 1,
        timestamp: ctx.timestamp,
        target: ctx.chain.target,
        minerAddress: this.rewardAddress,
        txs: [],
        fees: 0,
      }),
    );
    const height = parent.height + 1;

    if (this.racing) {
      // 0′ → 0: our branch is now one block longer than theirs. Publish at
      // once and every node switches to it: we earn both blocks.
      this.racing = false;
      this.tip = null;
      this._counters.racesWonByUs++;
      this._counters.overrides++;
      ctx.publish(block);
      this.publicHeight = ctx.chain.height;
      return;
    }
    // 0 → 1, 1 → 2, n → n + 1: keep it to ourselves.
    this.tip = { hash: blockHash(block.header), height };
    this.hidden.push({ block, height });
  }

  onBlockReceived(ctx: NodeContext): void {
    const h = ctx.chain.height;
    // A stale honest block, an orphan, or one tying a height we already know:
    // the public chain didn't grow, so nothing changes.
    if (h <= this.publicHeight) return;
    this.publicHeight = h;
    if (!this.tip) return; // state 0: we just mine on the new tip

    const ours = this.tip.height;
    if (ours < h) {
      // 0 → 0 or 0′ → 0: the public chain is ahead (in 0′, honest miners
      // settled the race, on our side or theirs). Adopt it. Anything still
      // hidden can never win now.
      this._counters.discarded += this.hidden.length;
      this.hidden.length = 0;
      this.tip = null;
      this.racing = false;
    } else if (ours === h) {
      // 1 → 0′: they caught up. Publish our block so the network splits
      // between the two, and race.
      this.publishUpTo(ctx, ours);
      this.racing = true;
      this._counters.races++;
    } else if (ours === h + 1) {
      // 2 → 0: our lead fell to one. Publish everything: ours is longer, every
      // node reorgs to it, and the honest block just found goes stale.
      this.publishUpTo(ctx, ours);
      this.tip = null;
      this._counters.overrides++;
    } else {
      // n → n − 1 for n > 2: publish up to their height. Nodes that saw the
      // honest block first keep it, so it costs nothing, but it means a node
      // switches to our branch the moment the rest of it comes out.
      this.publishUpTo(ctx, h);
    }
    this.publicHeight = ctx.chain.height;
  }

  /**
   * Publish every block still withheld and stop racing: for the end of a
   * measured run. With a lead of 2 or more the miner was sure to win all of
   * them in the end (it publishes everything once its lead drops to 1), so
   * leaving them out would undercount its revenue, by more the shorter the
   * run and the larger α. With a lead of 1 it gets the block for free, which
   * overcounts by at most one block. Returns how many it published.
   */
  releaseAll(ctx: NodeContext): number {
    const n = this.hidden.length;
    this.publishUpTo(ctx, Infinity);
    this.tip = null;
    this.racing = false;
    this.publicHeight = ctx.chain.height;
    return n;
  }

  /** Publish hidden blocks up to `height`, parents first. */
  private publishUpTo(ctx: NodeContext, height: number): void {
    while (this.hidden.length > 0 && this.hidden[0].height <= height) ctx.publish(this.hidden.shift()!.block);
  }
}
