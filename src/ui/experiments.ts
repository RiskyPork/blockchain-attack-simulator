/**
 * Experiments tab: run thousands of headless trials (experiments/batch.ts)
 * in a Web Worker and chart the simulated results against the theory.
 *
 *   Chart 1  double-spend success rate against q, for z = 1 to 6
 *            confirmations (Nakamoto 2008, section 11)
 *   Chart 2  selfish-mining revenue against α, for γ = 0 and 1/2, over the
 *            fair-share line (Eyal & Sirer 2014)
 *
 * This file only reads the forms, talks to the worker and draws; the charts'
 * contents come from experiment-view.ts and the numbers from experiments/.
 */
import {
  DEFAULT_DOUBLE_SPEND,
  DEFAULT_SELFISH,
  type DoubleSpendExperiment,
  EXPERIMENT_NETWORK,
  type Experiment,
  type ExperimentResult,
  LIMITS,
  type SelfishExperiment,
  type TrialNetwork,
  checkExperiment,
  exportFileName,
  resultToCsv,
  resultToJson,
} from '../experiments';
import type { WorkerReply } from '../experiments/worker';
import { attachTooltips, chartSvg, legendHtml } from './chart';
import {
  MAX_ALPHA,
  MAX_GAMMA_SERIES,
  MAX_Z_SERIES,
  describeSettings,
  doubleSpendChart,
  doubleSpendRows,
  parseNumbers,
  pct,
  progressText,
  selfishChart,
  selfishRows,
  stepRange,
  uniqueSorted,
} from './experiment-view';
import { banner, esc } from './format';
import type { App } from './state';

export function mountExperiments(root: HTMLElement, _app: App): void {
  const ds = DEFAULT_DOUBLE_SPEND;
  const sm = DEFAULT_SELFISH;
  const net = EXPERIMENT_NETWORK;
  root.innerHTML = `
    <section class="card">
      <h3>Simulation against theory</h3>
      <p class="muted">Each trial is a full run of the network from the genesis block: an attacker on node N0 and honest
        nodes in a ring, every block validated and gossiped by every node, as on the Network tab. Only the nonce search is
        skipped (Fast mode), so thousands of trials take a minute or so. They run in the background, and the charts fill in
        as results arrive: every point gets its first trial before any gets a second, so a run you stop early still shows the
        whole picture, with wider error bars. The same seed and settings always give the same results.</p>
      <form class="controls" data-ref="net">
        <label title="Honest nodes share the honest hash power equally">Honest nodes
          <input type="number" name="honest" min="1" max="${LIMITS.honestNodes}" step="1" value="${net.honestNodes}" /></label>
        <label title="One-way delay per link, in simulated seconds">Latency (s)
          <input type="number" name="latency" min="0" step="0.5" value="${net.latency}" /></label>
        <label title="Extra random delay per message, up to this many seconds">Jitter (s)
          <input type="number" name="jitter" min="0" step="0.5" value="${net.jitter}" /></label>
        <label title="Mean seconds between blocks across the whole network">Block interval (s)
          <input type="number" name="interval" min="1" step="1" value="${net.blockInterval}" /></label>
      </form>
      <p class="muted small">These network settings apply to both experiments. The formulas assume blocks reach everyone
        at once, so keep the latency small next to the block interval to compare like with like.</p>
    </section>

    <section class="card" data-ref="ds">
      <h3>Double spend: does waiting for z confirmations make a payment safe?</h3>
      <p class="muted">The attacker pays the merchant, then mines a secret branch where the same coins go back to itself, and
        publishes it once the merchant has shipped after z confirmations and the branch is longer. With hash share q under
        50%, its chance shrinks exponentially in z; above 50% it wins in the end
        (<abbr title="Satoshi Nakamoto, Bitcoin: A Peer-to-Peer Electronic Cash System, 2008">Nakamoto</abbr>, section 11).</p>
      <form class="controls" data-ref="form">
        <label>Trials per point <input type="number" name="trials" min="1" max="${LIMITS.trials}" step="1" value="${ds.trials}" /></label>
        <label title="Up to ${MAX_Z_SERIES} values, separated by commas">Confirmations z <input type="text" name="zs" value="${ds.zs.join(', ')}" size="12" /></label>
        <label>q from <input type="number" name="qFrom" min="0.01" max="0.99" step="0.01" value="${ds.qs[0]}" /></label>
        <label>to <input type="number" name="qTo" min="0.01" max="0.99" step="0.01" value="${ds.qs.at(-1)}" /></label>
        <label>step <input type="number" name="qStep" min="0.01" max="0.5" step="0.01" value="${ds.qs[1] - ds.qs[0]}" /></label>
        <label title="The attacker writes its branch off once the public chain is this many blocks ahead">Gives up behind
          <input type="number" name="deficit" min="1" max="${LIMITS.maxDeficit}" step="1" value="${ds.maxDeficit}" /></label>
        <label>Seed <input type="number" name="seed" step="1" value="${ds.seed}" /></label>
      </form>
      ${runBar()}
      <label class="toggle small"><input type="checkbox" data-ref="nakamoto" /> Also draw Nakamoto's formula (dashed)</label>
      <div data-ref="legend"></div>
      <div class="chart-box" data-ref="chart"></div>
      <p class="muted small" data-ref="caption"></p>
      <p class="muted small">Solid lines: the exact chance for this simulator's attacker, which must get strictly ahead (on a
        tie, nodes keep the branch they saw first), counts the payment's own block as the first confirmation, and gives up
        a set distance behind. Nakamoto's formula counts a tie as a win and never gives up, so it sits a little higher. Dots:
        simulated success rate, with a 95% interval (Wilson).</p>
      <details><summary>Table</summary><div class="table-scroll" data-ref="table"></div></details>
    </section>

    <section class="card" data-ref="sm">
      <h3>Selfish mining: when does withholding blocks pay?</h3>
      <p class="muted">A selfish miner keeps the blocks it finds secret and publishes them only to override or tie the honest
        chain, so honest miners waste work on blocks that go stale. γ is the share of honest hash power that mines on the
        attacker's block when two blocks tie. Above the break-even share (1 − γ)/(3 − 2γ) it earns more than its fair
        share α (<abbr title="Ittay Eyal and Emin Gün Sirer, Majority is not Enough: Bitcoin Mining is Vulnerable, 2014">Eyal &amp; Sirer</abbr>).</p>
      <form class="controls" data-ref="form">
        <label>Trials per point <input type="number" name="trials" min="1" max="${LIMITS.trials}" step="1" value="${sm.trials}" /></label>
        <label title="Blocks found in each trial; more blocks, less noise">Blocks per trial
          <input type="number" name="blocks" min="10" max="${LIMITS.blocks}" step="100" value="${sm.blocks}" /></label>
        <label title="Up to ${MAX_GAMMA_SERIES} values in [0, 1], separated by commas">Tie-break γ <input type="text" name="gammas" value="${sm.gammas.join(', ')}" size="10" /></label>
        <label>α from <input type="number" name="aFrom" min="0.01" max="${MAX_ALPHA}" step="0.01" value="${sm.alphas[0]}" /></label>
        <label>to <input type="number" name="aTo" min="0.01" max="${MAX_ALPHA}" step="0.01" value="${sm.alphas.at(-1)}" /></label>
        <label>step <input type="number" name="aStep" min="0.01" max="0.5" step="0.01" value="${sm.alphas[1] - sm.alphas[0]}" /></label>
        <label>Seed <input type="number" name="seed" step="1" value="${sm.seed}" /></label>
      </form>
      ${runBar()}
      <div data-ref="legend"></div>
      <div class="chart-box" data-ref="chart"></div>
      <p class="muted small" data-ref="caption"></p>
      <p class="muted small">Lines: Eyal &amp; Sirer's expected revenue; each crosses the grey fair-share line at its ringed
        break-even point. Dots: the selfish miner's share of an honest node's main chain, averaged over the trials, with a 95%
        interval. When a trial ends, the miner publishes any blocks it is still hiding (with a lead of two or more it would
        have won them anyway).</p>
      <details><summary>Table</summary><div class="table-scroll" data-ref="table"></div></details>
    </section>
  `;

  const netForm = root.querySelector<HTMLFormElement>('[data-ref="net"]')!;
  const readNetwork = (): TrialNetwork | string => {
    const v = (name: string) => Number((netForm.elements.namedItem(name) as HTMLInputElement).value);
    const n: TrialNetwork = { honestNodes: v('honest'), latency: v('latency'), jitter: v('jitter'), blockInterval: v('interval') };
    if (!Number.isInteger(n.honestNodes) || n.honestNodes < 1 || n.honestNodes > LIMITS.honestNodes) {
      return `Honest nodes must be a whole number from 1 to ${LIMITS.honestNodes}.`;
    }
    if (!(n.latency >= 0) || !(n.jitter >= 0)) return 'Latency and jitter must be numbers of at least 0.';
    if (!(n.blockInterval > 0)) return 'The block interval must be more than 0 seconds.';
    return n;
  };

  const panels = [
    mountPanel<DoubleSpendExperiment>(root.querySelector('[data-ref="ds"]')!, readNetwork, {
      read(get, network) {
        const zs = parseNumbers(get('zs'));
        if (!zs || zs.some((z) => !Number.isInteger(z) || z < 1 || z > LIMITS.confirmations)) {
          return `Confirmations must be whole numbers from 1 to ${LIMITS.confirmations}, separated by commas.`;
        }
        const z = uniqueSorted(zs);
        if (z.length > MAX_Z_SERIES) return `Give at most ${MAX_Z_SERIES} values of z, so each gets its own line.`;
        const qs = stepRange(Number(get('qFrom')), Number(get('qTo')), Number(get('qStep')), LIMITS.gridValues);
        if (!qs || qs.some((q) => !(q > 0 && q < 1))) return `q must run from more than 0 to less than 1, in at most ${LIMITS.gridValues} steps.`;
        return { kind: 'double-spend', seed: Number(get('seed')), trials: Number(get('trials')), qs, zs: z, maxDeficit: Number(get('deficit')), network };
      },
      chart: (e, r, opts) => doubleSpendChart(e, r?.kind === 'double-spend' ? r : null, opts),
      table: (r) =>
        r.kind !== 'double-spend'
          ? ''
          : tableHtml(['z', 'q', 'Trials', 'Successes', 'Rate', '95% CI', 'Theory', 'Nakamoto'], doubleSpendRows(r).map((x) => [
              x.z, pct(x.q, 0), x.trials, x.successes, x.rate, x.ci, x.theory, x.nakamoto,
            ])),
    }),
    mountPanel<SelfishExperiment>(root.querySelector('[data-ref="sm"]')!, readNetwork, {
      read(get, network) {
        const gs = parseNumbers(get('gammas'));
        if (!gs || gs.some((g) => !(g >= 0 && g <= 1))) return 'γ values must be numbers from 0 to 1, separated by commas.';
        const gammas = uniqueSorted(gs);
        if (gammas.length > MAX_GAMMA_SERIES) return `Give at most ${MAX_GAMMA_SERIES} values of γ, so each gets its own line.`;
        const alphas = stepRange(Number(get('aFrom')), Number(get('aTo')), Number(get('aStep')), LIMITS.gridValues);
        if (!alphas || alphas.some((a) => !(a > 0 && a <= MAX_ALPHA))) {
          return `α must run from more than 0 up to ${MAX_ALPHA}, in at most ${LIMITS.gridValues} steps (the formula is for a minority).`;
        }
        return { kind: 'selfish', seed: Number(get('seed')), trials: Number(get('trials')), alphas, gammas, blocks: Number(get('blocks')), network };
      },
      chart: (e, r) => selfishChart(e, r?.kind === 'selfish' ? r : null),
      table: (r) =>
        r.kind !== 'selfish'
          ? ''
          : tableHtml(['γ', 'α', 'Trials', 'Revenue', '95% CI', 'Theory', 'Stale rate'], selfishRows(r).map((x) => [
              x.gamma, pct(x.alpha, 0), x.trials, x.revenue, x.ci, x.theory, x.stale,
            ])),
    }),
  ];
  netForm.addEventListener('input', () => panels.forEach((p) => p.redraw()));
  netForm.addEventListener('submit', (ev) => ev.preventDefault());
}

function runBar(): string {
  return `
    <div class="run-bar">
      <button class="primary" data-ref="run">Run</button>
      <button data-ref="stop" disabled>Stop</button>
      <button data-ref="csv" disabled title="One row per point, with the seed and every setting">Download CSV</button>
      <button data-ref="json" disabled title="The whole experiment: rerun it from this file's settings to get the same numbers">Download JSON</button>
      <progress data-ref="progress" max="1" value="0" hidden></progress>
      <span class="small run-status" data-ref="status" aria-live="polite"></span>
    </div>
    <div data-ref="msg"></div>`;
}

interface PanelSpec<E extends Experiment> {
  /** The form as an experiment, or a message saying what is wrong with it. */
  read(get: (name: string) => string, network: TrialNetwork): E | string;
  chart(e: E, r: ExperimentResult | null, opts: { nakamoto: boolean }): ReturnType<typeof doubleSpendChart>;
  table(r: ExperimentResult): string;
}

function mountPanel<E extends Experiment>(card: HTMLElement, readNetwork: () => TrialNetwork | string, spec: PanelSpec<E>) {
  const ref = <T extends Element>(name: string) => card.querySelector<T>(`[data-ref="${name}"]`)!;
  const form = ref<HTMLFormElement>('form');
  const run = ref<HTMLButtonElement>('run');
  const stop = ref<HTMLButtonElement>('stop');
  const csv = ref<HTMLButtonElement>('csv');
  const json = ref<HTMLButtonElement>('json');
  const progress = ref<HTMLProgressElement>('progress');
  const status = ref('status');
  const msg = ref('msg');
  const chartBox = ref<HTMLElement>('chart');
  const nakamoto = card.querySelector<HTMLInputElement>('[data-ref="nakamoto"]');
  attachTooltips(chartBox);

  let worker: Worker | null = null;
  let result: ExperimentResult | null = null;
  let startedAt = 0;
  /** The last valid form, so the theory curves stay up while a field is half-typed. */
  let lastGood: E | null = null;

  function readForm(): E | string {
    const network = readNetwork();
    if (typeof network === 'string') return network;
    const e = spec.read((name) => (form.elements.namedItem(name) as HTMLInputElement).value, network);
    if (typeof e === 'string') return e;
    try {
      checkExperiment(e);
    } catch (err) {
      return `${capitalise(err instanceof Error ? err.message : String(err))}.`;
    }
    return e;
  }

  function redraw(): void {
    const parsed = readForm();
    if (typeof parsed !== 'string') lastGood = parsed;
    if (!worker) msg.innerHTML = typeof parsed === 'string' ? banner('error', parsed) : '';
    // A finished or running experiment is drawn with the settings it ran with.
    const e = (result?.experiment as E | undefined) ?? lastGood;
    if (!e) return;
    const c = spec.chart(e, result, { nakamoto: nakamoto?.checked ?? false });
    ref('legend').innerHTML = legendHtml(c);
    chartBox.querySelector('svg')?.remove();
    chartBox.insertAdjacentHTML('afterbegin', chartSvg(c));
    ref('caption').textContent = result
      ? `${result.done < result.total ? `Partial: ${result.done} of ${result.total} trials. ` : ''}${describeSettings(result.experiment)}.`
      : `Theory only, for ${describeSettings(e)}. Press Run to add simulated points.`;
    ref('table').innerHTML = result ? spec.table(result) : '<p class="muted small">Run the experiment to fill the table.</p>';
    const has = result !== null && result.done > 0;
    csv.disabled = json.disabled = !has;
  }

  function showProgress(r: ExperimentResult, finished: boolean): void {
    progress.hidden = false;
    progress.max = r.total;
    progress.value = r.done;
    status.textContent = progressText(r.done, r.total, performance.now() - startedAt) + (finished && r.done < r.total ? ' · stopped' : '');
  }

  function setRunning(on: boolean): void {
    run.disabled = on;
    stop.disabled = !on;
    for (const el of form.elements) (el as HTMLInputElement).disabled = on;
  }

  function finish(): void {
    worker?.terminate();
    worker = null;
    setRunning(false);
  }

  run.addEventListener('click', () => {
    const e = readForm();
    if (typeof e === 'string') {
      msg.innerHTML = banner('error', e);
      return;
    }
    msg.innerHTML = '';
    result = null;
    startedAt = performance.now();
    setRunning(true);
    worker = new Worker(new URL('../experiments/worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<WorkerReply>) => {
      const reply = ev.data;
      if (reply.type === 'error') {
        finish();
        msg.innerHTML = banner('error', `The experiment stopped with an error: ${reply.message}`);
        return;
      }
      result = reply.result;
      showProgress(reply.result, reply.type === 'done');
      if (reply.type === 'done') finish();
      redraw();
    };
    worker.onerror = (ev) => {
      ev.preventDefault();
      finish();
      msg.innerHTML = banner('error', `The background worker failed${ev.message ? `: ${ev.message}` : ''}. Try reloading the page.`);
    };
    worker.postMessage({ experiment: e });
  });

  stop.addEventListener('click', () => {
    finish();
    if (result) showProgress(result, true);
    redraw();
  });

  const download = (ext: 'csv' | 'json') => {
    if (!result) return;
    const text = ext === 'csv' ? resultToCsv(result) : resultToJson(result, new Date());
    const url = URL.createObjectURL(new Blob([text], { type: ext === 'csv' ? 'text/csv' : 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(result, ext);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  csv.addEventListener('click', () => download('csv'));
  json.addEventListener('click', () => download('json'));

  form.addEventListener('input', redraw);
  form.addEventListener('submit', (ev) => ev.preventDefault());
  nakamoto?.addEventListener('change', redraw);
  redraw();
  return { redraw };
}

function tableHtml(head: string[], rows: (string | number)[][]): string {
  return `<table class="data"><thead><tr>${head.map((h, i) => `<th${i > 1 ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((v, i) => `<td${i > 1 ? ' class="num"' : ''}>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
