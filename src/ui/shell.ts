/**
 * ui/: the app shell. Each tab maps to one feature area and mounts its panel.
 * UI code only reads simulator state and dispatches user actions; it holds no
 * consensus logic.
 */
import { mountAttacks } from './attacks';
import { mountChainTree } from './chaintree';
import { mountExperiments } from './experiments';
import { mountExplorer } from './explorer';
import { mountNetwork } from './network';
import { App } from './state';
import { mountWallets } from './wallets';

interface Tab {
  id: string;
  label: string;
  mount: (root: HTMLElement, app: App) => void;
}

const TABS: Tab[] = [
  { id: 'wallets', label: 'Wallets', mount: mountWallets },
  { id: 'explorer', label: 'Explorer', mount: mountExplorer },
  { id: 'network', label: 'Network', mount: mountNetwork },
  { id: 'chain', label: 'Chain tree', mount: mountChainTree },
  { id: 'attacks', label: 'Attacks', mount: mountAttacks },
  { id: 'experiments', label: 'Experiments', mount: mountExperiments },
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
    tab.mount(panel, app);
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
