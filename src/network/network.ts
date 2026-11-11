/**
 * Peer-to-peer network: nodes, links with latency, and
 * flooding gossip of blocks, running on the discrete-event Simulator.
 *
 * Bitcoin has no central server. Each node only talks to a few peers, and a
 * new block spreads by gossip: a node that accepts a block it hadn't
 * seen before passes it on to all its peers except the one it came from. A
 * block it already knows is dropped and not passed on, so the flood stops by
 * itself once every node has the block.
 *
 * Sending a block over a link takes `latency + U(0, jitter)` simulated
 * seconds, with the jitter drawn from the run's seeded Rng. That delay is
 * what makes forks happen: if a second miner finds a block before the first
 * one's block reaches it, both blocks extend the same parent and the nodes
 * disagree until one branch gets ahead (fork choice in node/chain.ts).
 *
 * Simplifications, compared with Bitcoin:
 *   - A whole block is sent in one message. Bitcoin first announces the hash
 *     (inv), then sends the block only to peers that ask for it (getdata).
 *   - A node relays any block it accepts, including one that lands in its
 *     orphan pool. The PoW was already checked (checkHeader), so a junk
 *     block costs a real amount of work and can't be used to flood the net.
 *     A block the node rejects is never relayed.
 *   - Sync on connect (see `connect`): the two nodes swap the blocks the other
 *     is missing. This stands in for Bitcoin's headers-first initial block
 *     download, and is what lets a node join late or a partition heal.
 *   - Messages already on the wire still arrive if their link is removed.
 *     Messages to a node that has been removed are dropped.
 *   - Transactions skip the wire: a broadcast tx lands in every node's mempool
 *     at once (see `broadcastTransaction`). Forks and attacks are races
 *     between blocks, so only blocks are given a travel time.
 *
 * Blocks come from the mining engine (`mining`, see mining.ts), which shares
 * this network's simulator: its block-found events and the block-arrive
 * events here run on the same clock, from the same seeded Rng.
 */
import { type Block, type Transaction, type TxResult, blockHashHex } from '../core';
import { Chain, type SubmitBlockResult } from '../node';
import { type BlockFound, Mining } from './mining';
import { Simulator } from './simulator';

export type NodeId = number;

/** Event: `block` arrives at node `to`, sent by its peer `from`. */
export interface BlockArrive {
  readonly type: 'block-arrive';
  /** Message number, unique within the network. */
  readonly msg: number;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly block: Block;
  readonly sentAt: number;
}

/** Every event the network schedules: block deliveries, and blocks found by the mining engine. */
export type NetEvent = BlockArrive | BlockFound;

export interface LinkOptions {
  /** Fixed one-way delay in simulated seconds. */
  latency: number;
  /** Maximum extra random delay per message, in seconds (default 0). */
  jitter?: number;
}

/** A link between two nodes, with `a < b`. Links are symmetric. */
export interface Link {
  readonly a: NodeId;
  readonly b: NodeId;
  readonly latency: number;
  readonly jitter: number;
}

/** A block on the wire, for the network panel to animate along its link. */
export interface Delivery {
  readonly from: NodeId;
  readonly to: NodeId;
  readonly hash: string;
  readonly sentAt: number;
  readonly arriveAt: number;
}

export interface NetworkStats {
  /** Block messages put on a link. */
  sent: number;
  /** Messages that reached a live node (whether or not it accepted the block). */
  delivered: number;
  /** Messages whose node was removed while they were in flight. */
  dropped: number;
}

export interface NetworkNode {
  readonly id: NodeId;
  readonly chain: Chain;
}

export interface NetworkOptions {
  seed: number;
  /** The block every node starts from. Its target is the network's difficulty. */
  genesis: Block;
  /** Keep every fired event in `sim.log` (for tests and replay). */
  recordLog?: boolean;
  /** Mean seconds between blocks (default 600, as in Bitcoin). */
  blockInterval?: number;
}

export class Network {
  readonly sim: Simulator<NetEvent>;
  /** Who mines, with what hash power and strategy. Nothing is mined until a node is given hash power. */
  readonly mining: Mining;
  private readonly genesis: Block;
  private readonly nodeMap = new Map<NodeId, NetworkNode>();
  /** Peers of each node, in the order the links were made. */
  private readonly peerMap = new Map<NodeId, Map<NodeId, Link>>();
  private readonly wire = new Map<number, Delivery>();
  private readonly _stats: NetworkStats = { sent: 0, delivered: 0, dropped: 0 };
  private nextId = 0;
  private nextMsg = 0;

  constructor(opts: NetworkOptions) {
    const probe = new Chain({ target: opts.genesis.header.target });
    const result = probe.submitBlock(opts.genesis);
    if (!result.ok || probe.height !== 0) throw new Error('genesis must be a valid first block (prevHash = 0, real PoW)');
    this.genesis = opts.genesis;
    this.sim = new Simulator<NetEvent>({
      seed: opts.seed,
      recordLog: opts.recordLog,
      handler: (event) => (event.type === 'block-arrive' ? this.onArrive(event) : this.mining.handle(event)),
    });
    this.mining = new Mining(this, opts.blockInterval);
  }

  get stats(): Readonly<NetworkStats> {
    return { ...this._stats };
  }

  // -------------------------------------------------------------------------
  // Nodes
  // -------------------------------------------------------------------------

  /** Add a node with no peers, holding only the genesis block. Ids are never reused. */
  addNode(): NodeId {
    const id = this.nextId++;
    const chain = new Chain({ target: this.genesis.header.target });
    chain.submitBlock(this.genesis);
    this.nodeMap.set(id, { id, chain });
    this.peerMap.set(id, new Map());
    return id;
  }

  /** Remove a node, its links and its miner. Blocks already on their way to it are dropped when they arrive. */
  removeNode(id: NodeId): void {
    this.node(id);
    this.mining.removeMiner(id);
    for (const peer of this.peerMap.get(id)!.keys()) this.peerMap.get(peer)!.delete(id);
    this.peerMap.delete(id);
    this.nodeMap.delete(id);
  }

  node(id: NodeId): NetworkNode {
    const n = this.nodeMap.get(id);
    if (!n) throw new Error(`unknown node ${id}`);
    return n;
  }

  nodeIds(): NodeId[] {
    return [...this.nodeMap.keys()];
  }

  // -------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------

  /**
   * Link two nodes, then sync them: each sends the other, over the new link,
   * every block in its tree that the other doesn't have yet, parents first.
   * A node that has been offline (or was just added) catches up this way, and
   * when two halves of a partitioned network reconnect, fork choice on each
   * side then settles on the branch with more work.
   */
  connect(a: NodeId, b: NodeId, opts: LinkOptions): void {
    this.node(a);
    this.node(b);
    if (a === b) throw new Error('a node cannot link to itself');
    if (this.peerMap.get(a)!.has(b)) throw new Error(`nodes ${a} and ${b} are already connected`);
    const link = makeLink(a, b, opts);
    this.peerMap.get(a)!.set(b, link);
    this.peerMap.get(b)!.set(a, link);
    this.syncOver(a, b);
    this.syncOver(b, a);
  }

  /** Change a link's latency or jitter. Only messages sent from now on use the new values. */
  updateLink(a: NodeId, b: NodeId, opts: Partial<LinkOptions>): void {
    const old = this.link(a, b);
    if (!old) throw new Error(`nodes ${a} and ${b} are not connected`);
    const link = makeLink(a, b, { latency: opts.latency ?? old.latency, jitter: opts.jitter ?? old.jitter });
    this.peerMap.get(a)!.set(b, link);
    this.peerMap.get(b)!.set(a, link);
  }

  /** Remove the link between two nodes. Returns false if there was none. */
  disconnect(a: NodeId, b: NodeId): boolean {
    if (!this.peerMap.get(a)?.has(b)) return false;
    this.peerMap.get(a)!.delete(b);
    this.peerMap.get(b)!.delete(a);
    return true;
  }

  link(a: NodeId, b: NodeId): Link | undefined {
    return this.peerMap.get(a)?.get(b);
  }

  /** Every link once, in the order its lower-id node was added. */
  links(): Link[] {
    const out: Link[] = [];
    for (const [id, peers] of this.peerMap) for (const link of peers.values()) if (link.a === id) out.push(link);
    return out;
  }

  peersOf(id: NodeId): NodeId[] {
    this.node(id);
    return [...this.peerMap.get(id)!.keys()];
  }

  // -------------------------------------------------------------------------
  // Gossip
  // -------------------------------------------------------------------------

  /**
   * Node `origin` has just found `block` (or an attacker chooses to release
   * it): its own chain takes it first, and if it accepts the block, the block
   * is sent to every peer.
   */
  publish(origin: NodeId, block: Block): SubmitBlockResult {
    const result = this.node(origin).chain.submitBlock(block);
    if (result.ok) this.relay(origin, block, null);
    return result;
  }

  /**
   * Node `origin` sends a transaction to the whole network. Its own mempool
   * takes it first; if it accepts the tx, every other node gets it at the same
   * moment and validates it against its own view. Returns the origin's
   * verdict. As with any mempool, the first tx seen wins: a node rejects a
   * later tx that spends the same coin.
   */
  broadcastTransaction(origin: NodeId, tx: Transaction): TxResult {
    const result = this.node(origin).chain.submitTransaction(tx);
    if (result.ok) for (const node of this.nodeMap.values()) if (node.id !== origin) node.chain.submitTransaction(tx);
    return result;
  }

  /** Blocks currently on the wire, oldest first. */
  inFlight(): Delivery[] {
    return [...this.wire.values()];
  }

  private onArrive(e: BlockArrive): void {
    this.wire.delete(e.msg);
    const node = this.nodeMap.get(e.to);
    if (!node) {
      this._stats.dropped++;
      return;
    }
    this._stats.delivered++;
    // A block the node already has comes back as 'duplicate' and stops here:
    // this is the rule that ends the flood.
    const result = node.chain.submitBlock(e.block);
    if (!result.ok) return;
    this.relay(e.to, e.block, e.from);
    // The node's miner reacts last, once the block is stored and passed on.
    this.mining.blockReceived(e.to, e.block, result);
  }

  /** Send `block` from `id` to each of its peers except `except` (the peer it came from). */
  private relay(id: NodeId, block: Block, except: NodeId | null): void {
    for (const peer of this.peerMap.get(id)!.keys()) if (peer !== except) this.send(id, peer, block);
  }

  private send(from: NodeId, to: NodeId, block: Block): void {
    const link = this.peerMap.get(from)!.get(to)!;
    const delay = link.latency + (link.jitter > 0 ? this.sim.rng.next() * link.jitter : 0);
    const msg = this.nextMsg++;
    const sentAt = this.sim.now;
    this.wire.set(msg, { from, to, hash: blockHashHex(block.header), sentAt, arriveAt: sentAt + delay });
    this.sim.schedule(delay, { type: 'block-arrive', msg, from, to, block, sentAt });
    this._stats.sent++;
  }

  /** Send `to` every block `from` has in its tree that `to` doesn't. Tree order puts parents before children. */
  private syncOver(from: NodeId, to: NodeId): void {
    const target = this.node(to).chain.tree;
    for (const entry of this.node(from).chain.tree.entries()) {
      if (!target.has(entry.hash) && !target.isOrphan(entry.hash)) this.send(from, to, entry.block);
    }
  }
}

function makeLink(x: NodeId, y: NodeId, opts: LinkOptions): Link {
  const latency = opts.latency;
  const jitter = opts.jitter ?? 0;
  if (!Number.isFinite(latency) || latency < 0) throw new RangeError('latency must be a finite number >= 0');
  if (!Number.isFinite(jitter) || jitter < 0) throw new RangeError('jitter must be a finite number >= 0');
  return { a: Math.min(x, y), b: Math.max(x, y), latency, jitter };
}
