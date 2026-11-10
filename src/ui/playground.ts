/**
 * The live network behind the Network and Chain tree tabs: a Network of honest
 * miners that the user reshapes while it runs, and the play / pause / step /
 * speed controls that drive its simulated clock.
 *
 * No DOM here, so it is unit-tested; the panels only read it and call its
 * methods. Consensus stays in node/ and network/: this class wires nodes,
 * links and miners together and watches what they do.
 *
 * Topology is a ring. A new node is inserted between the last node and the
 * first; a removed node's two neighbours are linked to close the gap. A ring
 * keeps every node reachable and makes a block cross several hops, so latency
 * adds up and forks appear without needing extreme settings.
 *
 * Reproducibility: everything random comes from the run's seeded Rng, and
 * miners' reward keys are derived from their node id. Moving the clock in
 * small or large steps fires the same events in the same order, so the run
 * depends on the seed and the settings, not on the browser's frame rate.
 */
import {
  type Address,
  type Block,
  ZERO_HASH,
  assembleBlock,
  blockHashHex,
  bytesToHex,
  keyPairFromPrivate,
  mineChunk,
  sha256,
  targetFromLeadingZeroBits,
  utf8ToBytes,
} from '../core';
import { DEFAULT_BLOCK_INTERVAL, type NetEvent, Network, type NodeId, SIMULATED_POW_TARGET } from '../network';
import type { Chain } from '../node';
import { HonestMiner } from '../strategies';
import { shortHex } from './format';

/** Fast mode skips the nonce search; real mode does it at a low difficulty. */
export type PowMode = 'simulated' | 'real';

/** Leading zero bits per block in real PoW mode: about 4,096 hashes each, quick enough to mine inside the event loop. */
export const REAL_POW_BITS = 12;

export const MAX_NODES = 12;

/** Speeds offered by the UI, in simulated seconds per real second. */
export const SPEEDS = [1, 10, 30, 60, 120, 300, 600, 1800] as const;

export interface PlaygroundOptions {
  seed: number;
  pow: PowMode;
  /** Hash power of each starting node, in ring order. Only the ratios matter. */
  hashPowers: number[];
  /** Fixed one-way delay per link, in simulated seconds. */
  latency: number;
  /** Maximum extra random delay per message, in seconds. */
  jitter: number;
  blockInterval: number;
}

export const DEFAULT_OPTIONS: Readonly<PlaygroundOptions> = {
  seed: 42,
  pow: 'simulated',
  hashPowers: [30, 20, 15, 15, 10, 10],
  latency: 10,
  jitter: 2,
  blockInterval: DEFAULT_BLOCK_INTERVAL,
};

/** Hash power given to a node added from the UI. */
export const NEW_NODE_HASH_POWER = 10;

/** A real frame longer than this (e.g. the tab was in the background) only advances the clock this much. */
const MAX_FRAME_SECONDS = 0.25;
const ACTIVITY_LIMIT = 200;

export interface BlockRef {
  hash: string;
  height: number;
}

/** Something worth showing in the activity log. Message deliveries are too frequent to list. */
export type Activity =
  | { kind: 'found'; time: number; node: NodeId; block: BlockRef }
  /** Node `node` dropped `depth` blocks from its main chain to follow a branch with more work. */
  | { kind: 'reorg'; time: number; node: NodeId; depth: number; from: BlockRef; to: BlockRef };

export interface NodeSummary {
  id: NodeId;
  hashPower: number;
  /** Fraction of the total hash power: the chance this node finds the next block. */
  share: number;
  height: number;
  tip: string;
  /** Times this node won the block lottery. */
  found: number;
  /** Blocks waiting for a parent this node hasn't received yet. */
  orphans: number;
  peers: NodeId[];
}

export function nodeLabel(id: NodeId): string {
  return `N${id}`;
}

export class Playground {
  private _net!: Network;
  private _ring: NodeId[] = [];
  private _opts: PlaygroundOptions;
  private tips = new Map<NodeId, string>();
  private wins = new Map<NodeId, number>();
  private _activity: Activity[] = [];
  private _reorgs = { count: 0, deepest: 0 };
  private _lastEvent = '';
  private _playing = false;
  private _speed = 60;
  private _version = 0;
  private readonly listeners = new Set<() => void>();

  constructor(opts: Partial<PlaygroundOptions> = {}) {
    this._opts = { ...DEFAULT_OPTIONS, ...opts, hashPowers: [...(opts.hashPowers ?? DEFAULT_OPTIONS.hashPowers)] };
    this.build(this._opts.hashPowers);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  get net(): Network {
    return this._net;
  }

  /** Node ids in ring order: each node links to the ones before and after it, and the last to the first. */
  get ring(): readonly NodeId[] {
    return this._ring;
  }

  get seed(): number {
    return this._opts.seed;
  }

  get pow(): PowMode {
    return this._opts.pow;
  }

  get latency(): number {
    return this._opts.latency;
  }

  get jitter(): number {
    return this._opts.jitter;
  }

  get blockInterval(): number {
    return this._opts.blockInterval;
  }

  get now(): number {
    return this._net.sim.now;
  }

  get playing(): boolean {
    return this._playing;
  }

  /** Simulated seconds per real second while playing. */
  get speed(): number {
    return this._speed;
  }

  set speed(s: number) {
    if (!Number.isFinite(s) || s <= 0) throw new RangeError('speed must be a finite number > 0');
    this._speed = s;
    this.emit();
  }

  /** Goes up whenever an event fires or the setup changes, so panels can skip redrawing when nothing moved. */
  get version(): number {
    return this._version;
  }

  /** Found blocks and reorgs, oldest first, capped at the most recent 200. */
  get activity(): readonly Activity[] {
    return this._activity;
  }

  get reorgs(): Readonly<{ count: number; deepest: number }> {
    return this._reorgs;
  }

  /** What the last fired event did, in words (shown next to the Step button). */
  get lastEvent(): string {
    return this._lastEvent;
  }

  chain(id: NodeId): Chain {
    return this._net.node(id).chain;
  }

  nodes(): NodeSummary[] {
    const { mining } = this._net;
    return this._ring.map((id) => {
      const chain = this.chain(id);
      return {
        id,
        hashPower: mining.hashPower(id),
        share: mining.share(id),
        height: chain.height,
        tip: bytesToHex(chain.tipHash),
        found: this.wins.get(id) ?? 0,
        orphans: chain.tree.orphans().length,
        peers: this._net.peersOf(id),
      };
    });
  }

  /** Total blocks found so far, across all miners. */
  get blocksFound(): number {
    let n = 0;
    for (const w of this.wins.values()) n += w;
    return n;
  }

  /** Height of a block in whichever node's tree has it, or undefined if none does. */
  heightOf(hash: string): number | undefined {
    for (const id of this._ring) {
      const e = this.chain(id).tree.get(hash);
      if (e) return e.height;
    }
    return undefined;
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  /**
   * Start a fresh run from genesis with the same nodes (renumbered from 0),
   * hash powers and link settings. Pass a seed or PoW mode to change them.
   */
  reset(opts: { seed?: number; pow?: PowMode } = {}): void {
    if (opts.seed !== undefined) {
      if (!Number.isSafeInteger(opts.seed)) throw new RangeError('seed must be an integer');
      this._opts.seed = opts.seed;
    }
    if (opts.pow !== undefined) this._opts.pow = opts.pow;
    this.build(this._ring.map((id) => this._net.mining.hashPower(id)));
    this.changed();
  }

  /** Add a node to the ring. It starts with only genesis and catches up over its new links. */
  addNode(hashPower = NEW_NODE_HASH_POWER): NodeId {
    if (this._ring.length >= MAX_NODES) throw new Error(`at most ${MAX_NODES} nodes`);
    const id = this.insertNode(hashPower);
    this.changed();
    return id;
  }

  /** Remove a node and link its two neighbours, so the ring stays connected. */
  removeNode(id: NodeId): void {
    const i = this._ring.indexOf(id);
    if (i < 0) throw new Error(`unknown node ${id}`);
    if (this._ring.length === 1) throw new Error('the network needs at least one node');
    const n = this._ring.length;
    const prev = this._ring[(i - 1 + n) % n];
    const next = this._ring[(i + 1) % n];
    this._net.removeNode(id);
    this._ring.splice(i, 1);
    this.tips.delete(id);
    if (prev !== next && !this._net.link(prev, next)) this._net.connect(prev, next, this.linkOptions());
    this.changed();
  }

  setHashPower(id: NodeId, hashPower: number): void {
    this._net.mining.setHashPower(id, hashPower);
    this.changed();
  }

  /** Set every link's latency. Messages already on the wire keep their old arrival time. */
  setLatency(seconds: number): void {
    this._opts.latency = checkDelay(seconds, 'latency');
    this.updateLinks();
  }

  setJitter(seconds: number): void {
    this._opts.jitter = checkDelay(seconds, 'jitter');
    this.updateLinks();
  }

  setBlockInterval(seconds: number): void {
    this._net.mining.blockInterval = seconds;
    this._opts.blockInterval = seconds;
    this.changed();
  }

  // -------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------

  play(): void {
    this._playing = true;
    this.emit();
  }

  pause(): void {
    this._playing = false;
    this.emit();
  }

  /** Called once per animation frame with the real time since the last one. Returns how many events fired. */
  tick(realSeconds: number): number {
    if (!this._playing || !(realSeconds > 0)) return 0;
    return this.advance(Math.min(realSeconds, MAX_FRAME_SECONDS) * this._speed);
  }

  /** Fire the next event, whenever it is, and move the clock to it. Returns undefined if nothing is scheduled. */
  step(): NetEvent | undefined {
    const e = this.fire();
    this.emit();
    return e;
  }

  /** Move the clock forward by `seconds`, firing every event on the way. Returns how many fired. */
  advance(seconds: number): number {
    const sim = this._net.sim;
    const until = sim.now + seconds;
    let fired = 0;
    for (let t = sim.nextEventTime; t !== undefined && t <= until; t = sim.nextEventTime) {
      this.fire();
      fired++;
    }
    sim.runUntil(until);
    this.emit();
    return fired;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private build(hashPowers: number[]): void {
    this._net = new Network({ seed: this._opts.seed, genesis: genesisFor(this._opts.pow), blockInterval: this._opts.blockInterval });
    this._ring = [];
    this.tips.clear();
    this.wins.clear();
    this._activity = [];
    this._reorgs = { count: 0, deepest: 0 };
    this._lastEvent = '';
    for (const hp of hashPowers) this.insertNode(hp);
  }

  private insertNode(hashPower: number): NodeId {
    const net = this._net;
    const id = net.addNode();
    const ring = this._ring;
    const first = ring[0];
    const last = ring.at(-1);
    // Splice the new node between the last and the first. With two nodes their
    // single link is also the ring's closing link, so it stays.
    if (ring.length >= 3) net.disconnect(last!, first);
    if (last !== undefined) net.connect(last, id, this.linkOptions());
    if (ring.length >= 2) net.connect(id, first, this.linkOptions());
    ring.push(id);
    net.mining.setMiner(id, new HonestMiner(minerAddress(id)), hashPower);
    this.tips.set(id, bytesToHex(net.node(id).chain.tipHash));
    return id;
  }

  private linkOptions() {
    return { latency: this._opts.latency, jitter: this._opts.jitter };
  }

  private updateLinks(): void {
    for (const link of this._net.links()) this._net.updateLink(link.a, link.b, this.linkOptions());
    this.changed();
  }

  /** Fire one event, then record what it did. */
  private fire(): NetEvent | undefined {
    const before = new Map(this._ring.map((id) => [id, storeCounts(this.chain(id))]));
    const e = this._net.sim.step();
    if (!e) return undefined;
    this._version++;
    if (e.type === 'block-found') this.wins.set(e.miner, (this.wins.get(e.miner) ?? 0) + 1);
    const reorgs = this.watchTips(e);
    this._lastEvent = this.describe(e, before.get(e.type === 'block-arrive' ? e.to : e.miner), reorgs);
    return e;
  }

  /**
   * Compare every node's tip with the one it had before the event. A tip
   * that moved off the old tip's branch is a reorg: the node undid blocks
   * back to the fork point and followed a branch with more work.
   */
  private watchTips(e: NetEvent): Map<NodeId, number> {
    const now = this._net.sim.now;
    const reorgs = new Map<NodeId, number>();
    for (const id of this._ring) {
      const chain = this.chain(id);
      const tip = bytesToHex(chain.tipHash);
      const old = this.tips.get(id);
      this.tips.set(id, tip);
      if (old === undefined || old === tip) continue;
      if (e.type === 'block-found' && e.miner === id) {
        const rec = this._net.mining.minedBlock(tip);
        if (rec?.miner === id && rec.foundAt === now) this.log({ kind: 'found', time: now, node: id, block: this.ref(chain, tip) });
      }
      if (chain.isOnMainChain(old)) continue;
      const depth = blocksOffMainChain(chain, old);
      reorgs.set(id, depth);
      this._reorgs.count++;
      this._reorgs.deepest = Math.max(this._reorgs.deepest, depth);
      this.log({ kind: 'reorg', time: now, node: id, depth, from: this.ref(chain, old), to: this.ref(chain, tip) });
    }
    return reorgs;
  }

  private describe(e: NetEvent, before: StoreCounts | undefined, reorgs: Map<NodeId, number>): string {
    if (e.type === 'block-found') {
      const tip = this.tips.get(e.miner)!;
      const rec = this._net.mining.minedBlock(tip);
      return rec?.miner === e.miner && rec.foundAt === this.now
        ? `${nodeLabel(e.miner)} found block #${this.chain(e.miner).height} (${shortHex(tip, 6, 4)}) and sent it to its peers.`
        : `${nodeLabel(e.miner)} found a block.`;
    }
    const hash = blockHashHex(e.block.header);
    const what = `Block #${this.heightOf(hash) ?? '?'} (${shortHex(hash, 6, 4)}) reached ${nodeLabel(e.to)} from ${nodeLabel(e.from)}`;
    if (!before || !this._ring.includes(e.to)) return `${what}, but that node was removed: dropped.`;
    const chain = this.chain(e.to);
    const after = storeCounts(chain);
    const depth = reorgs.get(e.to);
    if (depth !== undefined) return `${what}: its branch has more work, so ${nodeLabel(e.to)} reorganised (${depth} block${depth === 1 ? '' : 's'} undone).`;
    if (after.blocks > before.blocks) {
      return this.tips.get(e.to) === hash || chain.isOnMainChain(hash)
        ? `${what}: new tip, passed on to its other peers.`
        : `${what}: stored on a side branch (less work than the main chain), passed on.`;
    }
    if (after.orphans > before.orphans) return `${what}: parent not received yet, so it waits in the orphan pool.`;
    return `${what}: already had it, so it isn't passed on again.`;
  }

  private ref(chain: Chain, hash: string): BlockRef {
    return { hash, height: chain.tree.get(hash)?.height ?? -1 };
  }

  private log(a: Activity): void {
    this._activity.push(a);
    if (this._activity.length > ACTIVITY_LIMIT) this._activity.shift();
  }

  private changed(): void {
    this._version++;
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

function checkDelay(seconds: number, name: string): number {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError(`${name} must be a finite number >= 0`);
  return seconds;
}

interface StoreCounts {
  blocks: number;
  orphans: number;
}

function storeCounts(chain: Chain): StoreCounts {
  return { blocks: chain.tree.size, orphans: chain.tree.orphans().length };
}

/** How many blocks of the branch ending at `hash` are off `chain`'s main chain: the depth of the reorg that left it. */
function blocksOffMainChain(chain: Chain, hash: string): number {
  let depth = 0;
  for (let e = chain.tree.get(hash); e && !chain.isOnMainChain(e.hash); e = e.parent === null ? undefined : chain.tree.get(e.parent)) depth++;
  return depth;
}

// ---------------------------------------------------------------------------
// Deterministic keys and genesis blocks
// ---------------------------------------------------------------------------

const addressCache = new Map<string, Address>();

/** Private key = sha256(label), so a node's reward address only depends on its id and runs replay exactly. */
function addressFor(label: string): Address {
  let a = addressCache.get(label);
  if (!a) {
    a = keyPairFromPrivate(sha256(utf8ToBytes(label))).address;
    addressCache.set(label, a);
  }
  return a;
}

export function minerAddress(id: NodeId): Address {
  return addressFor(`playground node ${id}`);
}

const genesisCache = new Map<PowMode, Block>();

/** The shared first block. Its target sets the network's difficulty, and so the PoW mode. */
export function genesisFor(pow: PowMode): Block {
  let g = genesisCache.get(pow);
  if (!g) {
    const target = pow === 'real' ? targetFromLeadingZeroBits(REAL_POW_BITS) : SIMULATED_POW_TARGET;
    const t = assembleBlock({ prevHash: ZERO_HASH, height: 0, timestamp: 0, target, minerAddress: addressFor('playground genesis'), txs: [], fees: 0 });
    g = { header: mineChunk(t.header, Number.MAX_SAFE_INTEGER).header, txs: t.txs };
    genesisCache.set(pow, g);
  }
  return g;
}
