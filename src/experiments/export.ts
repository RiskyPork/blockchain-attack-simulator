/**
 * Experiment results as CSV (one row per cell, for a spreadsheet) or JSON
 * (the full experiment and every cell). Both carry the seed and every
 * parameter, so anyone can rerun the experiment and get the same numbers:
 * trial i of cell c always runs with seed trialSeed(seed, c, i).
 */
import type { DoubleSpendCell, ExperimentResult, SelfishCell } from './batch';
import { meanInterval, wilsonInterval } from './stats';

export const EXPORT_FORMAT = 'blockchain-attack-simulator/experiment@1';

export function resultToJson(r: ExperimentResult, generatedAt: Date): string {
  const cells = r.kind === 'double-spend' ? r.cells.map(doubleSpendRow) : r.cells.map(selfishRow);
  return JSON.stringify(
    {
      format: EXPORT_FORMAT,
      generatedAt: generatedAt.toISOString(),
      complete: r.done >= r.total,
      trialsRun: r.done,
      trialsPlanned: r.total,
      experiment: r.experiment,
      cells: r.kind === 'double-spend' ? cells : r.cells.map((c, i) => ({ ...cells[i], revenues: c.revenues })),
    },
    null,
    2,
  );
}

export function resultToCsv(r: ExperimentResult): string {
  const e = r.experiment;
  const net = { honest_nodes: e.network.honestNodes, latency_s: e.network.latency, jitter_s: e.network.jitter, block_interval_s: e.network.blockInterval };
  const rows: Record<string, string | number>[] =
    r.kind === 'double-spend'
      ? r.cells.map((c) => ({ kind: r.kind, seed: e.seed, ...doubleSpendRow(c), max_deficit: r.experiment.maxDeficit, ...net }))
      : r.cells.map((c) => ({ kind: r.kind, seed: e.seed, ...selfishRow(c), blocks_per_trial: r.experiment.blocks, ...net }));
  if (rows.length === 0) return '';
  const header = Object.keys(rows[0]);
  return [header.join(','), ...rows.map((row) => header.map((k) => csvField(row[k])).join(','))].join('\n') + '\n';
}

/** A file name such as "double-spend-seed42.csv". */
export function exportFileName(r: ExperimentResult, ext: 'csv' | 'json'): string {
  return `${r.kind}-seed${r.experiment.seed}${r.done < r.total ? '-partial' : ''}.${ext}`;
}

function doubleSpendRow(c: DoubleSpendCell) {
  const ci = wilsonInterval(c.successes, c.trials);
  return {
    q: c.q,
    z: c.z,
    trials: c.trials,
    successes: c.successes,
    capped: c.capped,
    success_rate: round(ci.value),
    ci95_low: round(ci.low),
    ci95_high: round(ci.high),
    theory_exact: round(c.theory),
    theory_nakamoto: round(c.nakamoto),
  };
}

function selfishRow(c: SelfishCell) {
  const ci = meanInterval(c.revenues);
  return {
    alpha: c.alpha,
    gamma: c.gamma,
    trials: c.trials,
    revenue_mean: round(ci.value),
    ci95_low: round(ci.low),
    ci95_high: round(ci.high),
    theory: round(c.theory),
    fair_share: c.alpha,
    stale_rate: round(c.staleRate),
  };
}

function round(x: number): number | string {
  return Number.isFinite(x) ? Number(x.toPrecision(8)) : '';
}

function csvField(v: string | number | undefined): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
