/** Small display helpers shared by the panels. No simulation logic. */
import { COIN, bytesToHex } from '../core';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text before putting it into innerHTML. */
export function esc(text: unknown): string {
  return String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** 150000000 → "1.5". */
export function fmtCoins(units: number): string {
  const whole = Math.trunc(units / COIN);
  const frac = Math.abs(units % COIN);
  return frac === 0 ? String(whole) : `${units < 0 && whole === 0 ? '-' : ''}${whole}.${String(frac).padStart(8, '0').replace(/0+$/, '')}`;
}

/** "1.5" → 150000000, or null if the text is not a non-negative amount with at most 8 decimals. */
export function parseCoins(text: string): number | null {
  const m = /^\s*(\d+)(?:\.(\d{0,8}))?\s*$/.exec(text);
  if (!m) return null;
  const units = Number(m[1]) * COIN + Number((m[2] ?? '').padEnd(8, '0'));
  return Number.isSafeInteger(units) ? units : null;
}

export function hex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

/** First and last few hex digits: "00a3f1…9c2e". */
export function shortHex(h: string, head = 8, tail = 4): string {
  return h.length <= head + tail + 1 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;
}

/** Hash with its leading zero hex digits highlighted (they are what PoW "buys"). */
export function hashHtml(h: string): string {
  const zeros = /^0*/.exec(h)![0].length;
  return `<span class="hash-zeros">${h.slice(0, zeros)}</span>${h.slice(zeros)}`;
}

/** For a target of the form 2^(256-b) - 1, returns b. */
export function leadingZeroBits(target: bigint): number {
  return 256 - target.toString(2).length;
}

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

export function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Simulated seconds as "42.0 s", "12m 05s" or "1h 02m 03s". */
export function fmtSimTime(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const t = Math.floor(seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m ${s}s` : `${m}m ${s}s`;
}

/**
 * A colour for a block, taken from the end of its hash (the start is mostly
 * zeros under real PoW). The network graph paints each node with its tip's
 * colour, so nodes that agree share a colour and a fork shows up as two.
 */
export function blockColor(hash: string): string {
  return `hsl(${parseInt(hash.slice(-4), 16) % 360} 70% 50%)`;
}

/** A coloured result box. `text` is escaped. */
export function banner(kind: 'ok' | 'error' | 'info', text: string): string {
  return `<div class="banner ${kind}">${esc(text)}</div>`;
}
