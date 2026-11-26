/**
 * What the Experiments tab draws, worked out without the DOM so it is
 * unit-tested: the chart specs (theory curves, simulated points with 95%
 * error bars), the table rows, the settings caption, and parsing the form's
 * number lists. The numbers themselves come from experiments/.
 */
import {
  type DoubleSpendExperiment,
  type Experiment,
  type ExperimentResult,
  type SelfishExperiment,
  doubleSpendSuccess,
  meanInterval,
  nakamotoSuccess,
  selfishRevenue,
  selfishThreshold,
  wilsonInterval,
} from '../experiments';
import { type ChartSeries, type ChartSpec, samples } from './chart';
import { fmtInt } from './format';

/** One blue, light to dark with z: more confirmations, darker line (validated as an ordinal ramp in both modes). */
export const Z_COLORS = ['var(--z1)', 'var(--z2)', 'var(--z3)', 'var(--z4)', 'var(--z5)', 'var(--z6)'] as const;
/** Categorical slots in fixed order, one per γ. */
export const GAMMA_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'] as const;

export const MAX_Z_SERIES = Z_COLORS.length;
export const MAX_GAMMA_SERIES = GAMMA_COLORS.length;
/** The selfish-mining formula is for a minority attacker. */
export const MAX_ALPHA = 0.5;

const CURVE_SAMPLES = 101;

export const pct = (x: number, digits = 1): string => `${(x * 100).toFixed(digits)}%`;
const pct0 = (x: number) => `${Math.round(x * 100)}%`;

/** "0.05, 0.1 0.3" → [0.05, 0.1, 0.3]. Null if anything isn't a number or the list is empty. */
export function parseNumbers(text: string): number[] | null {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const xs = parts.map(Number);
  return xs.every(Number.isFinite) ? xs : null;
}

/** Sorted, without repeats. */
export function uniqueSorted(xs: readonly number[]): number[] {
  return [...new Set(xs)].sort((a, b) => a - b);
}

/** Every value from `from` to `to` in steps of `step`, both ends included. Null if the range is empty or too long. */
export function stepRange(from: number, to: number, step: number, maxCount = 40): number[] | null {
  if (![from, to, step].every(Number.isFinite) || step <= 0 || to < from) return null;
  const n = Math.floor((to - from) / step + 1e-9) + 1;
  if (n > maxCount) return null;
  return Array.from({ length: n }, (_, i) => Number((from + i * step).toFixed(10)));
}

/** The settings a chart was made with, in one line under it. */
export function describeSettings(e: Experiment): string {
  const n = e.network;
  const cells = e.kind === 'double-spend' ? e.qs.length * e.zs.length : e.alphas.length * e.gammas.length;
  const trials =
    e.kind === 'double-spend'
      ? `${fmtInt(e.trials)} trial${e.trials === 1 ? '' : 's'} per point (${fmtInt(cells * e.trials)} in all)`
      : `${fmtInt(e.trials)} trial${e.trials === 1 ? '' : 's'} per point of ${fmtInt(e.blocks)} blocks each (${fmtInt(cells * e.trials)} trials)`;
  const net =
    `the attacker and ${n.honestNodes} honest node${n.honestNodes === 1 ? '' : 's'} in a ring, ` +
    `${n.latency} s per hop + up to ${n.jitter} s jitter, a block every ${n.blockInterval} s on average, simulated PoW`;
  const rule = e.kind === 'double-spend' ? ` · gives up ${e.maxDeficit} blocks behind` : '';
  return `${trials} · seed ${e.seed} · ${net}${rule}`;
}

// ---------------------------------------------------------------------------
// Double spend
// ---------------------------------------------------------------------------

type DoubleSpendResult = Extract<ExperimentResult, { kind: 'double-spend' }>;
type SelfishResult = Extract<ExperimentResult, { kind: 'selfish' }>;

export interface ChartOptions {
  /** Also draw Nakamoto's formula, dashed. */
  nakamoto: boolean;
}

/**
 * Success rate against q, one series per z. The solid curve is the exact
 * figure for the simulator's rules (doubleSpendSuccess); the optional dashed
 * one is Nakamoto's. Points appear for the cells that have run.
 */
export function doubleSpendChart(e: DoubleSpendExperiment, r: DoubleSpendResult | null, opts: ChartOptions): ChartSpec {
  const zs = uniqueSorted(e.zs).slice(0, MAX_Z_SERIES);
  const xMax = Math.max(0.5, Math.ceil(Math.max(...e.qs) * 10) / 10);
  const qs = samples(0, xMax, CURVE_SAMPLES);
  const series: ChartSeries[] = zs.map((z, i) => {
    const cells = r?.cells.filter((c) => c.z === z && c.trials > 0) ?? [];
    return {
      name: `z = ${z}`,
      color: Z_COLORS[i],
      line: qs.map((q) => [q, doubleSpendSuccess(q, z, e.maxDeficit)]),
      dashed: opts.nakamoto ? qs.map((q) => [q, nakamotoSuccess(q, z)]) : undefined,
      points: cells.map((c) => {
        const ci = wilsonInterval(c.successes, c.trials);
        const capped = c.capped ? ` ${c.capped} stopped at the block cap.` : '';
        return {
          x: c.q,
          y: ci.value,
          low: ci.low,
          high: ci.high,
          tip:
            `z = ${z}, q = ${pct0(c.q)}: ${c.successes} of ${c.trials} succeeded (${pct(ci.value)}, 95% CI ${pct(ci.low)}–${pct(ci.high)}). ` +
            `Theory ${pct(c.theory, 2)}, Nakamoto ${pct(c.nakamoto, 2)}.${capped}`,
        };
      }),
    };
  });
  return {
    title: `Double-spend success rate against the attacker's hash share q, for z = ${zs.join(', ')} confirmations`,
    x: { label: "Attacker's hash share q", min: 0, max: xMax, ticks: samples(0, xMax, Math.round(xMax * 10) + 1), format: pct0 },
    y: { label: 'Chance the double spend succeeds', min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1], format: pct0 },
    series,
  };
}

export interface DoubleSpendRow {
  z: number;
  q: number;
  trials: number;
  successes: number;
  rate: string;
  ci: string;
  theory: string;
  nakamoto: string;
}

export function doubleSpendRows(r: DoubleSpendResult): DoubleSpendRow[] {
  return r.cells.map((c) => {
    const ci = wilsonInterval(c.successes, c.trials);
    return {
      z: c.z,
      q: c.q,
      trials: c.trials,
      successes: c.successes,
      rate: c.trials ? pct(ci.value) : '–',
      ci: c.trials ? `${pct(ci.low)}–${pct(ci.high)}` : '–',
      theory: pct(c.theory, 2),
      nakamoto: pct(c.nakamoto, 2),
    };
  });
}

// ---------------------------------------------------------------------------
// Selfish mining
// ---------------------------------------------------------------------------

/**
 * Revenue share against α, one series per γ, over the fair-share line
 * (revenue = α, what honest mining earns). Each curve's break-even point,
 * where it crosses that line, is ringed, and its value is in the legend.
 */
export function selfishChart(e: SelfishExperiment, r: SelfishResult | null): ChartSpec {
  const gammas = uniqueSorted(e.gammas).slice(0, MAX_GAMMA_SERIES);
  const alphas = samples(0, MAX_ALPHA, CURVE_SAMPLES);
  const series: ChartSeries[] = gammas.map((gamma, i) => {
    const cells = r?.cells.filter((c) => c.gamma === gamma && c.trials > 0) ?? [];
    return {
      name: `γ = ${gamma} (break-even α = ${pct(selfishThreshold(gamma))})`,
      color: GAMMA_COLORS[i],
      line: alphas.map((a) => [a, selfishRevenue(a, gamma)]),
      points: cells.map((c) => {
        const ci = meanInterval(c.revenues);
        const spread = c.trials > 1 ? `, 95% CI ${pct(ci.low)}–${pct(ci.high)}` : '';
        return {
          x: c.alpha,
          y: ci.value,
          low: c.trials > 1 ? ci.low : undefined,
          high: c.trials > 1 ? ci.high : undefined,
          tip:
            `γ = ${gamma}, α = ${pct0(c.alpha)}: revenue ${pct(ci.value)} over ${c.trials} trial${c.trials === 1 ? '' : 's'}${spread}. ` +
            `Theory ${pct(c.theory)}; honest mining earns ${pct0(c.alpha)}.`,
        };
      }),
    };
  });
  return {
    title: `Selfish miner's share of main-chain blocks against its hash share α, for γ = ${gammas.join(', ')}`,
    x: { label: 'Selfish miner\'s hash share α', min: 0, max: MAX_ALPHA, ticks: samples(0, MAX_ALPHA, 6), format: pct0 },
    y: { label: 'Share of main-chain blocks (revenue)', min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1], format: pct0 },
    series,
    reference: { line: [[0, 0], [MAX_ALPHA, MAX_ALPHA]], label: 'Fair share α (what honest mining earns)' },
    annotations: gammas.map((gamma, i) => {
      const t = selfishThreshold(gamma);
      return { x: t, y: t, label: `break-even ${pct(t)}`, color: GAMMA_COLORS[i] };
    }),
  };
}

export interface SelfishRow {
  gamma: number;
  alpha: number;
  trials: number;
  revenue: string;
  ci: string;
  theory: string;
  stale: string;
}

export function selfishRows(r: SelfishResult): SelfishRow[] {
  return r.cells.map((c) => {
    const ci = meanInterval(c.revenues);
    return {
      gamma: c.gamma,
      alpha: c.alpha,
      trials: c.trials,
      revenue: c.trials ? pct(ci.value) : '–',
      ci: c.trials > 1 ? `${pct(ci.low)}–${pct(ci.high)}` : '–',
      theory: pct(c.theory),
      stale: c.trials ? pct(c.staleRate) : '–',
    };
  });
}

/** "1,234 of 6,000 trials · 12 s elapsed, about 48 s to go". */
export function progressText(done: number, total: number, elapsedMs: number): string {
  const head = `${fmtInt(done)} of ${fmtInt(total)} trials`;
  if (done === 0) return `${head} · starting…`;
  const secs = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
  if (done >= total) return `${head} · finished in ${secs(elapsedMs)}`;
  return `${head} · ${secs(elapsedMs)} elapsed, about ${secs((elapsedMs * (total - done)) / done)} to go`;
}
