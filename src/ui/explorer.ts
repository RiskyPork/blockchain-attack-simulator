/**
 * Explorer tab: mine blocks with real SHA-256 proof of work, browse the chain,
 * inspect a block's header and transactions, and watch invalid attempts get
 * rejected.
 */
import {
  type Block,
  type Transaction,
  blockHash,
  isCoinbase,
  merkleRoot,
  mineBlock,
  targetFromLeadingZeroBits,
  txid,
  txidHex,
} from '../core';
import { describeSubmitBlockError } from '../node';
import { DEMOS, type DemoOutcome } from './demos';
import { banner, esc, fmtCoins, fmtInt, fmtMs, hashHtml, hex, leadingZeroBits, shortHex } from './format';
import { type App, DEFAULT_DIFFICULTY_BITS } from './state';

const DIFFICULTIES = [8, 12, 14, 16, 18, 20, 22];

export function mountExplorer(root: HTMLElement, app: App): void {
  root.innerHTML = `
    <section class="card">
      <h3>Mine a block</h3>
      <div class="controls">
        <label>Miner <select data-ref="miner"></select></label>
        <label>Difficulty
          <select data-ref="difficulty">
            ${DIFFICULTIES.map((b) => `<option value="${b}" ${b === DEFAULT_DIFFICULTY_BITS ? 'selected' : ''}>${b} zero bits (~${fmtInt(2 ** b)} hashes)</option>`).join('')}
          </select>
        </label>
        <button class="primary" data-ref="mine">Mine block</button>
        <button data-ref="cancel" hidden>Cancel</button>
      </div>
      <p class="mining-status" data-ref="status"></p>
    </section>

    <div class="split">
      <section class="card">
        <h3>Chain</h3>
        <ol class="block-list" data-ref="blocks" reversed></ol>
      </section>
      <section class="card">
        <h3>Block details</h3>
        <div data-ref="detail"></div>
      </section>
    </div>

    <section class="card">
      <h3>Mempool <span class="muted" data-ref="mempool-count"></span></h3>
      <div data-ref="mempool"></div>
    </section>

    <section class="card">
      <h3>Try to break the rules</h3>
      <p class="muted">Each button builds an invalid transaction or block and has the node's validation rules check it.
        These are dry runs: the chain and mempool don't change.</p>
      <div class="demo-buttons" data-ref="demos">
        ${DEMOS.map((d) => `<button data-demo="${d.id}" data-kind="${d.kind}">${esc(d.label)}</button>`).join('')}
      </div>
      <div data-ref="demo-result" aria-live="polite"></div>
    </section>
  `;

  const ref = <T extends HTMLElement>(name: string) => root.querySelector<T>(`[data-ref="${name}"]`)!;
  const minerSel = ref<HTMLSelectElement>('miner');
  const difficultySel = ref<HTMLSelectElement>('difficulty');
  const mineBtn = ref<HTMLButtonElement>('mine');
  const cancelBtn = ref<HTMLButtonElement>('cancel');
  const status = ref('status');
  const blocksEl = ref('blocks');
  const detail = ref('detail');
  const demoResult = ref('demo-result');

  let selectedHeight: number | null = null;
  let busy: AbortController | null = null;

  // ---- mining ------------------------------------------------------------

  difficultySel.addEventListener('change', () => {
    app.chain.target = targetFromLeadingZeroBits(Number(difficultySel.value));
  });

  /** Live attempts / hash rate while a search runs. Used by the miner and the block demos. */
  const progress = (label: string) => {
    const start = performance.now();
    return {
      start,
      onProgress: (attempts: number) => {
        const ms = performance.now() - start;
        status.innerHTML = `${esc(label)}: <strong>${fmtInt(attempts)}</strong> nonces tried · ${fmtInt(Math.round(attempts / (ms / 1000 || 1)))} hashes/s · ${fmtMs(ms)}`;
      },
    };
  };

  const setBusy = (controller: AbortController | null) => {
    busy = controller;
    cancelBtn.hidden = !controller;
    render();
  };

  mineBtn.addEventListener('click', async () => {
    const wallet = app.wallets[Number(minerSel.value)];
    if (!wallet || busy) return;
    const controller = new AbortController();
    setBusy(controller);
    const template = app.chain.createBlockTemplate(wallet.key.address, Date.now());
    const p = progress('Mining');
    try {
      const { block, attempts } = await mineBlock(template, { signal: controller.signal, onProgress: p.onProgress });
      const ms = performance.now() - p.start;
      const result = app.chain.submitBlock(block);
      if (result.ok && result.status === 'main') {
        app.miningStats.set(hex(blockHash(block.header)), { attempts, ms });
        selectedHeight = app.chain.height;
        status.innerHTML = `Found a valid nonce after <strong>${fmtInt(attempts)}</strong> attempts in ${fmtMs(ms)}. Block #${app.chain.height} added; ${esc(wallet.name)} earned ${fmtCoins(block.txs[0].outputs[0].value)} coins.`;
      } else if (result.ok) {
        status.textContent = 'The chain changed while mining, so the block was stored off the main chain (stale). Try again.';
      } else {
        status.textContent = `The mined block was rejected: ${describeSubmitBlockError(result.error)}`;
      }
    } catch (e) {
      status.textContent = isAbort(e) ? 'Mining cancelled.' : `Mining failed: ${String(e)}`;
    } finally {
      setBusy(null);
      app.emit();
    }
  });

  cancelBtn.addEventListener('click', () => busy?.abort());

  // ---- chain + details ---------------------------------------------------

  blocksEl.addEventListener('click', (ev) => {
    const item = (ev.target as HTMLElement).closest<HTMLElement>('[data-height]');
    if (!item) return;
    selectedHeight = Number(item.dataset.height);
    render();
  });

  // ---- demos -------------------------------------------------------------

  ref('demos').addEventListener('click', async (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-demo]');
    const demo = DEMOS.find((d) => d.id === btn?.dataset.demo);
    if (!demo || busy) return;
    const controller = new AbortController();
    setBusy(controller);
    demoResult.innerHTML = `<p class="muted">Running "${esc(demo.label)}"…</p>`;
    const p = progress('Demo mining');
    try {
      showOutcome(await demo.run(app, { signal: controller.signal, onProgress: p.onProgress }));
      if (demo.kind === 'block') status.textContent = '';
    } catch (e) {
      demoResult.innerHTML = banner('info', isAbort(e) ? 'Cancelled.' : String(e instanceof Error ? e.message : e));
      if (demo.kind === 'block') status.textContent = '';
    } finally {
      setBusy(null);
    }
  });

  const showOutcome = (o: DemoOutcome) => {
    demoResult.innerHTML = `
      <p><strong>Attempt:</strong> ${esc(o.attempt)}</p>
      ${o.accepted ? banner('ok', o.reason) : banner('error', `Rejected: ${o.reason}`)}`;
  };

  // ---- render ------------------------------------------------------------

  function render(): void {
    const { chain, wallets } = app;
    const blocks = chain.blocks;

    const prevMiner = minerSel.value;
    minerSel.innerHTML = wallets.length
      ? wallets.map((w, i) => `<option value="${i}">${esc(w.name)}</option>`).join('')
      : '<option value="">(no wallets)</option>';
    if (prevMiner && Number(prevMiner) < wallets.length) minerSel.value = prevMiner;

    mineBtn.disabled = !!busy || wallets.length === 0;
    minerSel.disabled = difficultySel.disabled = !!busy;
    if (wallets.length === 0 && !busy) status.textContent = 'Create a wallet on the Wallets tab first; the miner needs an address for its reward.';
    else if (status.textContent?.startsWith('Create a wallet')) status.textContent = '';

    const funded = wallets.some((w) => chain.balanceOf(w.key.address, { includeMempool: true }) > 0);
    root.querySelectorAll<HTMLButtonElement>('[data-demo]').forEach((b) => {
      const needsFunds = b.dataset.kind === 'tx';
      b.disabled = !!busy || wallets.length === 0 || (needsFunds && !funded);
      b.title = wallets.length === 0 ? 'Create a wallet first' : needsFunds && !funded ? 'Mine a block first so a wallet owns coins' : '';
    });

    blocksEl.innerHTML = blocks.length
      ? blocks
          .map((b, h) => ({ b, h }))
          .reverse()
          .map(({ b, h }) => {
            const hash = hex(blockHash(b.header));
            return `<li data-height="${h}" class="${h === selectedHeight ? 'selected' : ''}" tabindex="0">
              <span class="height">#${h}</span>
              <code>${hashHtml(shortHex(hash, 16, 6))}</code>
              <span class="muted">${b.txs.length} tx · nonce ${fmtInt(b.header.nonce)}</span>
            </li>`;
          })
          .join('')
      : '<li class="empty">No blocks yet. Mine the first one (the genesis block).</li>';

    const selected = selectedHeight !== null ? blocks[selectedHeight] : undefined;
    detail.innerHTML = selected ? blockDetail(app, selected, selectedHeight!) : '<p class="muted">Click a block to inspect it.</p>';

    const mempool = chain.mempool;
    ref('mempool-count').textContent = `(${mempool.length})`;
    ref('mempool').innerHTML = mempool.length
      ? `<ul class="tx-list">${mempool.map((tx) => txHtml(app, tx)).join('')}</ul>
         <p class="muted">These transactions are valid but unconfirmed. The next mined block includes them all.</p>`
      : '<p class="muted">Empty. Send coins from the Wallets tab.</p>';
  }

  app.onChange(render);
  render();
}

function blockDetail(app: App, block: Block, height: number): string {
  const h = block.header;
  const hash = hex(blockHash(h));
  const bits = leadingZeroBits(h.target);
  const stats = app.miningStats.get(hash);
  const rootOk = hex(merkleRoot(block.txs.map(txid))) === hex(h.merkleRoot);
  return `
    <dl class="header-fields">
      <dt>Height</dt><dd>${height}${height === 0 ? ' (genesis)' : ''}</dd>
      <dt>Block hash</dt><dd><code class="wrap">${hashHtml(hash)}</code></dd>
      <dt>Previous hash</dt><dd><code class="wrap">${hex(h.prevHash)}</code></dd>
      <dt>Merkle root</dt><dd><code class="wrap">${hex(h.merkleRoot)}</code>
        <span class="${rootOk ? 'good' : 'bad'}">${rootOk ? '✓ matches the transactions' : '✗ mismatch'}</span></dd>
      <dt>Timestamp</dt><dd>${esc(new Date(h.timestamp).toLocaleString())}</dd>
      <dt>Target</dt><dd>${bits} leading zero bits <code class="wrap">${h.target.toString(16).padStart(64, '0')}</code></dd>
      <dt>Nonce</dt><dd>${fmtInt(h.nonce)}</dd>
      ${stats ? `<dt>Mining</dt><dd>${fmtInt(stats.attempts)} attempts in ${fmtMs(stats.ms)} (expected ≈ ${fmtInt(2 ** bits)})</dd>` : ''}
    </dl>
    <h4>Transactions (${block.txs.length})</h4>
    <ul class="tx-list">${block.txs.map((tx) => txHtml(app, tx)).join('')}</ul>`;
}

/** One transaction: where its coins come from and where they go. */
function txHtml(app: App, tx: Transaction): string {
  const outputs = tx.outputs
    .map((o) => `<li>${fmtCoins(o.value)} → ${esc(app.label(o.address))}</li>`)
    .join('');
  const inputs = isCoinbase(tx)
    ? `<li>New coins: block reward + fees (coinbase, height ${tx.height})</li>`
    : tx.inputs
        .map((i) => {
          const spent = findOutput(app, hex(i.prevOut.txid), i.prevOut.index);
          const what = spent ? `${fmtCoins(spent.value)} from ${esc(app.label(spent.address))}` : 'output';
          return `<li>${what} <code class="muted">${shortHex(hex(i.prevOut.txid))}:${i.prevOut.index}</code></li>`;
        })
        .join('');
  return `<li class="tx">
    <div class="tx-head"><span class="tag ${isCoinbase(tx) ? 'coinbase' : ''}">${isCoinbase(tx) ? 'coinbase' : 'tx'}</span>
      <code>${shortHex(txidHex(tx), 12, 6)}</code></div>
    <div class="tx-io"><ul>${inputs}</ul><span class="arrow">⟶</span><ul>${outputs}</ul></div>
  </li>`;
}

/** Find a (possibly spent) output by txid in the chain or mempool, for display. */
function findOutput(app: App, txidHexStr: string, index: number) {
  for (const b of app.chain.blocks) for (const tx of b.txs) if (txidHex(tx) === txidHexStr) return tx.outputs[index];
  for (const tx of app.chain.mempool) if (txidHex(tx) === txidHexStr) return tx.outputs[index];
  return undefined;
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}
