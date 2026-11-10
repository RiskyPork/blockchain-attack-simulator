/**
 * UI-side application state: the node, the user's wallets and display-only
 * extras (mining stats). Panels read it and re-render when it changes.
 * The multi-node network has its own state and change events (playground.ts),
 * since it changes every animation frame while it runs.
 */
import { type Address, type KeyPair, generateKeyPair, targetFromLeadingZeroBits } from '../core';
import { Chain } from '../node';
import { Playground } from './playground';

export interface NamedWallet {
  name: string;
  key: KeyPair;
}

/** How a block was mined, shown in the explorer. Not part of the block itself. */
export interface MiningStats {
  attempts: number;
  ms: number;
}

const NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy'];
export const DEFAULT_DIFFICULTY_BITS = 16;

export class App {
  readonly chain = new Chain({ target: targetFromLeadingZeroBits(DEFAULT_DIFFICULTY_BITS) });
  readonly wallets: NamedWallet[] = [];
  /** Keyed by block hash hex. */
  readonly miningStats = new Map<string, MiningStats>();
  /** The live multi-node network shown on the Network and Chain tree tabs. */
  readonly playground = new Playground();
  private readonly listeners = new Set<() => void>();

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }

  addWallet(): NamedWallet {
    const n = this.wallets.length;
    const name = n < NAMES.length ? NAMES[n] : `Wallet ${n + 1}`;
    const wallet = { name, key: generateKeyPair() };
    this.wallets.push(wallet);
    this.emit();
    return wallet;
  }

  walletByAddress(address: Address): NamedWallet | undefined {
    return this.wallets.find((w) => w.key.address === address);
  }

  /** "Alice" for a known wallet, otherwise the address itself. */
  label(address: Address): string {
    return this.walletByAddress(address)?.name ?? address;
  }
}
