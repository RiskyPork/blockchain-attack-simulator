/**
 * Chain tree tab: every block any node stores, drawn left to right by height,
 * with forks branching off below the main chain. During an attack the
 * attacker's blocks get their own colour, and its hidden blocks (which no
 * node stores yet) are drawn dashed, so the private branch can be watched. tree-layout.ts decides where
 * each block goes and how it is labelled; this file only draws it.
 */
import type { NodeId } from '../network';
import { blockColor, esc, fmtSimTime, hashHtml } from './format';
import { nodeLabel } from './playground';
import type { App } from './state';
import { mountTransport } from './transport';
import { FINAL_CONFIRMATIONS, type PlacedBlock, type TreeLayout, layoutTree, snapshotChains } from './tree-layout';

/** Column pitch, block size, row pitch and margins, in px. */
const COL = 68;
const BW = 50;
const BH = 28;
const ROW = 58;
const PAD = 14;
const TOP = 34;
const WINDOWS = [30, 60, 150, 0];
const REDRAW_MS = 150;

export function mountChainTree(root: HTMLElement, app: App): void {
  const pg = app.playground;
  root.innerHTML = `
    <section class="card">
      <h3>Chain tree</h3>
      <p class="muted">Every block that any node stores, by height from left to right. The main chain runs along the top;
        forks branch off below it. Nodes choose the branch with the most cumulative work, and blocks left on a losing
        branch become stale. Run the network from here or from the Network tab.</p>
      <div data-ref="transport"></div>
      <div class="controls">
        <label>Main chain as seen by <select data-ref="viewpoint"></select></label>
        <label>Show
          <select data-ref="window">
            ${WINDOWS.map((w) => `<option value="${w}">${w ? `last ${w} heights` : 'every height'}</option>`).join('')}
          </select>
        </label>
      </div>
      <ul class="legend">
        <li><span class="key main"></span>Main chain, as seen by the selected node</li>
        <li><span class="key main final"></span>Final: ${FINAL_CONFIRMATIONS} or more confirmations</li>
        <li><span class="key other"></span>On another node's main chain: still spreading, or one side of an unsettled fork</li>
        <li><span class="key stale"></span>Stale: lost a fork race, so no node builds on it</li>
        <li><span class="tip-key">▲ N0</span>A node's current tip</li>
        <li data-ref="attack-key" hidden><span class="key attacker"></span>Found by the attacker</li>
        <li data-ref="withheld-key" hidden><span class="key withheld"></span>Hidden: the attacker hasn't published it, so no node has it</li>
      </ul>
      <div class="tree-scroll" data-ref="scroll">
        <svg class="chain-tree" data-ref="svg" role="group" aria-label="Block tree"></svg>
      </div>
      <p class="muted small" data-ref="summary"></p>
    </section>

    <section class="card">
      <h3>Block details</h3>
      <div data-ref="detail"></div>
    </section>
  `;

  const ref = <T extends Element>(name: string) => root.querySelector<T>(`[data-ref="${name}"]`)!;
  const viewpointSel = ref<HTMLSelectElement>('viewpoint');
  const windowSel = ref<HTMLSelectElement>('window');
  const scroll = ref<HTMLElement>('scroll');
  const svg = ref<SVGSVGElement>('svg');
  const detail = ref<HTMLElement>('detail');

  mountTransport(ref('transport'), pg);

  let selected: string | null = null;
  /** Keep the newest blocks in view, unless the user has scrolled back to look at older ones. */
  let follow = true;
  let layout: TreeLayout | null = null;
  let seenVersion = -1;
  let drawnAt = 0;
  let ringKey = '';

  const viewpoint = (): NodeId => Number(viewpointSel.value);

  function syncViewpoints(): void {
    const key = pg.ring.join(',');
    if (key === ringKey) return;
    ringKey = key;
    const prev = viewpointSel.value;
    viewpointSel.innerHTML = pg.ring.map((id) => `<option value="${id}">${nodeLabel(id)}</option>`).join('');
    viewpointSel.value = pg.ring.map(String).includes(prev) ? prev : String(pg.ring[0]);
  }

  function render(force = false): void {
    if (root.hidden) return; // redrawn on 'show'
    syncViewpoints();
    const t = performance.now();
    if (!force && (pg.version === seenVersion || (pg.playing && t - drawnAt < REDRAW_MS))) return;
    seenVersion = pg.version;
    drawnAt = t;

    const vp = viewpoint();
    const hidden = pg.hiddenBlocks();
    layout = layoutTree(snapshotChains(pg.ring.map((id) => ({ id, chain: pg.chain(id) })), hidden), vp);
    const isAttacker = (hash: string) => pg.isAttackerBlock(hash);
    const drawing = drawTree(layout, Number(windowSel.value), selected, pg.ring.length, isAttacker);
    ref<HTMLElement>('attack-key').hidden = pg.attack === null;
    ref<HTMLElement>('withheld-key').hidden = pg.attack === null;
    svg.setAttribute('width', String(drawing.width));
    svg.setAttribute('height', String(drawing.height));
    svg.setAttribute('viewBox', `0 0 ${drawing.width} ${drawing.height}`);
    svg.innerHTML = drawing.html;
    if (follow) scroll.scrollLeft = scroll.scrollWidth;

    const tips = new Set(pg.nodes().map((n) => n.tip)).size;
    const found = pg.blocksFound;
    ref('summary').innerHTML =
      `${layout.blocks.length} blocks stored across ${pg.ring.length} node${pg.ring.length === 1 ? '' : 's'} · ` +
      `${layout.stale} stale${found > 0 ? ` (${((layout.stale / found) * 100).toFixed(1)}% of blocks found)` : ''} · ` +
      `${nodeLabel(vp)}'s tip is #${layout.mainHeight} · ` +
      (hidden.length > 0 ? `<strong>${hidden.length} hidden by the attacker</strong> · ` : '') +
      (tips === 1 ? 'all nodes agree on the tip' : `<strong>nodes disagree: ${tips} different tips</strong>`);

    const block = selected ? layout.byHash.get(selected) : undefined;
    if (!block) selected = null;
    detail.innerHTML = block ? blockDetail(block, vp) : '<p class="muted">Click a block to inspect it.</p>';
  }

  function blockDetail(b: PlacedBlock, vp: NodeId): string {
    const rec = pg.net.mining.minedBlock(b.hash);
    const total = pg.ring.length;
    const list = (ids: NodeId[]) => (ids.length ? ids.map(nodeLabel).join(', ') : 'none');
    const vpName = nodeLabel(vp);
    let status: string;
    if (b.status === 'main') {
      const left = FINAL_CONFIRMATIONS - b.confirmations;
      status =
        `<span class="pill main${b.final ? ' final' : ''}">${b.final ? '✓ final' : `${b.confirmations} of ${FINAL_CONFIRMATIONS} confirmations`}</span> ` +
        `On ${vpName}'s main chain with ${b.confirmations} confirmation${b.confirmations === 1 ? '' : 's'}. ` +
        (b.final
          ? `With ${FINAL_CONFIRMATIONS} or more, it is treated as final: replacing it would need a branch that outruns the rest of the network for ${b.confirmations} blocks.`
          : `It becomes final after ${left} more block${left === 1 ? '' : 's'} on top.`);
    } else if (b.status === 'other') {
      status =
        `<span class="pill other">not on ${vpName}'s chain</span> On the main chain of ${list(b.mainFor)}, but not ${vpName}'s. ` +
        `Either it hasn't reached ${vpName} yet, or it is one side of a fork that the next blocks will settle.`;
    } else if (b.status === 'stale') {
      status =
        '<span class="pill stale">stale</span> No node has it on its main chain: it lost a fork race. Nodes keep it in case ' +
        'its branch overtakes, but nobody builds on it, so its coinbase reward is worth nothing.';
    } else {
      status =
        '<span class="pill withheld">hidden</span> The attacker found this block and is keeping it to itself. ' +
        'No node has it yet. It is published only when that helps the attacker: to overtake the public chain, or to tie it.';
    }
    return `
      <dl class="header-fields">
        <dt>Height</dt><dd>#${b.height}${b.height === 0 ? ' (genesis)' : ''}</dd>
        <dt>Status</dt><dd>${status}</dd>
        <dt>Block hash</dt><dd><code class="wrap">${hashHtml(b.hash)}</code></dd>
        <dt>Parent</dt><dd>${b.parent ? `<code class="wrap">${b.parent}</code>` : 'none: every node starts from this block'}</dd>
        <dt>Found</dt><dd>${
          rec
            ? `by <strong>${nodeLabel(rec.miner)}</strong>${pg.isAttackerBlock(b.hash) ? ' (attacker)' : ''} at t = ${fmtSimTime(rec.foundAt)}, ` +
              (rec.pow === 'real' ? `real PoW after ${rec.attempts.toLocaleString('en-US')} nonces` : 'simulated PoW (no nonce search)')
            : 'genesis block, created before the run'
        }</dd>
        <dt>Stored by</dt><dd>${b.heldBy.length} of ${total} nodes: ${list(b.heldBy)}</dd>
        <dt>Main chain of</dt><dd>${list(b.mainFor)}</dd>
        <dt>Tip of</dt><dd>${list(b.tipOf)}</dd>
      </dl>`;
  }

  // ---- interaction -------------------------------------------------------

  const select = (target: EventTarget | null) => {
    const g = (target as Element | null)?.closest<SVGGElement>('[data-hash]');
    if (!g) return;
    selected = g.dataset.hash!;
    render(true);
  };
  svg.addEventListener('click', (ev) => select(ev.target));
  svg.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    select(ev.target);
  });
  scroll.addEventListener('scroll', () => {
    follow = scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - 40;
  });
  viewpointSel.addEventListener('change', () => render(true));
  windowSel.addEventListener('change', () => {
    follow = true;
    render(true);
  });

  pg.onChange(() => render());
  root.addEventListener('show', () => render(true));
  render(true);
}

/** The tree as SVG markup, cut to the last `heights` heights (0 = all). */
function drawTree(layout: TreeLayout, heights: number, selected: string | null, nodeCount: number, isAttacker: (hash: string) => boolean) {
  const visible = heights > 0 ? layout.blocks.filter((b) => b.height > layout.maxHeight - heights) : layout.blocks;
  let minH = Number.POSITIVE_INFINITY;
  let maxRow = 0;
  for (const b of visible) {
    minH = Math.min(minH, b.height);
    maxRow = Math.max(maxRow, b.row);
  }
  if (visible.length === 0) return { html: '', width: 0, height: 0 };

  const x = (h: number) => PAD + (h - minH) * COL;
  const y = (row: number) => TOP + row * ROW;
  const width = x(layout.maxHeight) + BW + PAD;
  const height = y(maxRow) + BH + 22;

  const edges: string[] = [];
  const blocks: string[] = [];
  for (const b of visible) {
    const bx = x(b.height);
    const by = y(b.row) + BH / 2;
    const parent = b.parent === null ? undefined : layout.byHash.get(b.parent);
    if (parent && parent.height >= minH) {
      const px = x(parent.height) + BW;
      const py = y(parent.row) + BH / 2;
      edges.push(`<path class="edge ${b.status}" d="M${px} ${py} C${px + 12} ${py} ${bx - 12} ${by} ${bx} ${by}" />`);
    } else if (parent) {
      edges.push(`<path class="edge ${b.status}" d="M${bx - 12} ${by} H${bx}" />`); // parent is off the left edge
    }
    blocks.push(blockSvg(b, bx, y(b.row), selected === b.hash, nodeCount, isAttacker(b.hash)));
  }

  // The finality line sits between the last block with 6 confirmations and the first with 5.
  let finality = '';
  const lastFinal = layout.mainHeight - (FINAL_CONFIRMATIONS - 1);
  if (layout.mainHeight >= 0 && lastFinal >= minH) {
    const lx = x(lastFinal) + BW + (COL - BW) / 2;
    finality = `
      <line class="final-line" x1="${lx}" y1="6" x2="${lx}" y2="${height - 4}" />
      <text class="final-label" x="${lx - 8}" y="18" text-anchor="end">✓ final after ${FINAL_CONFIRMATIONS} confirmations</text>
      <text class="pending-label" x="${lx + 8}" y="18">not final yet</text>`;
  }
  return { html: `${finality}<g>${edges.join('')}</g><g>${blocks.join('')}</g>`, width, height };
}

function blockSvg(b: PlacedBlock, x: number, y: number, selected: boolean, nodeCount: number, attacker: boolean): string {
  const classes = ['tb', b.status, b.final ? 'final' : '', attacker ? 'attacker' : '', selected ? 'selected' : ''].filter(Boolean).join(' ');
  const conf = b.status === 'main' ? `, ${b.confirmations} confirmation${b.confirmations === 1 ? '' : 's'}` : '';
  const tipText =
    b.tipOf.length === 0 ? '' : b.tipOf.length === nodeCount && nodeCount > 1 ? 'all nodes' : b.tipOf.length > 3 ? `${b.tipOf.length} nodes` : b.tipOf.map(nodeLabel).join(' ');
  const by = attacker ? ', found by the attacker' : '';
  return `<g class="${classes}" data-hash="${b.hash}" tabindex="0" role="button" aria-label="Block ${b.height}, ${b.status}${conf}${by}">
    <title>#${b.height} ${b.hash.slice(0, 16)}… (${b.status}${conf}${by})${b.tipOf.length ? `\nTip of ${b.tipOf.map(nodeLabel).join(', ')}` : ''}</title>
    <rect x="${x}" y="${y}" width="${BW}" height="${BH}" rx="6" />
    <circle class="dot" cx="${x + 9}" cy="${y + BH / 2}" r="3.5" style="fill:${blockColor(b.hash)}" />
    <text class="h" x="${x + BW / 2 + 5}" y="${y + BH / 2 + 4}" text-anchor="middle">#${b.height}</text>
    ${tipText ? `<text class="tip-mark" x="${x + BW / 2}" y="${y + BH + 13}" text-anchor="middle">▲ ${esc(tipText)}</text>` : ''}
  </g>`;
}
