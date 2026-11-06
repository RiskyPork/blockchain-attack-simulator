/**
 * Discrete-event simulation engine (Sprint 2, S2-1).
 *
 * The simulated network doesn't run in real time. Instead it keeps a queue of
 * future events ("miner 2 finds a block at t = 613.4", "block X reaches node 3
 * at t = 614.1") and repeatedly jumps the clock to the earliest one and runs
 * it. Handling an event usually schedules new ones (a found block schedules a
 * delivery to every neighbour after the link latency). Nothing happens between
 * events, so long stretches of simulated time cost nothing.
 *
 * Time is in simulated seconds (Bitcoin's target block interval is 600 s).
 *
 * Reproducibility: the simulator owns the run's seeded Rng, and events at the
 * same time fire in the order they were scheduled (FIFO). Together these make
 * a run a pure function of its seed and inputs, so the same seed always gives
 * the same event log. All randomness in a run must come from `sim.rng`.
 */
import { Rng } from './rng';

/** Every event is plain data tagged with a `type`, so logs can be compared and exported. */
export type SimEvent = { readonly type: string };

/** One fired event, as recorded in the log. `seq` is the order it was scheduled in. */
export interface LogEntry<E extends SimEvent> {
  readonly seq: number;
  readonly time: number;
  readonly event: E;
}

/** Identifies a scheduled event so it can be cancelled. */
export type EventId = number;

export type EventHandler<E extends SimEvent> = (event: E, sim: Simulator<E>) => void;

export interface SimulatorOptions<E extends SimEvent> {
  seed: number;
  /** Called once per event, after the clock has moved to the event's time. */
  handler: EventHandler<E>;
  /** Keep every fired event in `log`. Off by default so batch runs don't grow memory. */
  recordLog?: boolean;
}

interface Entry<E> {
  time: number;
  seq: number;
  event: E;
}

export class Simulator<E extends SimEvent> {
  /** The run's only source of randomness. */
  readonly rng: Rng;
  private readonly handler: EventHandler<E>;
  private readonly recordLog: boolean;
  private readonly _log: LogEntry<E>[] = [];
  private readonly queue = new MinHeap<Entry<E>>((a, b) => a.time - b.time || a.seq - b.seq);
  /**
   * Events scheduled but not yet fired or cancelled. Cancelling removes the
   * entry from here and leaves it in the heap; the heap skips it when it
   * reaches the top (lazy deletion, so cancel is O(1)).
   */
  private readonly live = new Map<EventId, Entry<E>>();
  private nextSeq = 0;
  private _now = 0;

  constructor(opts: SimulatorOptions<E>) {
    this.rng = new Rng(opts.seed);
    this.handler = opts.handler;
    this.recordLog = opts.recordLog ?? false;
  }

  /** Current simulated time in seconds. */
  get now(): number {
    return this._now;
  }

  /** Number of events waiting to fire. */
  get pending(): number {
    return this.live.size;
  }

  /** Time of the next event to fire, or undefined if the queue is empty. */
  get nextEventTime(): number | undefined {
    return this.peek()?.time;
  }

  /** Fired events in order (empty unless `recordLog` was set). */
  get log(): readonly LogEntry<E>[] {
    return this._log;
  }

  /**
   * Schedule `event` to fire `delay` seconds from now. A zero delay is allowed
   * and fires after every event already queued for the current time.
   */
  schedule(delay: number, event: E): EventId {
    if (!Number.isFinite(delay) || delay < 0) throw new RangeError('delay must be a finite number >= 0');
    const entry: Entry<E> = { time: this._now + delay, seq: this.nextSeq++, event };
    this.queue.push(entry);
    this.live.set(entry.seq, entry);
    return entry.seq;
  }

  /** Cancel a pending event. Returns false if it already fired, was already cancelled, or never existed. */
  cancel(id: EventId): boolean {
    return this.live.delete(id);
  }

  /** Fire the next event and return it, or return undefined if nothing is queued. */
  step(): E | undefined {
    const entry = this.peek();
    if (!entry) return undefined;
    this.queue.pop();
    this.live.delete(entry.seq);
    this._now = entry.time;
    if (this.recordLog) this._log.push({ seq: entry.seq, time: entry.time, event: entry.event });
    this.handler(entry.event, this);
    return entry.event;
  }

  /**
   * Fire every event up to and including time `t` (events scheduled along the
   * way count too), then leave the clock at `t`. Returns how many events fired.
   * The UI's play button calls this with `now + frameTime × speed` each frame.
   */
  runUntil(t: number): number {
    if (Number.isNaN(t) || t < this._now) throw new RangeError('cannot run the clock backwards');
    let fired = 0;
    for (let next = this.peek(); next && next.time <= t; next = this.peek()) {
      this.step();
      fired++;
    }
    this._now = t;
    return fired;
  }

  /** Earliest live entry, discarding cancelled ones from the top of the heap. */
  private peek(): Entry<E> | undefined {
    let top = this.queue.peek();
    while (top && !this.live.has(top.seq)) {
      this.queue.pop();
      top = this.queue.peek();
    }
    return top;
  }
}

/** Array-backed binary min-heap: O(log n) push/pop, O(1) peek. */
class MinHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: (a: T, b: T) => number) {}

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    const a = this.items;
    a.push(item);
    // Sift up: swap with the parent while smaller than it.
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(a[i], a[parent]) >= 0) break;
      [a[i], a[parent]] = [a[parent], a[i]];
      i = parent;
    }
  }

  pop(): T | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      a[0] = last;
      // Sift down: swap with the smaller child while larger than it.
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let min = i;
        if (l < a.length && this.compare(a[l], a[min]) < 0) min = l;
        if (r < a.length && this.compare(a[r], a[min]) < 0) min = r;
        if (min === i) break;
        [a[i], a[min]] = [a[min], a[i]];
        i = min;
      }
    }
    return top;
  }
}
