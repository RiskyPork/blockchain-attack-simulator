/**
 * ui/: the app shell. Each tab maps to one feature area; panels are filled in
 * as features land. UI code only reads simulator
 * state and dispatches user actions; it holds no consensus logic.
 */
import { mountAttacks } from './attacks';
import { mountChainTree } from './chaintree';
import { mountExplorer } from './explorer';
import { mountNetwork } from './network';
import { App } from './state';
import { mountWallets } from './wallets';

interface Tab {
  id: string;
  label: string;
  sprint: number;
  blurb: string;
  mount?: (root: HTMLElement, app: App) => void;
}

const TABS: Tab[] = [
  { id: 'wallets', label: 'Wallets', sprint: 1, blurb: 'secp256k1 key pairs, Base58Check addresses, signed transactions.', mount: mountWallets },
  { id: 'explorer', label: 'Explorer', sprint: 1, blurb: 'Blocks, transactions, Merkle roots and real SHA-256 proof-of-work.', mount: mountExplorer },
  { id: 'network', label: 'Network', sprint: 2, blurb: 'Nodes, hash power, link latency and block propagation.', mount: mountNetwork },
  { id: 'chain', label: 'Chain tree', sprint: 2, blurb: 'Every block including stale forks; the most-work chain is highlighted.', mount: mountChainTree },
  { id: 'attacks', label: 'Attacks', sprint: 3, blurb: '51% / double-spend and selfish mining, live.', mount: mountAttacks },
  { id: 'experiments', label: 'Experiments', sprint: 4, blurb: 'Batch trials: simulated success rate vs. theory.' },
];

export function mountShell(root: HTMLElement): void {
  const app = new App();

  root.innerHTML = `
    <header class="topbar">
      <h1>Blockchain Attack Simulator</h1>
      <p class="subtitle">Proof-of-Work consensus and attacks, in your browser.</p>
    </header>
    <nav class="tabs" role="tablist">
      ${TABS.map((t, i) => `<button role="tab" id="tab-${t.id}" aria-controls="panel-${t.id}" data-tab="${t.id}" aria-selected="${i === 0}">${t.label}</button>`).join('')}
    </nav>
    ${TABS.map((t, i) => `<main id="panel-${t.id}" class="panel" role="tabpanel" aria-labelledby="tab-${t.id}" ${i === 0 ? '' : 'hidden'}></main>`).join('')}
  `;

  // Every panel is mounted once and kept in the DOM, so state (e.g. a running
  // mining job or a half-filled form) survives switching tabs.
  for (const tab of TABS) {
    const panel = root.querySelector<HTMLElement>(`#panel-${tab.id}`)!;
    if (tab.mount) tab.mount(panel, app);
    else panel.innerHTML = `<h2>${tab.label}</h2><p>${tab.blurb}</p><p class="todo">Planned for Sprint ${tab.sprint}.</p>`;
  }

  const buttons = root.querySelectorAll<HTMLButtonElement>('[data-tab]');
  const show = (id: string): void => {
    buttons.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
    root.querySelectorAll<HTMLElement>('[role="tabpanel"]').forEach((p) => {
      const wasHidden = p.hidden;
      p.hidden = p.id !== `panel-${id}`;
      // Panels that skip drawing while hidden catch up on this event.
      if (wasHidden && !p.hidden) p.dispatchEvent(new Event('show'));
    });
  };
  buttons.forEach((b) => b.addEventListener('click', () => show(b.dataset.tab!)));
}
