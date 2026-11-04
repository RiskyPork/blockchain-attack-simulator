import { describe, expect, it } from 'vitest';
import { Rng } from './rng';

describe('Rng', () => {
  it('is reproducible for the same seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('differs for different seeds', () => {
    expect(new Rng(1).next()).not.toBe(new Rng(2).next());
  });

  it('stays within [0, 1) and int() within bounds', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 10_000; i++) {
      const x = rng.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      const n = rng.int(3, 5);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(5);
    }
  });

  it('exponential() has mean close to 1/rate', () => {
    const rng = new Rng(123);
    const rate = 0.5;
    const n = 50_000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += rng.exponential(rate);
    expect(sum / n).toBeCloseTo(1 / rate, 1);
  });
});
