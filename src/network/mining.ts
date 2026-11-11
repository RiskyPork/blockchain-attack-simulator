/**
 * Mining engine: decides when the next block is found and
 * which miner finds it, then lets that miner's strategy build the block.
 *
 * Why one exponential draw is enough: PoW is a lottery. Every hash is an
 * independent try with the same tiny chance of winning, and miners make a huge
 * number of tries per second, so blocks arrive as a Poisson process:
 * the wait for the next block is exponentially distributed, with mean equal to
 * the block interval (600 s in Bitcoin). A miner with share p of the hash
 * power would find blocks at rate p / interval on its own, and whoever
 * succeeds first wins the block. Two facts about exponential waits turn that
 * race into a single draw:
 *   - the first of several independent Exp(r_i) waits is Exp(Σ r_i), so the
 *     next block comes after Exp(1 / interval);
 *   - miner i is the one that finishes first with probability r_i / Σ r_j,
 *     which is its hash share.
 * The process is memoryless: hashes already tried don't bring the next block
 * any closer. So when hash power changes, throwing away the pending draw and
 * drawing again from now gives exactly the right distribution.
 *
 * Two PoW modes, chosen by the network's difficulty (the genesis target):
 *   simulated  target 2^256 − 1 (difficulty 0 bits). Every hash meets it, so
 *              the first nonce works: no work is done, and the exponential
 *              clock stands in for it. Blocks are marked "simulated PoW".
 *              This is the Fast mode that experiments use.
 *   real       a low difficulty such as 8–12 leading zero bits. The winner
 *              really searches nonces until sha256d(header) ≤ target, about
 *              2^bits tries, so every block is genuinely valid.
 * Either way, every node runs every consensus rule on every block, PoW check
 * included. With simulated PoW that check simply always passes.
 *
 * The block interval doesn't depend on the total hash power: difficulty is
 * treated as perfectly adjusted, so blocks keep coming every `blockInterval`
 * seconds on average when miners join or leave. Hash power is therefore
 * relative, and only each miner's share of the total matters.
 */
import { type Block, type Transaction, type TxResult, blockHashHex, mineChunk, targetFromLeadingZeroBits } from '../core';
import type { Chain, SubmitBlockResult } from '../node';
import type { Network, NodeId } from './network';
import type { EventId } from './simulator';

/** Bitcoin's target block interval, in seconds. */
export const DEFAULT_BLOCK_INTERVAL = 600;

/** Difficulty 0: every hash meets this target. A network built on it runs with simulated PoW. */
export const SIMULATED_POW_TARGET = targetFromLeadingZeroBits(0);

/** Event: node `miner` has found the next block. */
export interface BlockFound {
  readonly type: 'block-found';
  readonly miner: NodeId;
}

/** How a block was found. Kept beside the block (the header has no room for it), for the UI and metrics. */
export interface MinedBlock {
  readonly hash: string;
  readonly miner: NodeId;
  /** Simulated time it was found, in seconds. */
  readonly foundAt: number;
  /** Nonces tried: about 2^bits with real PoW, always 1 with simulated PoW. */
  readonly attempts: number;
  readonly pow: 'real' | 'simulated';
}

/** What a strategy sees, and can do, through its node at the current moment. */
export interface NodeContext {
  /** The node this miner runs on. */
  readonly id: NodeId;
  /** That node's view of the blockchain: the main chain's tip, the mempool, the UTXO set. */
  readonly chain: Chain;
  /** Simulated time in integer milliseconds, for a block header. */
  readonly timestamp: number;
  /** Hand a block to this node's chain and gossip it to every peer. */
  publish(block: Block): SubmitBlockResult;
  /** Put a transaction in every node's mempool. Returns this node's verdict; a tx it rejects goes nowhere. */
  broadcastTransaction(tx: Transaction): TxResult;
}

/** What a strategy can also do when its miner wins a block: the PoW step. */
export interface MinerContext extends NodeContext {
  /** Find a nonce for this candidate block, and record this miner as its finder. */
  solve(template: Block): Block;
}

/** A block the node accepted, with where it ended up: main chain, side branch or orphan pool. */
export type AcceptedBlock = Extract<SubmitBlockResult, { ok: true }>;

/**
 * How a miner behaves. The engine only decides who wins each block; the
 * strategy decides what to build on and whether to publish.
 *
 * The honest miner (strategies/honest.ts) only needs onBlockFound. An attacker
 * also implements onBlockReceived, since what it does next depends on the
 * blocks the rest of the network finds: release a withheld branch once it is
 * ahead, or give up once it has fallen too far behind.
 */
export interface MinerStrategy {
  /** This miner has won the lottery for the next block. */
  onBlockFound(ctx: MinerContext): void;
  /**
   * A block from a peer reached this miner's node, which accepted it and has
   * already relayed it. Not called for duplicates, rejected blocks, or blocks
   * this node published itself.
   */
  onBlockReceived?(ctx: NodeContext, block: Block, result: AcceptedBlock): void;
}

/** The parts of Network the engine uses. */
export type MiningHost = Pick<Network, 'sim' | 'node' | 'publish' | 'broadcastTransaction'>;

interface Miner {
  strategy: MinerStrategy;
  hashPower: number;
}

export class Mining {
  /** Miners in the order they were added, which is also the order of their slices in the winner draw. */
  private readonly miners = new Map<NodeId, Miner>();
  private readonly records = new Map<string, MinedBlock>();
  /** The pending block-found event, if any miner has hash power. */
  private pending: EventId | null = null;
  private _blockInterval: number;

  constructor(
    private readonly host: MiningHost,
    blockInterval = DEFAULT_BLOCK_INTERVAL,
  ) {
    this._blockInterval = checkInterval(blockInterval);
  }

  /** Mean seconds between blocks, across the whole network. */
  get blockInterval(): number {
    return this._blockInterval;
  }

  set blockInterval(seconds: number) {
    this._blockInterval = checkInterval(seconds);
    this.reschedule();
  }

  /** Sum of every miner's hash power. Units are arbitrary: only shares matter. */
  get totalHashPower(): number {
    let total = 0;
    for (const m of this.miners.values()) total += m.hashPower;
    return total;
  }

  /** Make node `id` a miner, or replace its strategy and hash power if it already is one. */
  setMiner(id: NodeId, strategy: MinerStrategy, hashPower: number): void {
    this.host.node(id);
    checkHashPower(hashPower);
    const old = this.miners.get(id);
    this.miners.set(id, { strategy, hashPower });
    if (old?.hashPower !== hashPower) this.reschedule();
  }

  setHashPower(id: NodeId, hashPower: number): void {
    const miner = this.miners.get(id);
    if (!miner) throw new Error(`node ${id} is not a miner`);
    checkHashPower(hashPower);
    if (miner.hashPower === hashPower) return;
    miner.hashPower = hashPower;
    this.reschedule();
  }

  /** Stop node `id` mining (Network.removeNode calls this too). Returns false if it wasn't a miner. */
  removeMiner(id: NodeId): boolean {
    const miner = this.miners.get(id);
    if (!miner) return false;
    this.miners.delete(id);
    if (miner.hashPower > 0) this.reschedule();
    return true;
  }

  minerIds(): NodeId[] {
    return [...this.miners.keys()];
  }

  strategyOf(id: NodeId): MinerStrategy | undefined {
    return this.miners.get(id)?.strategy;
  }

  /** 0 for a node that isn't a miner. */
  hashPower(id: NodeId): number {
    return this.miners.get(id)?.hashPower ?? 0;
  }

  /** Fraction of the total hash power, which is also the chance that node `id` finds the next block. */
  share(id: NodeId): number {
    const total = this.totalHashPower;
    return total > 0 ? this.hashPower(id) / total : 0;
  }

  /** How a block was found, if a miner in this network found it (genesis wasn't). */
  minedBlock(hash: string): MinedBlock | undefined {
    return this.records.get(hash);
  }

  /** Every block found so far, in the order found, including any a strategy kept to itself. */
  minedBlocks(): MinedBlock[] {
    return [...this.records.values()];
  }

  /** Called by the network's event loop when a block-found event fires. */
  handle(e: BlockFound): void {
    this.pending = null;
    // The miner is always still there: removing it, or changing its power, redraws the pending event.
    this.miners.get(e.miner)?.strategy.onBlockFound(this.minerContext(e.miner));
    // Draw the next block, unless the strategy changed some hash power and so already did.
    if (this.pending === null) this.reschedule();
  }

  /** Called by the network when node `id` accepts a block from a peer. Passes it on to that node's strategy, if it has one. */
  blockReceived(id: NodeId, block: Block, result: AcceptedBlock): void {
    this.miners.get(id)?.strategy.onBlockReceived?.(this.nodeContext(id), block, result);
  }

  /**
   * Node `id`'s view and actions as of now. The hooks get one of these; code
   * outside them uses it too, e.g. to launch an attack at a moment the user picks.
   */
  nodeContext(id: NodeId): NodeContext {
    return {
      id,
      chain: this.host.node(id).chain,
      timestamp: Math.round(this.host.sim.now * 1000),
      publish: (block) => this.host.publish(id, block),
      broadcastTransaction: (tx) => this.host.broadcastTransaction(id, tx),
    };
  }

  /** Cancel the pending draw and draw the next block afresh from now (exact, since the process is memoryless). */
  private reschedule(): void {
    const sim = this.host.sim;
    if (this.pending !== null) sim.cancel(this.pending);
    this.pending = null;
    const total = this.totalHashPower;
    if (total === 0) return;
    const delay = sim.rng.exponential(1 / this._blockInterval);
    const miner = this.pickWinner(sim.rng.next() * total);
    this.pending = sim.schedule(delay, { type: 'block-found', miner });
  }

  /**
   * Lay the miners' hash powers end to end on [0, total) and return the one
   * whose slice contains `point`. A uniform point lands in a slice with
   * probability equal to that miner's share.
   */
  private pickWinner(point: number): NodeId {
    let last: NodeId = -1;
    for (const [id, miner] of this.miners) {
      if (miner.hashPower === 0) continue;
      last = id;
      point -= miner.hashPower;
      if (point < 0) return id;
    }
    return last; // only reached if floating-point rounding pushes the point past the end
  }

  private minerContext(id: NodeId): MinerContext {
    const now = this.host.sim.now;
    return { ...this.nodeContext(id), solve: (template) => this.solve(id, template, now) };
  }

  private solve(id: NodeId, template: Block, now: number): Block {
    // Try nonces until one meets the target. When the 32-bit nonce runs out,
    // mineChunk moves the timestamp on and starts again, so this always ends.
    const { header, attempts } = mineChunk(template.header, Number.MAX_SAFE_INTEGER);
    const hash = blockHashHex(header);
    const pow = header.target === SIMULATED_POW_TARGET ? 'simulated' : 'real';
    this.records.set(hash, { hash, miner: id, foundAt: now, attempts, pow });
    return { header, txs: template.txs };
  }
}

function checkInterval(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new RangeError('blockInterval must be a finite number > 0');
  return seconds;
}

function checkHashPower(power: number): void {
  if (!Number.isFinite(power) || power < 0) throw new RangeError('hash power must be a finite number >= 0');
}
