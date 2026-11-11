/**
 * Double-spend attacker: pays a merchant on the public chain, then replaces
 * that history with a branch it mined in secret, on which the same coins went
 * back to itself.
 *
 *   1. Launch. The attacker signs two transactions that spend the same coins:
 *      the payment P to the merchant, which it broadcasts, and D paying
 *      itself, which it keeps. The public tip at this moment is the fork point.
 *   2. Honest miners confirm P. The merchant hands over the goods once P has
 *      k confirmations.
 *   3. Meanwhile the attacker mines its own branch from the fork point, with D
 *      in the first block, and publishes none of it.
 *   4. Once P has k confirmations and the private branch has more work than
 *      the public chain, the attacker publishes the whole branch. Every node
 *      that receives it switches over (fork choice: most work). The reorg
 *      drops the block holding P, and P can't return from the mempool because
 *      D has already spent its coins. The merchant shipped and was never paid.
 *   5. If the public chain gets `maxDeficit` blocks ahead, the attacker writes
 *      its branch off and goes back to mining honestly on the public tip.
 *
 * Whether step 4 ever happens is a race between the attacker's share q of the
 * hash power and the honest share p = 1 − q. Every block moves the gap by one,
 * towards the attacker with probability q. With q < p the attacker drifts
 * further behind, and its chance of ever catching up from z blocks back
 * shrinks like (q/p)^z (Nakamoto 2008, section 11), so a few confirmations
 * make the payment safe. With q > p the drift runs the attacker's way: given
 * enough patience it gets ahead in the end, however many confirmations the
 * merchant waits for. That is why the chain is only immutable while no one
 * controls more than half of the hash power.
 *
 * The attacker counts P's confirmations on its own node, which sees the public
 * chain as the merchant does, give or take one link's latency.
 */
import {
  type Address,
  type Block,
  COIN,
  type KeyPair,
  type StandardTx,
  assembleBlock,
  blockHash,
  blockWork,
  describeTxError,
  isValidAddress,
  signTransaction,
  totalOutputValue,
  txidHex,
} from '../core';
import type { MinerContext, MinerStrategy, NodeContext } from '../network';
import { type Chain, buildPayment } from '../node';
import { HonestMiner } from './honest';

/** Fee paid by the payment, and by the transaction that replaces it: 0.001 coins. */
export const DEFAULT_ATTACK_FEE = COIN / 1000;

export interface DoubleSpendOptions {
  /** Signs both transactions and receives the attacker's block rewards. */
  key: KeyPair;
  /** The merchant's address, which the payment pays. */
  merchant: Address;
  /** What the payment sends the merchant, in base units. Launching needs amount + fee in confirmed coins. */
  amount: number;
  /** Confirmations of the payment the merchant waits for before handing over the goods (k, at least 1). */
  confirmations: number;
  /** Give up once the public chain is this many blocks ahead of the private branch (at least 1). */
  maxDeficit: number;
  /** Fee of the payment, and of the transaction that replaces it. Defaults to DEFAULT_ATTACK_FEE. */
  fee?: number;
}

/**
 *   idle       not launched: mines honestly
 *   mining     the payment is out; mining the private branch and withholding it
 *   released   the private branch has been published
 *   abandoned  fell maxDeficit blocks behind and gave up: mines honestly again
 */
export type DoubleSpendPhase = 'idle' | 'mining' | 'released' | 'abandoned';

export type AttackOutcome = 'pending' | 'success' | 'failed';

/** The race between the two branches, counted in blocks above the fork point. */
export interface DoubleSpendRace {
  /** Blocks on the attacker's branch. */
  privateBlocks: number;
  /** Blocks on the public main chain, as the attacker's node sees it. */
  publicBlocks: number;
  /** Confirmations of the payment, as the attacker's node sees them. */
  confirmations: number;
}

/** What launch sets up. */
interface Attack {
  /** The attacker's node's chain: its view of the public chain. */
  chain: Chain;
  payment: StandardTx;
  paymentTxid: string;
  doubleSpend: StandardTx;
  doubleSpendTxid: string;
  forkHash: Uint8Array;
  forkHeight: number;
  forkWork: bigint;
}

export class DoubleSpendAttacker implements MinerStrategy {
  private readonly honest: HonestMiner;
  private readonly fee: number;
  private _phase: DoubleSpendPhase = 'idle';
  private attack: Attack | null = null;
  /** The attacker's blocks above the fork point, oldest first. */
  private readonly branch: Block[] = [];
  /** The race as it stood when the attacker released or gave up. */
  private final: DoubleSpendRace | null = null;

  constructor(readonly options: DoubleSpendOptions) {
    const { key, merchant, amount, confirmations, maxDeficit, fee = DEFAULT_ATTACK_FEE } = options;
    if (!Number.isSafeInteger(amount) || amount < 1) throw new RangeError('amount must be a whole number of base units >= 1');
    if (!Number.isSafeInteger(fee) || fee < 0) throw new RangeError('fee must be a whole number of base units >= 0');
    if (!Number.isInteger(confirmations) || confirmations < 1) throw new RangeError('confirmations must be an integer >= 1');
    if (!Number.isInteger(maxDeficit) || maxDeficit < 1) throw new RangeError('maxDeficit must be an integer >= 1');
    if (!isValidAddress(merchant)) throw new Error('merchant must be a valid address');
    this.honest = new HonestMiner(key.address);
    this.fee = fee;
  }

  get rewardAddress(): Address {
    return this.options.key.address;
  }

  get phase(): DoubleSpendPhase {
    return this._phase;
  }

  /** The transaction paying the merchant. Null until launch. */
  get payment(): StandardTx | null {
    return this.attack?.payment ?? null;
  }

  /** The transaction that spends the same coins back to the attacker. Null until launch. */
  get doubleSpend(): StandardTx | null {
    return this.attack?.doubleSpend ?? null;
  }

  /** Height of the public tip when the attack was launched. Null until launch. */
  get forkHeight(): number | null {
    return this.attack?.forkHeight ?? null;
  }

  /** The attacker's blocks above the fork point: withheld while mining, public once released. */
  get privateBranch(): readonly Block[] {
    return this.branch;
  }

  /** Live while mining, frozen once the attacker releases or gives up, null before launch. */
  race(): DoubleSpendRace | null {
    return this.final ?? (this.attack && this.raceNow(this.attack));
  }

  /**
   * After a release this is read live from the attacker's node: success while
   * its main chain confirms the replacement transaction. With link latency an
   * honest block still on the wire can tie the released branch at the nodes
   * that saw it first, and if the honest side then finds the next block,
   * everyone (the attacker's node included) moves to the honest chain and the
   * outcome turns to failed.
   */
  get outcome(): AttackOutcome {
    switch (this._phase) {
      case 'idle':
      case 'mining':
        return 'pending';
      case 'abandoned':
        return 'failed';
      case 'released': {
        const a = this.attack!;
        return a.chain.txConfirmations(a.doubleSpendTxid) > 0 ? 'success' : 'failed';
      }
    }
  }

  /**
   * Start the attack from node `ctx.id`, the node this strategy mines on:
   * broadcast the payment, keep the replacement, and from now on mine on the
   * private branch. Throws if the attacker can't fund the payment, or has
   * already launched.
   */
  launch(ctx: NodeContext): void {
    if (this._phase !== 'idle') throw new Error('the attack has already been launched');
    const { key, merchant, amount } = this.options;
    // Only confirmed coins: the private branch starts at the current tip, so
    // the replacement must be valid there.
    const utxos = ctx.chain.confirmedUtxos();
    const needed = amount + this.fee;
    if (utxos.balanceOf(key.address) < needed) {
      throw new Error(`the attacker needs ${needed / COIN} coins in confirmed outputs to pay the merchant`);
    }
    const payment = buildPayment(utxos, key, merchant, amount, this.fee);
    // Exactly the payment's inputs, so at most one of the two can ever be
    // confirmed. Everything goes back to the attacker, less the same fee.
    const doubleSpend = signTransaction(
      payment.inputs.map((input) => ({ prevOut: input.prevOut, key })),
      [{ value: totalOutputValue(payment), address: key.address }],
    );
    const verdict = ctx.broadcastTransaction(payment);
    if (!verdict.ok) throw new Error(`the attacker's node rejected the payment: ${describeTxError(verdict.error)}`);

    this.attack = {
      chain: ctx.chain,
      payment,
      paymentTxid: txidHex(payment),
      doubleSpend,
      doubleSpendTxid: txidHex(doubleSpend),
      forkHash: ctx.chain.tipHash,
      forkHeight: ctx.chain.height,
      forkWork: ctx.chain.chainWork,
    };
    this._phase = 'mining';
  }

  onBlockFound(ctx: MinerContext): void {
    if (this._phase !== 'mining') {
      // After a release the node's tip is the released branch, so honest mining extends it.
      this.honest.onBlockFound(ctx);
      return;
    }
    this.extendBranch(ctx);
    this.releaseIfReady(ctx);
  }

  onBlockReceived(ctx: NodeContext): void {
    if (this._phase !== 'mining') return;
    // A public block can bring the merchant's last confirmation while the
    // attacker is already ahead, or push the public chain too far ahead.
    this.releaseIfReady(ctx);
    if (this._phase === 'mining') this.giveUpIfHopeless(ctx);
  }

  /** Mine the next private block on the attacker's own branch, not on the public tip, and keep it. */
  private extendBranch(ctx: MinerContext): void {
    const a = this.attack!;
    const parent = this.branch.at(-1);
    const template = assembleBlock({
      prevHash: parent ? blockHash(parent.header) : a.forkHash,
      height: a.forkHeight + this.branch.length + 1,
      timestamp: ctx.timestamp,
      target: ctx.chain.target,
      minerAddress: this.rewardAddress,
      // The replacement goes in the first block. Later blocks hold only the
      // coinbase: the attacker needs nothing else confirmed.
      txs: parent ? [] : [a.doubleSpend],
      fees: parent ? 0 : this.fee,
    });
    this.branch.push(ctx.solve(template));
  }

  private releaseIfReady(ctx: NodeContext): void {
    const a = this.attack!;
    // Releasing before the merchant ships would cancel the payment and gain nothing.
    if (ctx.chain.txConfirmations(a.paymentTxid) < this.options.confirmations) return;
    // On a tie, nodes keep the branch they saw first (the public one), so the
    // private branch needs strictly more work.
    if (this.branchWork(a) <= ctx.chain.chainWork) return;
    this.final = this.raceNow(a);
    this._phase = 'released';
    // Parents first. The last block tips the work, and each node reorgs to the branch.
    for (const block of this.branch) ctx.publish(block);
  }

  private giveUpIfHopeless(ctx: NodeContext): void {
    const a = this.attack!;
    const behind = ctx.chain.height - (a.forkHeight + this.branch.length);
    if (behind < this.options.maxDeficit) return;
    // The branch is never published. Back to honest mining on the public tip.
    this.final = this.raceNow(a);
    this._phase = 'abandoned';
  }

  private branchWork(a: Attack): bigint {
    return this.branch.reduce((work, b) => work + blockWork(b.header.target), a.forkWork);
  }

  private raceNow(a: Attack): DoubleSpendRace {
    return {
      privateBlocks: this.branch.length,
      publicBlocks: a.chain.height - a.forkHeight,
      confirmations: a.chain.txConfirmations(a.paymentTxid),
    };
  }
}
