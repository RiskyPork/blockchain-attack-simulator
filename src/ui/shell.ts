/**
 * ui/: the app shell. Each tab maps to one feature area; panels are filled in
 * sprint by sprint (see docs/SPRINT_PLAN.md). UI code only reads simulator
 * state and dispatches user actions; it holds no consensus logic.
 */
import { bytesToHex, sha256d, utf8ToBytes } from '../core';

interface Tab {
  id: string;
  label: string;
  sprint: number;
  blurb: string;
}

const TABS: Tab[] = [
  { id: 'explorer', label: 'Explorer', sprint: 1, blurb: 'Blocks, transactions, Merkle roots and real SHA-256 proof-of-work.' },
  { id: 'wallets', label: 'Wallets', sprint: 1, blurb: 'secp256k1 key pairs, Base58Check addresses, signed transactions.' },
  { id: 'network', label: 'Network', sprint: 2, blurb: 'Nodes, hash power, link latency and block propagation.' },
  { id: 'chain', label: 'Chain tree', sprint: 2, blurb: 'Every block including stale forks; the most-work chain is highlighted.' },
  { id: 'attacks', label: 'Attacks', sprint: 3, blurb: '51% / double-spend and selfish mining, live.' },
  { id: 'experiments', label: 'Experiments', sprint: 4, blurb: 'Batch trials: simulated success rate vs. theory.' },
];

export function mountShell(root: HTMLElement): void {
  // Proves the crypto library works in the browser bundle.
  const genesisDemo = bytesToHex(sha256d(utf8ToBytes('genesis')));

  root.innerHTML = `
    <header class="topbar">
      <h1>Blockchain Attack Simulator</h1>
      <p class="subtitle">Proof-of-Work consensus and attacks, in your browser.</p>
    </header>
    <nav class="tabs" role="tablist">
      ${TABS.map(
        (t, i) =>
          `<button role="tab" data-tab="${t.id}" aria-selected="${i === 0}">${t.label}</button>`,
      ).join('')}
    </nav>
    <main id="panel" class="panel" role="tabpanel"></main>
    <footer class="footer">
      sha256d("genesis") = <code>${genesisDemo.slice(0, 16)}…</code>
    </footer>
  `;

  const panel = root.querySelector<HTMLElement>('#panel')!;
  const buttons = root.querySelectorAll<HTMLButtonElement>('[data-tab]');

  const show = (id: string): void => {
    const tab = TABS.find((t) => t.id === id) ?? TABS[0];
    buttons.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab.id)));
    panel.innerHTML = `
      <h2>${tab.label}</h2>
      <p>${tab.blurb}</p>
      <p class="todo">Planned for Sprint ${tab.sprint}.</p>
    `;
  };

  buttons.forEach((b) => b.addEventListener('click', () => show(b.dataset.tab!)));
  show(TABS[0].id);
}
