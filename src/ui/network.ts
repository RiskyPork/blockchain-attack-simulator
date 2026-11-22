/**
 * Network tab: the live peer-to-peer network. Nodes sit on a ring, each block
 * in flight is drawn moving along its link, and every node is painted with
 * its tip's colour. While a block spreads, its colour moves from node to
 * node; during a fork two colours compete until one branch gets ahead.
 * Hash power, latency, seed and PoW mode are set here.
 */
import type { NodeId } from '../network';
import { banner, blockColor, esc, fmtSimTime, shortHex } from './format';
import { type Activity, type BlockRef, MAX_NODES, REAL_POW_BITS, nodeLabel } from './playground';
import type { App } from './state';
import { mountTransport } from './transport';
import { snapshotChains } from './tree-layout';

const VIEW_W = 420;
const VIEW_H = 340;
const RING_R = 128;
/** Slow-changing parts (table, stats, log) redraw at most this often while playing; the graph redraws every frame. */
const SLOW_REDRAW_MS = 120;
const LOG_ROWS = 40;

interface NodeEls {
  g: SVGGElement;
  body: SVGCircleElement;
  halo: SVGCircleElement;
  height: SVGTextElement;
}

export function mountNetwork(root: HTMLElement, app: App): void {
  const pg = app.playground;
  root.innerHTML = `
    <section class="card">
      <h3>Peer-to-peer network</h3>
      <p class="muted">Every node keeps its own copy of the chain, mines on its own tip and passes each new block on to its peers.
        A block takes the link latency to cross each hop, so for a while the nodes disagree, and a second miner may find a
        competing block before the first one reaches it. This network is separate from the chain on the Wallets and Explorer tabs.</p>
      <div data-ref="transport"></div>
      <div class="net-layout">
        <svg class="net-graph" data-ref="graph" viewBox="0 0 ${VIEW_W} ${VIEW_H}" role="img"
          aria-label="Network graph: nodes on a ring, coloured by the block at their tip"></svg>
        <div class="net-side">
          <label class="slider">
            <span>Link latency <output data-ref="latency-out"></output></span>
            <input type="range" data-ref="latency" min="0" max="300" step="1" />
          </label>
          <label class="slider">
            <span>Jitter, extra random delay up to <output data-ref="jitter-out"></output></span>
            <input type="range" data-ref="jitter" min="0" max="120" step="1" />
          </label>
          <p class="muted small" data-ref="propagation"></p>
          <dl class="stats" data-ref="stats"></dl>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h3>Nodes</h3>
        <button data-ref="add">Add node</button>
      </div>
      <div data-ref="attack-note"></div>
      <div class="table-scroll">
        <table class="data">
          <thead><tr>
            <th>Node</th><th>Hash power</th><th class="num">Share</th><th class="num">Height</th><th>Tip</th>
            <th class="num">Blocks found</th><th class="num" title="Blocks waiting for a parent this node hasn't received">Orphans</th><th></th>
          </tr></thead>
          <tbody data-ref="rows"></tbody>
        </table>
      </div>
      <p class="muted small">Share is the node's hash power over the total: its chance of finding the next block. A node with no hash power
        doesn't mine but still stores and relays blocks. An orphan is a block that arrived before its parent; it waits until the parent comes.</p>
    </section>

    <div class="split">
      <section class="card">
        <h3>Run setup</h3>
        <form class="controls" data-ref="setup">
          <label>Seed <input name="seed" type="number" step="1" /></label>
          <label>Proof of work
            <select name="pow">
              <option value="simulated">Simulated (fast)</option>
              <option value="real">Real SHA-256, ${REAL_POW_BITS} zero bits</option>
            </select>
          </label>
          <button type="submit">Reset run</button>
        </form>
        <p class="muted small">Reset starts again from the genesis block with the nodes and settings above. Every random choice
          (who finds each block, when, and the jitter) comes from the seed, so the same seed and settings replay the same run.
          Simulated PoW skips the nonce search; real PoW does it for every block.</p>
        <div data-ref="setup-msg"></div>
      </section>
      <section class="card">
        <h3>Activity</h3>
        <ol class="activity" data-ref="log"></ol>
      </section>
    </div>
  `;

  const ref = <T extends Element>(name: string) => root.querySelector<T>(`[data-ref="${name}"]`)!;
  const svg = ref<SVGSVGElement>('graph');
  const latency = ref<HTMLInputElement>('latency');
  const jitter = ref<HTMLInputElement>('jitter');
  const rows = ref<HTMLTableSectionElement>('rows');
  const addBtn = ref<HTMLButtonElement>('add');
  const setup = ref<HTMLFormElement>('setup');
  const seedInput = setup.elements.namedItem('seed') as HTMLInputElement;
  const powSel = setup.elements.namedItem('pow') as HTMLSelectElement;
  const setupMsg = ref('setup-msg');

  mountTransport(ref('transport'), pg);

  latency.value = String(pg.latency);
  jitter.value = String(pg.jitter);
  seedInput.value = String(pg.seed);
  powSel.value = pg.pow;

  // ---- controls ----------------------------------------------------------

  latency.addEventListener('input', () => pg.setLatency(Number(latency.value)));
  jitter.addEventListener('input', () => pg.setJitter(Number(jitter.value)));
  addBtn.addEventListener('click', () => pg.addNode());

  rows.addEventListener('input', (ev) => {
    const slider = (ev.target as HTMLElement).closest<HTMLInputElement>('[data-hp]');
    if (slider) pg.setHashPower(Number(slider.dataset.hp), Number(slider.value));
  });
  rows.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-remove]');
    if (btn) pg.removeNode(Number(btn.dataset.remove));
  });

  setup.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const seed = Number(seedInput.value);
    if (seedInput.value.trim() === '' || !Number.isSafeInteger(seed)) {
      setupMsg.innerHTML = banner('info', 'The seed must be a whole number.');
      return;
    }
    setupMsg.innerHTML = '';
    pg.reset({ seed, pow: powSel.value === 'real' ? 'real' : 'simulated' });
  });

  // ---- graph -------------------------------------------------------------

  let builtFor: unknown = null;
  let builtRing = '';
  let pos = new Map<NodeId, { x: number; y: number }>();
  const nodeEls = new Map<NodeId, NodeEls>();
  const lastFound = new Map<NodeId, number>();
  let packets: SVGGElement;

  /** Links and node shapes: rebuilt only when nodes come or go. */
  function buildGraph(): void {
    pos = ringPositions(pg.ring);
    const links = pg.net
      .links()
      .map((l) => {
        const a = pos.get(l.a)!;
        const b = pos.get(l.b)!;
        return `<line class="link" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`;
      })
      .join('');
    const nodes = pg.ring
      .map((id) => {
        const p = pos.get(id)!;
        const cls = pg.attack?.node === id ? 'net-node attacker' : 'net-node';
        return `<g class="${cls}" data-node="${id}" transform="translate(${p.x} ${p.y})">
          <circle class="halo" r="20" />
          <circle class="body" r="20" />
          <text class="label" y="4">${nodeLabel(id)}</text>
          <text class="height" y="34"></text>
        </g>`;
      })
      .join('');
    svg.innerHTML = `<g>${links}</g><g data-ref="packets"></g><g>${nodes}</g>`;
    packets = svg.querySelector<SVGGElement>('[data-ref="packets"]')!;
    nodeEls.clear();
    for (const g of svg.querySelectorAll<SVGGElement>('[data-node]')) {
      nodeEls.set(Number(g.dataset.node), {
        g,
        body: g.querySelector('.body')!,
        halo: g.querySelector('.halo')!,
        height: g.querySelector('.height')!,
      });
    }
  }

  /** Node colours and sizes, flashes for new blocks, and blocks in flight. Runs every frame. */
  function updateGraph(): void {
    for (const n of pg.nodes()) {
      const els = nodeEls.get(n.id);
      if (!els) continue;
      // Area grows with hash share, so a big miner looks big.
      const r = 12 + 26 * Math.sqrt(n.share);
      const colour = blockColor(n.tip);
      els.body.setAttribute('r', r.toFixed(1));
      els.body.style.stroke = colour;
      els.halo.setAttribute('r', r.toFixed(1));
      els.halo.style.stroke = colour;
      els.height.setAttribute('y', (r + 14).toFixed(1));
      els.height.textContent = `#${n.height}`;
      if (n.found > (lastFound.get(n.id) ?? n.found)) {
        // Restart the CSS pulse: drop the class, force a reflow, add it back.
        els.halo.classList.remove('pulse');
        void els.halo.getBoundingClientRect();
        els.halo.classList.add('pulse');
      }
      lastFound.set(n.id, n.found);
    }

    const now = pg.now;
    packets.innerHTML = pg.net
      .inFlight()
      .map((d) => {
        const a = pos.get(d.from);
        const b = pos.get(d.to);
        if (!a || !b) return '';
        const span = d.arriveAt - d.sentAt;
        const f = span > 0 ? Math.min(1, Math.max(0, (now - d.sentAt) / span)) : 1;
        const x = a.x + (b.x - a.x) * f;
        const y = a.y + (b.y - a.y) * f;
        return `<rect class="packet" x="${(x - 6).toFixed(1)}" y="${(y - 6).toFixed(1)}" width="12" height="12" rx="2" style="fill:${blockColor(d.hash)}" />`;
      })
      .join('');
  }

  // ---- table, stats, log ---------------------------------------------------

  function buildRows(): void {
    rows.innerHTML = pg.ring
      .map((id) => {
        const label = nodeLabel(id);
        const tag = pg.attack?.node === id ? ' <span class="attacker-tag">attacker</span>' : '';
        return `<tr data-node="${id}">
          <td><strong>${label}</strong>${tag}</td>
          <td class="hp"><input type="range" min="0" max="100" step="1" value="${pg.net.mining.hashPower(id)}" data-hp="${id}"
            aria-label="Hash power of ${label}" /> <output data-cell="hp"></output></td>
          <td class="num" data-cell="share"></td>
          <td class="num" data-cell="height"></td>
          <td data-cell="tip"></td>
          <td class="num" data-cell="found"></td>
          <td class="num" data-cell="orphans"></td>
          <td><button class="icon" data-remove="${id}" title="Remove ${label}" aria-label="Remove ${label}">✕</button></td>
        </tr>`;
      })
      .join('');
  }

  function updateRows(): void {
    const only = pg.ring.length === 1;
    for (const n of pg.nodes()) {
      const tr = rows.querySelector<HTMLTableRowElement>(`tr[data-node="${n.id}"]`);
      if (!tr) continue;
      const cell = (name: string) => tr.querySelector<HTMLElement>(`[data-cell="${name}"]`)!;
      const slider = tr.querySelector<HTMLInputElement>('[data-hp]')!;
      if (document.activeElement !== slider) slider.value = String(n.hashPower);
      cell('hp').textContent = String(Math.round(n.hashPower * 10) / 10); // attack presets split power into fractions
      cell('share').textContent = `${(n.share * 100).toFixed(1)}%`;
      cell('height').textContent = String(n.height);
      cell('tip').innerHTML = `${swatch(n.tip)}<code>${shortHex(n.tip, 6, 4)}</code>`;
      cell('found').textContent = String(n.found);
      cell('orphans').textContent = String(n.orphans);
      const remove = tr.querySelector<HTMLButtonElement>('[data-remove]')!;
      remove.disabled = only || pg.attack?.node === n.id;
      if (pg.attack?.node === n.id) remove.title = 'The attacker stays while the attack runs';
    }
    const a = pg.attack;
    ref('attack-note').innerHTML = a
      ? banner('info', `${nodeLabel(a.node)} is running a ${a.kind === 'selfish' ? 'selfish mining' : 'double-spend'} attack (see the Attacks tab). ` +
          'Reset run replays the same attack from genesis.')
      : '';
    addBtn.disabled = pg.ring.length >= MAX_NODES;
    addBtn.title = addBtn.disabled ? `At most ${MAX_NODES} nodes` : '';
  }

  function updateStats(): void {
    ref('latency-out').textContent = `${pg.latency} s`;
    ref('jitter-out').textContent = `${pg.jitter} s`;

    // Worst case on a ring: the block has to go halfway round.
    const n = pg.ring.length;
    const hops = Math.floor(n / 2);
    const delay = hops * (pg.latency + pg.jitter / 2);
    ref('propagation').textContent =
      hops === 0
        ? 'With one node there is nobody to disagree with, so there are no forks.'
        : `A new block needs up to ${hops} hop${hops === 1 ? '' : 's'} to reach every node: about ${fmtSimTime(delay)}, or ` +
          `${((delay / pg.blockInterval) * 100).toFixed(1)}% of the ${pg.blockInterval} s block interval. The bigger that share, ` +
          'the more often another miner finds a block before hearing about the last one, and the chain forks.';

    const nodes = pg.nodes();
    const tips = new Set(nodes.map((x) => x.tip));
    const stale = snapshotChains(pg.ring.map((id) => ({ id, chain: pg.chain(id) }))).blocks.filter((b) => b.mainFor.length === 0).length;
    const found = pg.blocksFound;
    const heights = nodes.map((x) => x.height);
    const lo = Math.min(...heights);
    const hi = Math.max(...heights);
    ref('stats').innerHTML = `
      <dt>Blocks found</dt><dd>${found}</dd>
      <dt>Chain height</dt><dd>${lo === hi ? `${hi} on every node` : `${lo}–${hi} (some nodes are behind)`}</dd>
      <dt>Tips</dt><dd>${tips.size === 1 ? 'all nodes agree' : `<strong>${tips.size} different tips</strong>: the nodes disagree`}</dd>
      <dt>Stale blocks</dt><dd>${stale}${found > 0 ? ` (${((stale / found) * 100).toFixed(1)}% of blocks found)` : ''}</dd>
      <dt>Reorgs</dt><dd>${pg.reorgs.count}${pg.reorgs.count > 0 ? `, deepest ${pg.reorgs.deepest} block${pg.reorgs.deepest === 1 ? '' : 's'}` : ''}</dd>
      <dt>Messages</dt><dd>${pg.net.stats.sent} sent, ${pg.net.inFlight().length} in flight</dd>`;
  }

  let loggedLast: Activity | undefined;
  let loggedFor: unknown = null;
  function updateLog(): void {
    const all = pg.activity;
    if (all.at(-1) === loggedLast && loggedFor === pg.net) return;
    loggedLast = all.at(-1);
    loggedFor = pg.net;
    ref('log').innerHTML = all.length
      ? all.slice(-LOG_ROWS).reverse().map(activityHtml).join('')
      : '<li class="muted">Nothing yet. Press Play: found blocks and reorgs are listed here.</li>';
  }

  // ---- render loop -------------------------------------------------------

  let seenVersion = -1;
  let slowAt = 0;
  function render(): void {
    if (root.hidden) return; // redrawn on 'show'
    const ringKey = pg.ring.join(',');
    const rebuild = builtFor !== pg.net || builtRing !== ringKey;
    if (rebuild) {
      if (builtFor !== pg.net) lastFound.clear();
      buildGraph();
      buildRows();
      builtFor = pg.net;
      builtRing = ringKey;
    }
    updateGraph();
    const t = performance.now();
    // Fresh rows are empty, so fill them now rather than at the next throttled redraw.
    if (rebuild || (pg.version !== seenVersion && (!pg.playing || t - slowAt >= SLOW_REDRAW_MS))) {
      seenVersion = pg.version;
      slowAt = t;
      updateRows();
      updateStats();
      updateLog();
    }
  }

  pg.onChange(render);
  root.addEventListener('show', () => {
    // Blocks found while the tab was hidden are old news: don't flash them all at once.
    for (const n of pg.nodes()) lastFound.set(n.id, n.found);
    render();
  });
  render();
}

/** Nodes evenly round a circle, the first at the top. */
function ringPositions(ring: readonly NodeId[]): Map<NodeId, { x: number; y: number }> {
  const cx = VIEW_W / 2;
  const cy = VIEW_H / 2 - 6;
  const out = new Map<NodeId, { x: number; y: number }>();
  ring.forEach((id, i) => {
    if (ring.length === 1) return void out.set(id, { x: cx, y: cy });
    const a = -Math.PI / 2 + (2 * Math.PI * i) / ring.length;
    out.set(id, { x: +(cx + RING_R * Math.cos(a)).toFixed(1), y: +(cy + RING_R * Math.sin(a)).toFixed(1) });
  });
  return out;
}

function swatch(hash: string): string {
  return `<span class="swatch" style="background:${blockColor(hash)}"></span>`;
}

function blockRef(b: BlockRef): string {
  return `${swatch(b.hash)}#${b.height} <code>${esc(shortHex(b.hash, 6, 4))}</code>`;
}

/** One activity log entry. The Attacks tab shows the same log. */
export function activityHtml(a: Activity): string {
  const time = `<span class="when">${fmtSimTime(a.time)}</span>`;
  if (a.kind === 'found') return `<li>${time} <strong>${nodeLabel(a.node)}</strong> found block ${blockRef(a.block)}</li>`;
  if (a.kind === 'withheld') {
    return `<li class="withheld">${time} <strong>${nodeLabel(a.node)}</strong> (attacker) found block ${blockRef(a.block)}
      and kept it hidden</li>`;
  }
  const blocks = `${a.depth} block${a.depth === 1 ? '' : 's'}`;
  return `<li class="reorg">${time} <strong>${nodeLabel(a.node)}</strong> reorg: undid ${blocks} (tip was ${blockRef(a.from)})
    and switched to ${blockRef(a.to)}, a branch with more work</li>`;
}
