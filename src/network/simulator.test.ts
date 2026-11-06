import { describe, expect, it } from 'vitest';
import { Rng } from './rng';
import { type LogEntry, Simulator } from './simulator';

type Tick = { type: 'tick'; label: string };
const tick = (label: string): Tick => ({ type: 'tick', label });

/** Simulator whose handler only records which events fired, and when. */
function recorder() {
  const fired: { time: number; label: string }[] = [];
  const sim = new Simulator<Tick>({ seed: 1, handler: (ev, s) => fired.push({ time: s.now, label: ev.label }) });
  return { sim, fired };
}

// ---------------------------------------------------------------------------
// Toy network: miners find blocks as a Poisson process and gossip them with
// jittered latency. Enough randomness to make the reproducibility test meaningful.
// ---------------------------------------------------------------------------

type ToyEvent = { type: 'found'; miner: number } | { type: 'deliver'; from: number; to: number; block: number };

function runToyNetwork(seed: number): readonly LogEntry<ToyEvent>[] {
  const rates = [0.5, 0.3, 0.2];
  let nextBlock = 0;
  const sim = new Simulator<ToyEvent>({
    seed,
    recordLog: true,
    handler: (ev, s) => {
      if (ev.type !== 'found') return;
      const block = nextBlock++;
      for (let to = 0; to < rates.length; to++) {
        if (to !== ev.miner) s.schedule(1 + s.rng.next(), { type: 'deliver', from: ev.miner, to, block });
      }
      s.schedule(s.rng.exponential(rates[ev.miner]), { type: 'found', miner: ev.miner });
    },
  });
  rates.forEach((rate, miner) => sim.schedule(sim.rng.exponential(rate), { type: 'found', miner }));
  sim.runUntil(200);
  return sim.log;
}

describe('Simulator reproducibility', () => {
  it('gives an identical event log for the same seed', () => {
    const a = runToyNetwork(42);
    const b = runToyNetwork(42);
    expect(a.length).toBeGreaterThan(100);
    expect(b).toEqual(a);
  });

  it('gives a different event log for a different seed', () => {
    expect(runToyNetwork(43)).not.toEqual(runToyNetwork(42));
  });

  it('logs events in non-decreasing time order', () => {
    const log = runToyNetwork(7);
    for (let i = 1; i < log.length; i++) expect(log[i].time).toBeGreaterThanOrEqual(log[i - 1].time);
  });

  it('does not keep a log unless asked', () => {
    const { sim } = recorder();
    sim.schedule(1, tick('a'));
    sim.runUntil(10);
    expect(sim.log).toEqual([]);
  });
});

describe('Simulator ordering', () => {
  it('fires events in time order and advances the clock to each one', () => {
    const { sim, fired } = recorder();
    sim.schedule(3, tick('c'));
    sim.schedule(1, tick('a'));
    sim.schedule(2, tick('b'));
    sim.runUntil(10);
    expect(fired).toEqual([
      { time: 1, label: 'a' },
      { time: 2, label: 'b' },
      { time: 3, label: 'c' },
    ]);
  });

  it('breaks ties at the same time in scheduling order (FIFO)', () => {
    const { sim, fired } = recorder();
    for (const label of ['a', 'b', 'c', 'd', 'e']) sim.schedule(5, tick(label));
    sim.runUntil(5);
    expect(fired.map((f) => f.label)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('runs a zero-delay event scheduled by a handler after events already queued for that time', () => {
    const fired: string[] = [];
    const sim = new Simulator<Tick>({
      seed: 1,
      handler: (ev, s) => {
        fired.push(ev.label);
        if (ev.label === 'a') s.schedule(0, tick('a-child'));
      },
    });
    sim.schedule(1, tick('a'));
    sim.schedule(1, tick('b'));
    sim.runUntil(1);
    expect(fired).toEqual(['a', 'b', 'a-child']);
  });

  it('matches a sorted reference for many random times (heap stress test)', () => {
    const { sim, fired } = recorder();
    const rng = new Rng(99);
    const expected: { time: number; label: string; seq: number }[] = [];
    for (let i = 0; i < 2000; i++) {
      // Few distinct times, so many ties exercise the FIFO tie-break.
      const time = rng.int(0, 50);
      sim.schedule(time, tick(String(i)));
      expected.push({ time, label: String(i), seq: i });
    }
    expected.sort((x, y) => x.time - y.time || x.seq - y.seq);
    sim.runUntil(100);
    expect(fired).toEqual(expected.map(({ time, label }) => ({ time, label })));
  });
});

describe('Simulator clock and stepping', () => {
  it('runUntil fires events at the bound, keeps later ones, and leaves the clock at the bound', () => {
    const { sim, fired } = recorder();
    sim.schedule(5, tick('at-bound'));
    sim.schedule(5.0001, tick('after'));
    expect(sim.runUntil(5)).toBe(1);
    expect(fired.map((f) => f.label)).toEqual(['at-bound']);
    expect(sim.now).toBe(5);
    expect(sim.pending).toBe(1);
    expect(sim.nextEventTime).toBe(5.0001);
  });

  it('runUntil moves the clock forward even when nothing is queued', () => {
    const { sim } = recorder();
    sim.runUntil(30);
    expect(sim.now).toBe(30);
    expect(sim.nextEventTime).toBeUndefined();
  });

  it('measures delays from the current clock', () => {
    const { sim, fired } = recorder();
    sim.runUntil(10);
    sim.schedule(2.5, tick('a'));
    sim.runUntil(20);
    expect(fired).toEqual([{ time: 12.5, label: 'a' }]);
  });

  it('step() fires exactly one event and returns it, or undefined when idle', () => {
    const { sim, fired } = recorder();
    sim.schedule(4, tick('a'));
    sim.schedule(6, tick('b'));
    expect(sim.step()).toEqual(tick('a'));
    expect(sim.now).toBe(4);
    expect(fired).toHaveLength(1);
    expect(sim.step()).toEqual(tick('b'));
    expect(sim.step()).toBeUndefined();
    expect(sim.now).toBe(6);
  });

  it('rejects negative or non-finite delays and running backwards', () => {
    const { sim } = recorder();
    expect(() => sim.schedule(-1, tick('x'))).toThrow(RangeError);
    expect(() => sim.schedule(Number.NaN, tick('x'))).toThrow(RangeError);
    expect(() => sim.schedule(Number.POSITIVE_INFINITY, tick('x'))).toThrow(RangeError);
    sim.runUntil(10);
    expect(() => sim.runUntil(9)).toThrow(RangeError);
    expect(sim.pending).toBe(0);
  });
});

describe('Simulator cancel', () => {
  it('a cancelled event never fires and no longer counts as pending', () => {
    const { sim, fired } = recorder();
    sim.schedule(1, tick('a'));
    const id = sim.schedule(2, tick('cancelled'));
    sim.schedule(3, tick('c'));
    expect(sim.cancel(id)).toBe(true);
    expect(sim.pending).toBe(2);
    sim.runUntil(10);
    expect(fired.map((f) => f.label)).toEqual(['a', 'c']);
  });

  it('cancelling the earliest event updates nextEventTime', () => {
    const { sim } = recorder();
    const id = sim.schedule(1, tick('a'));
    sim.schedule(2, tick('b'));
    sim.cancel(id);
    expect(sim.nextEventTime).toBe(2);
  });

  it('returns false for an event that already fired, was already cancelled, or never existed', () => {
    const { sim } = recorder();
    const fired = sim.schedule(1, tick('a'));
    const later = sim.schedule(5, tick('b'));
    sim.runUntil(2);
    expect(sim.cancel(fired)).toBe(false);
    expect(sim.cancel(later)).toBe(true);
    expect(sim.cancel(later)).toBe(false);
    expect(sim.cancel(12345)).toBe(false);
  });

  it('a handler can cancel another pending event at the same time', () => {
    const fired: string[] = [];
    let victim = -1;
    const sim = new Simulator<Tick>({
      seed: 1,
      handler: (ev, s) => {
        fired.push(ev.label);
        if (ev.label === 'a') s.cancel(victim);
      },
    });
    sim.schedule(1, tick('a'));
    victim = sim.schedule(1, tick('b'));
    sim.runUntil(1);
    expect(fired).toEqual(['a']);
  });
});
