import { describe, expect, it } from 'vitest';
import { DEFAULT_DOUBLE_SPEND, DEFAULT_SELFISH, ExperimentRun, selfishThreshold } from '../experiments';
import { chartSvg, legendHtml, samples } from './chart';
import {
  Z_COLORS,
  describeSettings,
  doubleSpendChart,
  doubleSpendRows,
  parseNumbers,
  progressText,
  selfishChart,
  selfishRows,
  stepRange,
  uniqueSorted,
} from './experiment-view';

describe('form parsing', () => {
  it('reads comma- or space-separated numbers', () => {
    expect(parseNumbers('1, 2,3  4')).toEqual([1, 2, 3, 4]);
    expect(parseNumbers('0; 0.5')).toEqual([0, 0.5]);
    expect(parseNumbers('')).toBeNull();
    expect(parseNumbers('1, two')).toBeNull();
  });

  it('builds a stepped range with both ends, without floating-point fuzz', () => {
    expect(stepRange(0.05, 0.5, 0.05)).toEqual([0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5]);
    expect(stepRange(0.1, 0.1, 0.05)).toEqual([0.1]);
    expect(stepRange(0.5, 0.1, 0.05)).toBeNull();
    expect(stepRange(0, 1, 0)).toBeNull();
    expect(stepRange(0, 1, 0.01, 40)).toBeNull(); // 101 values
  });

  it('sorts and drops repeats', () => {
    expect(uniqueSorted([3, 1, 3, 2])).toEqual([1, 2, 3]);
  });
});

describe('double-spend chart (S4-3)', () => {
  const e = { ...DEFAULT_DOUBLE_SPEND, trials: 2, qs: [0.2, 0.45], zs: [3, 1] };

  it('before a run: one theory curve per z, light to dark, and no points', () => {
    const c = doubleSpendChart(e, null, { nakamoto: false });
    expect(c.series.map((s) => s.name)).toEqual(['z = 1', 'z = 3']);
    expect(c.series.map((s) => s.color)).toEqual([Z_COLORS[0], Z_COLORS[1]]);
    expect(c.series.every((s) => s.points!.length === 0 && s.dashed === undefined)).toBe(true);
    expect(c.x.max).toBe(0.5);
  });

  it('after a run: a point per cell with a Wilson interval, and Nakamoto dashed on request', () => {
    const r = new ExperimentRun(e).runAll();
    if (r.kind !== 'double-spend') throw new Error('wrong kind');
    const c = doubleSpendChart(e, r, { nakamoto: true });
    const pts = c.series.flatMap((s) => s.points!);
    expect(pts).toHaveLength(4);
    for (const p of pts) {
      expect(p.low!).toBeLessThanOrEqual(p.y);
      expect(p.high!).toBeGreaterThanOrEqual(p.y);
      expect(p.tip).toMatch(/of 2 succeeded .* Theory .* Nakamoto/);
    }
    expect(c.series[0].dashed).toHaveLength(c.series[0].line!.length);
    const rows = doubleSpendRows(r);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ z: 3, q: 0.2, trials: 2 });
  });

  it('widens the x-axis when q goes past one half', () => {
    expect(doubleSpendChart({ ...e, qs: [0.2, 0.62] }, null, { nakamoto: false }).x.max).toBe(0.7);
  });
});

describe('selfish-mining chart (S4-3)', () => {
  const e = { ...DEFAULT_SELFISH, trials: 2, alphas: [0.3, 0.4], gammas: [0.5, 0], blocks: 100 };

  it('has the fair-share line, one curve per γ, and each break-even point ringed', () => {
    const c = selfishChart(e, null);
    expect(c.series.map((s) => s.name)).toEqual(['γ = 0 (break-even α = 33.3%)', 'γ = 0.5 (break-even α = 25.0%)']);
    expect(c.reference!.line).toEqual([[0, 0], [0.5, 0.5]]);
    expect(c.annotations!.map((a) => a.x)).toEqual([selfishThreshold(0), selfishThreshold(0.5)]);
    expect(legendHtml(c)).toContain('Fair share');
  });

  it('after a run: the mean revenue per cell with its interval', () => {
    const r = new ExperimentRun(e).runAll();
    if (r.kind !== 'selfish') throw new Error('wrong kind');
    const pts = selfishChart(e, r).series.flatMap((s) => s.points!);
    expect(pts).toHaveLength(4);
    for (const p of pts) expect(p.tip).toMatch(/over 2 trials/);
    expect(selfishRows(r).map((x) => x.trials)).toEqual([2, 2, 2, 2]);
  });
});

describe('chartSvg', () => {
  const spec = {
    title: 'A <test> chart',
    x: { label: 'x', min: 0, max: 1, ticks: [0, 0.5, 1], format: String },
    y: { label: 'y', min: 0, max: 1, ticks: [0, 1], format: String },
    series: [
      { name: 'a', color: 'red', line: samples(0, 1, 3).map((x) => [x, x] as [number, number]), points: [{ x: 0.5, y: 2, low: 0.4, high: 0.6, tip: 'p "1"' }] },
      { name: 'b', color: 'blue', points: [{ x: 0.5, y: 0.5, tip: 'p2' }] },
    ],
  };

  it('escapes text, draws a focusable point per result, and clamps values to the axis', () => {
    const svg = chartSvg(spec);
    expect(svg).toContain('aria-label="A &lt;test&gt; chart"');
    expect(svg.match(/class="pt"/g)).toHaveLength(2);
    expect(svg).toContain('data-tip="p &quot;1&quot;"');
    // y = 2 is off the top: drawn on the top edge (y = 14 px).
    expect(svg).toMatch(/<circle class="dot" cx="[\d.]+" cy="14.0"/);
  });

  it('nudges series apart sideways at the same x', () => {
    const xs = [...chartSvg(spec).matchAll(/class="dot" cx="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(xs[1] - xs[0]).toBe(4);
  });
});

describe('describeSettings and progressText', () => {
  it('names every setting a reader needs to reproduce the chart', () => {
    const s = describeSettings(DEFAULT_DOUBLE_SPEND);
    for (const part of ['100 trials per point', '6,000 in all', 'seed 42', '4 honest nodes', '1 s per hop', '600 s', 'gives up 20 blocks behind']) {
      expect(s).toContain(part);
    }
    expect(describeSettings(DEFAULT_SELFISH)).toContain('3 trials per point of 2,000 blocks each (54 trials)');
  });

  it('estimates the time left from the pace so far', () => {
    expect(progressText(0, 100, 0)).toBe('0 of 100 trials · starting…');
    expect(progressText(25, 100, 10_000)).toBe('25 of 100 trials · 10 s elapsed, about 30 s to go');
    expect(progressText(100, 100, 90_000)).toBe('100 of 100 trials · finished in 1 min 30 s');
  });
});
