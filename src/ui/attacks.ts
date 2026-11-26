/**
 * Attacks tab: pick an attack and its parameters, launch it on the live
 * network, and watch it play out. The attack runs on the same network as the
 * Network and Chain tree tabs, so the chain tree shows the attacker's blocks
 * (hidden ones dashed) while this tab shows the numbers.
 *
 * Everything shown comes from readAttack (attack-readout.ts); this file only
 * draws it and passes the user's choices to the playground.
 */
import type { SelfishState } from '../strategies';
import { type AttackReadout, type DoubleSpendReadout, type SelfishReadout, readAttack } from './attack-readout';
import { banner, esc, fmtCoins } from './format';
import { activityHtml } from './network';
import { ATTACK_PAYMENT, type AttackConfig, DEFAULT_ATTACK, PRESET_51, nodeLabel } from './playground';
import type { App } from './state';
import { mountTransport, startPlaying } from './transport';

const REDRAW_MS = 120;
const LOG_ROWS = 30;
/** Blocks drawn per row in the race picture; longer rows show a count instead. */
const RACE_MAX = 40;
/** Below this many main-chain blocks, selfish mining's revenue is mostly luck (one race can swing it by 10%). */
const EARLY_BLOCKS = 50;

const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;

export function mountAttacks(root: HTMLElement, app: App): void {
  const pg = app.playground;
  root.innerHTML = `
    <section class="card">
      <h3>Launch an attack</h3>
      <p class="muted">The attacker is node N0 of the network on the Network tab. Launching restarts that network from the
        genesis block with the same seed and nodes, gives N0 the hash share you pick, and sets it to work. Watch the
        branches on the Chain tree tab: the attacker's blocks are drawn in their own colour, and blocks it is hiding are dashed.</p>
      <form class="controls attack-form" data-ref="form">
        <label>Attack
          <select name="kind">
            <option value="double-spend">Double spend</option>
            <option value="selfish">Selfish mining</option>
          </select>
        </label>
        <label class="slider"><span>Attacker's hash share α: <output name="alpha-out"></output></span>
          <input type="range" name="alpha" min="5" max="95" step="1" />
        </label>
        <label data-kind="double-spend">Merchant waits for k confirmations
          <input type="number" name="k" min="1" max="30" step="1" />
        </label>
        <label data-kind="double-spend">Give up when this many blocks behind
          <input type="number" name="deficit" min="1" max="100" step="1" />
        </label>
        <label class="check" data-kind="double-spend"><input type="checkbox" name="never" /> Never give up</label>
        <label class="slider" data-kind="selfish"><span>Tie-break γ: <output name="gamma-out"></output></span>
          <input type="range" name="gamma" min="0" max="100" step="5" />
        </label>
      </form>
      <div class="attack-buttons">
        <button class="primary" data-ref="launch">Launch attack</button>
        <button data-ref="preset" title="Double spend with 55% of the hash power, never giving up">51% attack preset</button>
        <button data-ref="end">End attack</button>
      </div>
      <p class="muted small" data-ref="explain"></p>
      <div data-ref="msg"></div>
    </section>

    <section class="card">
      <h3>Live</h3>
      <div data-ref="transport"></div>
      <div data-ref="outcome"></div>
      <div data-ref="race"></div>
      <dl class="stats" data-ref="stats"></dl>
    </section>

    <div class="split">
      <section class="card">
        <h3>Metrics</h3>
        <div class="tiles" data-ref="tiles"></div>
        <h4>Reorg depths</h4>
        <div data-ref="histogram"></div>
      </section>
      <section class="card">
        <h3>Activity</h3>
        <ol class="activity" data-ref="log"></ol>
      </section>
    </div>
  `;

  const ref = <T extends Element>(name: string) => root.querySelector<T>(`[data-ref="${name}"]`)!;
  const form = ref<HTMLFormElement>('form');
  const field = <T extends Element>(name: string) => form.elements.namedItem(name) as unknown as T;
  const kind = field<HTMLSelectElement>('kind');
  const alpha = field<HTMLInputElement>('alpha');
  const k = field<HTMLInputElement>('k');
  const deficit = field<HTMLInputElement>('deficit');
  const never = field<HTMLInputElement>('never');
  const gamma = field<HTMLInputElement>('gamma');
  const msg = ref('msg');

  mountTransport(ref('transport'), pg);

  // ---- form --------------------------------------------------------------

  function fill(c: Readonly<AttackConfig>): void {
    kind.value = c.kind;
    alpha.value = String(Math.round(c.alpha * 100));
    k.value = String(c.confirmations);
    never.checked = c.maxDeficit === Infinity;
    deficit.value = String(c.maxDeficit === Infinity ? DEFAULT_ATTACK.maxDeficit : c.maxDeficit);
    gamma.value = String(Math.round(c.gamma * 100));
    syncForm();
  }

  function syncForm(): void {
    const isSelfish = kind.value === 'selfish';
    for (const el of form.querySelectorAll<HTMLElement>('[data-kind]')) el.hidden = el.dataset.kind !== kind.value;
    deficit.disabled = never.checked;
    field<HTMLOutputElement>('alpha-out').value = `${alpha.value}%`;
    field<HTMLOutputElement>('gamma-out').value = (Number(gamma.value) / 100).toFixed(2);
    ref('explain').textContent = isSelfish
      ? 'Selfish mining (Eyal & Sirer 2014): the attacker keeps the blocks it finds secret and publishes them only to ' +
        'override or tie the honest chain, so honest miners waste work on blocks that go stale. γ is the share of honest ' +
        'hash power that mines on the attacker\'s block when two blocks tie. Above α = (1 − γ)/(3 − 2γ) it earns more than its fair share α.'
      : `Double spend: at t = 0 the attacker pays a merchant ${fmtCoins(ATTACK_PAYMENT)} coins on the public chain, and in secret ` +
        'mines a branch where the same coins go back to itself. Once the merchant has k confirmations and the secret branch ' +
        'has more work, it publishes the branch, every node switches to it, and the payment disappears. With α below 50% it ' +
        'usually falls behind and gives up; above 50% it gets there in the end.';
  }

  function readForm(): AttackConfig | string {
    const c: AttackConfig = {
      kind: kind.value === 'selfish' ? 'selfish' : 'double-spend',
      alpha: Number(alpha.value) / 100,
      confirmations: Number(k.value),
      maxDeficit: never.checked ? Infinity : Number(deficit.value),
      gamma: Number(gamma.value) / 100,
    };
    if (c.kind === 'double-spend') {
      if (!Number.isInteger(c.confirmations) || c.confirmations < 1) return 'k must be a whole number of at least 1.';
      if (c.maxDeficit !== Infinity && (!Number.isInteger(c.maxDeficit) || c.maxDeficit < 1)) {
        return 'The give-up distance must be a whole number of at least 1.';
      }
    }
    return c;
  }

  function launch(c: AttackConfig): void {
    if (pg.ring.length < 2) {
      msg.innerHTML = banner('error', 'An attack needs at least two nodes. Add one on the Network tab.');
      return;
    }
    msg.innerHTML = '';
    pg.launchAttack(c);
    startPlaying(pg);
  }

  form.addEventListener('input', syncForm);
  form.addEventListener('submit', (ev) => ev.preventDefault());
  ref('launch').addEventListener('click', () => {
    const c = readForm();
    if (typeof c === 'string') msg.innerHTML = banner('error', c);
    else launch(c);
  });
  ref('preset').addEventListener('click', () => {
    fill(PRESET_51);
    launch({ ...PRESET_51 });
  });
  ref('end').addEventListener('click', () => {
    pg.pause();
    pg.endAttack();
  });

  fill(DEFAULT_ATTACK);

  // ---- readout -------------------------------------------------------------

  let seenVersion = -1;
  let drawnAt = 0;
  function render(force = false): void {
    if (root.hidden) return; // redrawn on 'show'
    const t = performance.now();
    if (!force && (pg.version === seenVersion || (pg.playing && t - drawnAt < REDRAW_MS))) return;
    seenVersion = pg.version;
    drawnAt = t;

    const r = readAttack(pg);
    ref<HTMLButtonElement>('end').disabled = r === null;
    ref('outcome').innerHTML = outcomeHtml(r);
    ref('race').innerHTML = r ? (r.kind === 'selfish' ? selfishStates(r) : raceHtml(r)) : '';
    ref('stats').innerHTML = r ? (r.kind === 'selfish' ? selfishStats(r) : doubleSpendStats(r)) : '';
    ref('tiles').innerHTML = tilesHtml(r);
    ref('histogram').innerHTML = histogramHtml(pg.reorgs.histogram());
    const log = pg.activity.slice(-LOG_ROWS).reverse();
    ref('log').innerHTML = log.length ? log.map(activityHtml).join('') : '<li class="muted">Nothing yet.</li>';
  }

  pg.onChange(() => render());
  root.addEventListener('show', () => render(true));
  render(true);
}

// ---------------------------------------------------------------------------
// Pieces of the readout
// ---------------------------------------------------------------------------

function outcomeHtml(r: AttackReadout | null): string {
  if (!r) return banner('info', 'No attack is running: every node is honest. Pick an attack above and press Launch.');
  const who = nodeLabel(r.attacker);
  if (r.kind === 'double-spend') {
    switch (r.outcome) {
      case 'success':
        return banner('error', `Double spend succeeded. The merchant shipped after ${r.needed} confirmation${r.needed === 1 ? '' : 's'}, then ${who} published a longer branch and the payment vanished from the main chain.`);
      case 'failed':
        return r.phase === 'abandoned'
          ? banner('ok', `Attack failed. ${who} fell ${r.maxDeficit} blocks behind and gave up: the payment stands.`)
          : banner('ok', `Attack failed. ${who} published its branch, but the honest chain won the race that followed: the payment stands.`);
      case 'pending':
        return banner('info', r.confirmations < r.needed
          ? `Racing. The merchant has ${r.confirmations} of ${r.needed} confirmations; ${who} is mining a secret branch.`
          : `Racing. The merchant has shipped; ${who} needs a branch with more work than the public chain before it can publish.`);
    }
  }
  const verdict = `${who} has ${pct(r.revenue)} of the main chain's blocks with ${pct(r.alpha)} of the hash power`;
  if (r.mainBlocks < EARLY_BLOCKS) {
    return banner('info', `Selfish mining is running. So far ${verdict}, but over the first ${EARLY_BLOCKS} blocks luck ` +
      'outweighs strategy: let it run (a high speed helps) before judging.');
  }
  return r.revenue > r.alpha
    ? banner('error', `Selfish mining is paying off: ${verdict}.`)
    : banner('ok', `Selfish mining isn't paying: ${verdict}. Honest mining would earn ${pct(r.alpha)}.`);
}

/** Two rows of blocks above the fork point: the attacker's branch and the public chain, with the merchant's k-th block ringed. */
function raceHtml(r: DoubleSpendReadout): string {
  const row = (n: number, cls: string, k?: number) =>
    n > RACE_MAX
      ? `<span class="muted">${n} blocks</span>`
      : Array.from({ length: n }, (_, i) => `<span class="blk ${cls}${k === i + 1 ? ' k' : ''}"></span>`).join('');
  const hidden = r.phase === 'mining' ? ' hidden' : '';
  return `
    <div class="race" role="img" aria-label="Attacker's branch: ${r.privateBlocks} blocks. Public chain: ${r.publicBlocks} blocks since the fork.">
      <span class="row-label">${nodeLabel(r.attacker)}'s branch${hidden ? ' (secret)' : ''}</span>
      <span class="blocks">${row(r.privateBlocks, `attacker${hidden}`)}</span><span class="count">${r.privateBlocks}</span>
      <span class="row-label">Public chain</span>
      <span class="blocks">${row(r.publicBlocks, '', r.needed)}</span><span class="count">${r.publicBlocks}</span>
    </div>
    <p class="muted small">Blocks above the fork point (the tip when the payment went out). The ringed public block is the
      merchant's ${r.needed}${ordinal(r.needed)} confirmation, when it ships.</p>`;
}

function doubleSpendStats(r: DoubleSpendReadout): string {
  const lead = r.privateBlocks - r.publicBlocks;
  const giveUp = r.maxDeficit === Infinity ? 'never' : `${r.maxDeficit} blocks behind`;
  let chance = 'race over';
  if (r.catchUp !== null) {
    chance = r.toGetAhead === 0
      ? 'already ahead'
      : `${pct(r.catchUp, r.catchUp < 0.01 ? 3 : 1)} to gain ${r.toGetAhead} block${r.toGetAhead === 1 ? '' : 's'} on the public chain` +
        (r.alpha >= 0.5 ? ' (certain with a majority)' : '');
  }
  return `
    <dt>Phase</dt><dd>${esc(PHASES[r.phase])}</dd>
    <dt>Attacker lead</dt><dd>${lead > 0 ? '+' : ''}${lead} block${Math.abs(lead) === 1 ? '' : 's'}</dd>
    <dt>Merchant confirmations</dt><dd>${r.confirmations >= r.needed ? `${r.confirmations}: shipped at ${r.needed}` : `${r.confirmations} of ${r.needed}`}</dd>
    <dt>Gives up</dt><dd>${giveUp}</dd>
    <dt title="Nakamoto 2008, section 11, if the attacker never gave up">Chance of getting ahead</dt><dd>${chance}</dd>`;
}

const PHASES = {
  idle: 'not launched',
  mining: 'mining a secret branch',
  released: 'branch published',
  abandoned: 'gave up, mining honestly again',
} as const;

const STATES: { state: SelfishState; label: string; means: string }[] = [
  { state: '0', label: '0', means: 'No secret blocks: mining on the public tip.' },
  { state: "0'", label: '0′', means: 'Tie: its block and an honest one race at the same height. A share γ of honest miners build on its block.' },
  { state: '1', label: '1', means: 'One block ahead, kept secret. If an honest block arrives, it publishes to force a tie.' },
  { state: '2', label: '2', means: 'Two ahead. If an honest block arrives, it publishes everything and the honest block goes stale.' },
  { state: '>2', label: '> 2', means: 'Well ahead. For each honest block it publishes one of its own, staying ahead.' },
];

function selfishStates(r: SelfishReadout): string {
  const now = STATES.find((s) => s.state === r.status.state)!;
  return `
    <ol class="states" aria-label="Selfish mining state machine: lead of the secret branch">
      ${STATES.map((s) => `<li class="${s.state === r.status.state ? 'on' : ''}">${s.label}</li>`).join('')}
    </ol>
    <p class="small"><strong>State ${now.label}:</strong> ${esc(now.means)}</p>`;
}

function selfishStats(r: SelfishReadout): string {
  const c = r.counters;
  return `
    <dt>Lead</dt><dd>${r.status.lead} block${r.status.lead === 1 ? '' : 's'}</dd>
    <dt>Hidden blocks</dt><dd>${r.status.withheld}</dd>
    <dt>Ties forced</dt><dd>${c.races}${c.races > 0 ? `, ${c.racesWonByUs} won by finding the next block` : ''}</dd>
    <dt>Overrides</dt><dd>${c.overrides} (published a longer branch, making honest blocks stale)</dd>
    <dt>γ</dt><dd>${r.gamma.toFixed(2)}: break-even α = ${pct(r.threshold)}</dd>`;
}

function tilesHtml(r: AttackReadout | null): string {
  const tile = (label: string, value: string, note: string) =>
    `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="note">${note}</div></div>`;
  if (!r) return '<p class="muted">Launch an attack to see the attacker\'s share of the rewards.</p>';
  const tiles = [
    tile('Attacker hash share', pct(r.alpha), 'its fair share of blocks'),
    tile('Attacker revenue share', r.mainBlocks ? pct(r.revenue) : '–', `of ${r.mainBlocks} main-chain blocks, as ${nodeLabel(r.observer)} sees it`),
  ];
  if (r.kind === 'selfish') {
    const note = r.alpha >= 0.5
      ? 'with a majority its secret branch is never caught, so in the end every block is its own'
      : `Eyal & Sirer, α = ${pct(r.alpha, 0)}, γ = ${r.gamma.toFixed(2)}`;
    tiles.push(tile('Theory', pct(r.theory), note));
  }
  tiles.push(tile('Stale rate', pct(r.staleRate), 'of all blocks found, off the main chain'));
  return tiles.join('');
}

/** Reorg depths as a bar chart: one bar per depth, height = how many node reorgs had that depth. */
function histogramHtml(h: [number, number][]): string {
  if (h.length === 0) return '<p class="muted small">No reorgs yet. A reorg is a node undoing blocks to follow a branch with more work.</p>';
  const max = Math.max(...h.map(([, n]) => n));
  const text = h.map(([d, n]) => `depth ${d}: ${n}`).join(', ');
  return `
    <ol class="histogram" aria-label="Reorgs by depth: ${text}">
      ${h.map(([d, n]) => `<li title="Depth ${d}: ${n} reorg${n === 1 ? '' : 's'}"><span class="bar" style="height:${(n / max) * 100}%"></span></li>`).join('')}
    </ol>
    <div class="histogram-axis" aria-hidden="true">${h.map(([d]) => `<span>${d}</span>`).join('')}</div>
    <p class="muted small">Blocks undone per reorg, counted on every node (tallest bar: ${max}). Forks from latency undo 1 block;
      a released attack branch undoes many at once.</p>`;
}

function ordinal(n: number): string {
  const s = n % 100;
  if (s >= 11 && s <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
}
