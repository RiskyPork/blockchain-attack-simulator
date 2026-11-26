import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOUBLE_SPEND,
  DEFAULT_SELFISH,
  type DoubleSpendExperiment,
  EXPERIMENT_NETWORK,
  ExperimentRun,
  type SelfishExperiment,
  checkExperiment,
  runDoubleSpendTrial,
  runSelfishTrial,
  trialSeed,
} from './batch';
import { exportFileName, resultToCsv, resultToJson } from './export';
import { meanInterval, wilsonInterval } from './stats';
import { doubleSpendSuccess, selfishRevenue } from './theory';

const ds = (o: Partial<DoubleSpendExperiment> = {}): DoubleSpendExperiment => ({
  ...DEFAULT_DOUBLE_SPEND, trials: 3, qs: [0.2, 0.45], zs: [1, 2], ...o,
});
const sm = (o: Partial<SelfishExperiment> = {}): SelfishExperiment => ({
  ...DEFAULT_SELFISH, trials: 2, alphas: [0.3], gammas: [0, 1], blocks: 60, ...o,
});

describe('runDoubleSpendTrial', () => {
  it('is a pure function of its seed and settings', () => {
    for (const seed of [1, 2, 3]) {
      const o = { q: 0.4, confirmations: 2, maxDeficit: 5, seed };
      expect(runDoubleSpendTrial(o)).toEqual(runDoubleSpendTrial(o));
    }
  });

  it('a majority that never gives up always gets there, and a tiny minority almost never does', () => {
    for (let seed = 0; seed < 10; seed++) {
      expect(runDoubleSpendTrial({ q: 0.7, confirmations: 3, maxDeficit: 1000, seed })).toMatchObject({ success: true, capped: false });
    }
    let wins = 0;
    for (let seed = 0; seed < 30; seed++) wins += +runDoubleSpendTrial({ q: 0.05, confirmations: 3, maxDeficit: 3, seed }).success;
    expect(wins).toBe(0);
  });

  it('stops at the block cap and counts that as a failure', () => {
    // q = 1/2 with a far give-up point: an even race that can wander for a long time.
    const r = runDoubleSpendTrial({ q: 0.5, confirmations: 6, maxDeficit: 1000, seed: 3, maxBlocks: 5 });
    expect(r).toEqual({ success: false, capped: true, blocks: 5 });
  });

  it('succeeds about as often as the exact formula says', () => {
    for (const [q, z] of [[0.3, 2], [0.45, 3]]) {
      const n = 250;
      let wins = 0;
      for (let i = 0; i < n; i++) wins += +runDoubleSpendTrial({ q, confirmations: z, maxDeficit: 20, seed: trialSeed(9, z, i) }).success;
      const p = doubleSpendSuccess(q, z, 20);
      // Four standard errors, plus a little for the 1 s link latency the formula leaves out.
      expect(Math.abs(wins / n - p)).toBeLessThan(4 * Math.sqrt((p * (1 - p)) / n) + 0.02);
    }
  }, 60_000);
});

describe('runSelfishTrial', () => {
  it('is a pure function of its seed and settings', () => {
    const o = { alpha: 0.35, gamma: 0.5, blocks: 200, seed: 4 };
    expect(runSelfishTrial(o)).toEqual(runSelfishTrial(o));
  });

  it('earns close to Eyal & Sirer\'s revenue over a long run', () => {
    for (const gamma of [0, 0.5]) {
      const r = runSelfishTrial({ alpha: 0.4, gamma, blocks: 3000, seed: 11 });
      expect(Math.abs(r.revenue - selfishRevenue(0.4, gamma))).toBeLessThan(0.04);
      expect(r.revenue).toBeGreaterThan(0.4);
      expect(r.staleRate).toBeGreaterThan(0.1); // its overrides leave honest blocks stale
    }
  }, 30_000);
});

describe('ExperimentRun', () => {
  it('plans one cell per grid point, z (or γ) outer, with theory alongside', () => {
    const r = new ExperimentRun(ds()).result();
    expect(r.total).toBe(4 * 3);
    expect(r.kind === 'double-spend' && r.cells.map((c) => [c.z, c.q])).toEqual([[1, 0.2], [1, 0.45], [2, 0.2], [2, 0.45]]);
    if (r.kind !== 'double-spend') throw new Error('wrong kind');
    expect(r.cells[3].theory).toBeCloseTo(doubleSpendSuccess(0.45, 2, DEFAULT_DOUBLE_SPEND.maxDeficit), 12);
    expect(r.cells[3].nakamoto).toBeGreaterThan(r.cells[3].theory);
  });

  it('goes round-robin, so a run stopped early has a trial in every cell', () => {
    const run = new ExperimentRun(ds());
    for (let i = 0; i < 4; i++) run.step();
    const r = run.result();
    expect(r.done).toBe(4);
    expect(r.cells.map((c) => c.trials)).toEqual([1, 1, 1, 1]);
  });

  it('reproduces exactly from the seed, however it is sliced', () => {
    const whole = new ExperimentRun(ds()).runAll();
    const sliced = new ExperimentRun(ds());
    const early = sliced.result();
    while (sliced.step()) sliced.result();
    expect(sliced.result()).toEqual(whole);
    expect(early.done).toBe(0);
    expect(whole.done).toBe(whole.total);

    const other = new ExperimentRun(ds({ seed: 43 })).runAll();
    expect(other.cells).not.toEqual(whole.cells);
  });

  it('runs a selfish-mining sweep, recording each trial\'s revenue', () => {
    const r = new ExperimentRun(sm()).runAll();
    if (r.kind !== 'selfish') throw new Error('wrong kind');
    expect(r.cells.map((c) => [c.gamma, c.alpha, c.trials, c.revenues.length])).toEqual([[0, 0.3, 2, 2], [1, 0.3, 2, 2]]);
    expect(r.cells[1].theory).toBeCloseTo(selfishRevenue(0.3, 1), 12);
    for (const c of r.cells) for (const x of c.revenues) expect(x).toBeGreaterThanOrEqual(0);
  });

  it('hands out copies, so later trials don\'t change an earlier result', () => {
    const run = new ExperimentRun(sm());
    run.step();
    const before = run.result();
    run.runAll();
    if (before.kind !== 'selfish') throw new Error('wrong kind');
    expect(before.cells[0].revenues).toHaveLength(1);
  });

  it('does nothing more once finished', () => {
    const run = new ExperimentRun(ds({ trials: 1, qs: [0.1], zs: [1] }));
    expect(run.step()).toBe(true);
    expect(run.finished).toBe(true);
    expect(run.step()).toBe(false);
  });

  it('rejects bad parameters with a message', () => {
    expect(() => checkExperiment(ds({ qs: [0] }))).toThrow(/q must be in \(0, 1\)/);
    expect(() => checkExperiment(ds({ qs: [] }))).toThrow(/values of q/);
    expect(() => checkExperiment(ds({ zs: [0] }))).toThrow(/z must be a whole number/);
    expect(() => checkExperiment(ds({ trials: 0 }))).toThrow(/trials/);
    expect(() => checkExperiment(ds({ maxDeficit: 1.5 }))).toThrow(/give-up/);
    expect(() => checkExperiment(sm({ gammas: [1.2] }))).toThrow(/γ/);
    expect(() => checkExperiment(sm({ blocks: 5 }))).toThrow(/blocks/);
    expect(() => checkExperiment(sm({ network: { ...EXPERIMENT_NETWORK, latency: -1 } }))).toThrow(/latency/);
    expect(() => checkExperiment(DEFAULT_DOUBLE_SPEND)).not.toThrow();
    expect(() => checkExperiment(DEFAULT_SELFISH)).not.toThrow();
  });
});

describe('trialSeed', () => {
  it('gives every trial of every cell its own 32-bit seed', () => {
    const seen = new Set<number>();
    for (let c = 0; c < 60; c++) for (let t = 0; t < 100; t++) seen.add(trialSeed(42, c, t));
    expect(seen.size).toBe(6000);
    for (const s of seen) expect(s >>> 0).toBe(s);
    expect(trialSeed(42, 0, 0)).not.toBe(trialSeed(43, 0, 0));
  });
});

describe('stats', () => {
  it('Wilson interval: contains the estimate, stays in [0, 1], and is not empty at 0 successes', () => {
    const none = wilsonInterval(0, 100);
    expect(none.value).toBe(0);
    expect(none.low).toBe(0);
    expect(none.high).toBeGreaterThan(0.03);
    expect(none.high).toBeLessThan(0.04);
    const half = wilsonInterval(50, 100);
    expect(half.low).toBeCloseTo(0.4038, 3);
    expect(half.high).toBeCloseTo(0.5962, 3);
    expect(wilsonInterval(100, 100).high).toBe(1);
    expect(wilsonInterval(0, 0)).toEqual({ value: 0, low: 0, high: 1 });
    expect(() => wilsonInterval(5, 3)).toThrow(RangeError);
  });

  it('mean interval: ± 1.96 standard errors', () => {
    const m = meanInterval([1, 2, 3, 4]);
    expect(m.value).toBe(2.5);
    expect(m.high - m.value).toBeCloseTo((1.959964 * Math.sqrt(5 / 3)) / 2, 6);
    expect(meanInterval([0.4])).toEqual({ value: 0.4, low: 0.4, high: 0.4 });
    expect(meanInterval([]).value).toBeNaN();
  });
});

describe('export', () => {
  const r = new ExperimentRun(ds({ trials: 2 })).runAll();

  it('CSV: a header and one row per cell, with the seed and every parameter', () => {
    const lines = resultToCsv(r).trimEnd().split('\n');
    expect(lines).toHaveLength(1 + 4);
    const header = lines[0].split(',');
    for (const col of ['kind', 'seed', 'q', 'z', 'trials', 'successes', 'success_rate', 'ci95_low', 'ci95_high', 'theory_exact', 'theory_nakamoto', 'max_deficit', 'honest_nodes', 'latency_s']) {
      expect(header).toContain(col);
    }
    const row = Object.fromEntries(header.map((h, i) => [h, lines[1].split(',')[i]]));
    expect(row).toMatchObject({ kind: 'double-spend', seed: '42', q: '0.2', z: '1', trials: '2', max_deficit: '20' });
  });

  it('JSON: the whole experiment, enough to rerun it and get the same cells', () => {
    const parsed = JSON.parse(resultToJson(r, new Date('2026-11-27T12:00:00Z')));
    expect(parsed).toMatchObject({ format: 'blockchain-attack-simulator/experiment@1', generatedAt: '2026-11-27T12:00:00.000Z', complete: true });
    const again = new ExperimentRun(parsed.experiment).runAll();
    expect(again).toEqual(r);
  });

  it('selfish JSON keeps every trial\'s revenue', () => {
    const s = new ExperimentRun(sm({ trials: 2 })).runAll();
    const parsed = JSON.parse(resultToJson(s, new Date(0)));
    expect(parsed.cells[0].revenues).toHaveLength(2);
    expect(resultToCsv(s).split('\n')[0]).toContain('revenue_mean');
  });

  it('names files after the kind and seed, and marks partial results', () => {
    expect(exportFileName(r, 'csv')).toBe('double-spend-seed42.csv');
    const run = new ExperimentRun(ds());
    run.step();
    expect(exportFileName(run.result(), 'json')).toBe('double-spend-seed42-partial.json');
  });
});
