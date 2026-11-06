/**
 * Wallets tab: create key pairs, see balances (confirmed and pending), and
 * send coins. The node, not this form, decides whether a payment is valid.
 */
import { describeTxError, outPointKey } from '../core';
import { buildPayment } from '../node';
import { banner, esc, fmtCoins, hex, parseCoins, shortHex } from './format';
import type { App } from './state';

const OTHER = 'other';

export function mountWallets(root: HTMLElement, app: App): void {
  root.innerHTML = `
    <section class="card">
      <div class="card-head">
        <h3>Wallets</h3>
        <button class="primary" data-ref="new">New wallet</button>
      </div>
      <p class="muted">Each wallet is a secp256k1 key pair. The address is Base58Check(0x00 ‖ HASH160(public key)).</p>
      <div data-ref="list"></div>
    </section>

    <section class="card">
      <h3>Send coins</h3>
      <form class="send-form" data-ref="form">
        <label>From <select name="from"></select></label>
        <label>To <select name="to"></select></label>
        <label data-ref="other-wrap" hidden>Address <input name="other" placeholder="1…" spellcheck="false" autocomplete="off" /></label>
        <label>Amount <input name="amount" inputmode="decimal" value="10" /></label>
        <label>Fee <input name="fee" inputmode="decimal" value="0.001" /></label>
        <button class="primary" type="submit">Send</button>
      </form>
      <p class="muted">The wallet signs whatever you ask for, even an amount you don't have, and the node checks it.
        Try sending more than a wallet owns.</p>
      <div data-ref="result" aria-live="polite"></div>
    </section>
  `;

  const ref = <T extends HTMLElement>(name: string) => root.querySelector<T>(`[data-ref="${name}"]`)!;
  const form = ref<HTMLFormElement>('form');
  const fromSel = form.elements.namedItem('from') as HTMLSelectElement;
  const toSel = form.elements.namedItem('to') as HTMLSelectElement;
  const otherWrap = ref('other-wrap');
  const result = ref('result');

  ref('new').addEventListener('click', () => app.addWallet());

  toSel.addEventListener('change', () => {
    otherWrap.hidden = toSel.value !== OTHER;
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const data = new FormData(form);
    const from = app.wallets[Number(data.get('from'))];
    const to = toSel.value === OTHER ? String(data.get('other') ?? '').trim() : app.wallets[Number(toSel.value)]?.key.address;
    const amount = parseCoins(String(data.get('amount')));
    const fee = parseCoins(String(data.get('fee')));
    if (!from || !to) return void (result.innerHTML = banner('info', 'Pick a sender and a recipient.'));
    if (amount === null || fee === null) {
      return void (result.innerHTML = banner('info', 'Enter amounts as numbers of coins, e.g. 1.5 (up to 8 decimals).'));
    }

    let tx;
    try {
      tx = buildPayment(app.chain.spendableUtxos(), from.key, to, amount, fee);
    } catch (e) {
      // Only an unencodable output (e.g. a malformed address) gets here.
      return void (result.innerHTML = banner('error', `The wallet couldn't build this transaction: ${e instanceof Error ? e.message : e}`));
    }
    const verdict = app.chain.submitTransaction(tx);
    result.innerHTML = verdict.ok
      ? banner('ok', `Accepted into the mempool (fee ${fmtCoins(verdict.fee)}). Mine a block on the Explorer tab to confirm it.`)
      : banner('error', `Rejected by the node: ${describeTxError(verdict.error)}`);
    app.emit();
  });

  function render(): void {
    const { chain, wallets } = app;
    const spendable = chain.spendableUtxos();

    ref('list').innerHTML = wallets.length
      ? `<div class="wallets-scroll"><table class="wallets">
          <thead><tr><th>Name</th><th>Address</th><th class="num">Confirmed</th><th class="num">Incl. pending</th><th>Coins (UTXOs)</th></tr></thead>
          <tbody>${wallets
            .map((w) => {
              const coins = spendable.utxosOf(w.key.address).sort((a, b) => b.output.value - a.output.value);
              return `<tr>
                <td>${esc(w.name)}</td>
                <td><code class="wrap" title="public key ${hex(w.key.publicKey)}">${esc(w.key.address)}</code></td>
                <td class="num">${fmtCoins(chain.balanceOf(w.key.address))}</td>
                <td class="num">${fmtCoins(spendable.balanceOf(w.key.address))}</td>
                <td>${coins.length ? coins.map((c) => `<span class="coin" title="${esc(outPointKey(c.outPoint))}">${fmtCoins(c.output.value)}</span>`).join(' ') : '<span class="muted">none</span>'}</td>
              </tr>`;
            })
            .join('')}</tbody>
        </table></div>`
      : '<p class="muted">No wallets yet. Create two (e.g. Alice and Bob), then mine a block to Alice on the Explorer tab.</p>';

    const keep = (sel: HTMLSelectElement, fallback: string) => {
      const prev = sel.value;
      return () => (sel.value = [...sel.options].some((o) => o.value === prev) ? prev : fallback);
    };
    const restoreFrom = keep(fromSel, '0');
    const restoreTo = keep(toSel, wallets.length > 1 ? '1' : OTHER);
    const options = wallets.map((w, i) => `<option value="${i}">${esc(w.name)} (${fmtCoins(spendable.balanceOf(w.key.address))})</option>`).join('');
    fromSel.innerHTML = options;
    toSel.innerHTML = `${wallets.map((w, i) => `<option value="${i}">${esc(w.name)} · ${esc(shortHex(w.key.address, 6, 4))}</option>`).join('')}<option value="${OTHER}">Other address…</option>`;
    restoreFrom();
    restoreTo();
    // "Other address" was only the default because there was nobody else to pay;
    // once a second wallet exists, pay it unless the user typed an address.
    const otherInput = form.elements.namedItem('other') as HTMLInputElement;
    if (toSel.value === OTHER && !otherInput.value.trim() && wallets.length > 1) {
      toSel.value = fromSel.value === '0' ? '1' : '0';
    }
    otherWrap.hidden = toSel.value !== OTHER;
  }

  app.onChange(render);
  render();
}
