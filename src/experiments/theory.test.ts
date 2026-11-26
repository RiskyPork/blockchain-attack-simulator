import { describe, expect, it } from 'vitest';
import { Rng } from '../network/rng';
import { catchUpProbability, doubleSpendSuccess, nakamotoSuccess, selfishRevenue, selfishThreshold } from './theory';

describe('catchUpProbability (Nakamoto 2008, section 11)', () => {
  it('is (q/p)^z for a minority attacker', () => {
    expect(catchUpProbability(0.1, 0)).toBe(1);
    expect(catchUpProbability(0.1, 1)).toBeCloseTo(1 / 9, 12);
    expect(catchUpProbability(0.3, 6)).toBeCloseTo((3 / 7) ** 6, 12);
  });

  it('is 1 once the attacker has half the hash power or more: success is certain in the end', () => {
    for (const z of [0, 1, 6, 100]) {
      expect(catchUpProbability(0.5, z)).toBe(1);
      expect(catchUpProbability(0.55, z)).toBe(1);
    }
  });

  it('checks its inputs', () => {
    expect(() => catchUpProbability(1.1, 1)).toThrow(RangeError);
    expect(() => catchUpProbability(0.2, -1)).toThrow(RangeError);
    expect(() => catchUpProbability(0.2, 1.5)).toThrow(RangeError);
  });
});

describe('nakamotoSuccess (Nakamoto 2008, section 11)', () => {
  // The whitepaper's own tables, to its 7 decimal places.
  it.each([
    [0, 1.0], [1, 0.2045873], [2, 0.0509779], [3, 0.0131722], [4, 0.0034552], [5, 0.0009137],
    [6, 0.0002428], [7, 0.0000647], [8, 0.0000173], [9, 0.0000046], [10, 0.0000012],
  ])('q = 0.1, z = %i → %f', (z, expected) => {
    expect(nakamotoSuccess(0.1, z)).toBeCloseTo(expected, 7);
  });

  it.each([
    [0, 1.0], [5, 0.1773523], [10, 0.0416605], [15, 0.0101008], [20, 0.0024804], [25, 0.0006132],
    [30, 0.0001522], [35, 0.0000379], [40, 0.0000095], [45, 0.0000024], [50, 0.0000006],
  ])('q = 0.3, z = %i → %f', (z, expected) => {
    expect(nakamotoSuccess(0.3, z)).toBeCloseTo(expected, 7);
  });

  // "Solving for P less than 0.1%": the smallest z that gets there.
  it.each([
    [0.1, 5], [0.15, 8], [0.2, 11], [0.25, 15], [0.3, 24], [0.35, 41], [0.4, 89], [0.45, 340],
  ])('q = %f needs z = %i for P < 0.1%%', (q, z) => {
    expect(nakamotoSuccess(q, z)).toBeLessThan(0.001);
    expect(nakamotoSuccess(q, z - 1)).toBeGreaterThanOrEqual(0.001);
  });

  it('is 1 with half the hash power or more, and 0 with none', () => {
    expect(nakamotoSuccess(0.5, 6)).toBe(1);
    expect(nakamotoSuccess(0.7, 6)).toBe(1);
    expect(nakamotoSuccess(0, 6)).toBe(0);
  });
});

describe('doubleSpendSuccess (this simulator\'s attacker, no latency)', () => {
  /** The never-give-up case summed directly: the attacker has m blocks when the honest side finds its k-th. */
  function closedForm(q: number, k: number): number {
    const p = 1 - q;
    let fail = 0;
    let ways = 1; // C(m + k − 1, m)
    for (let m = 0; m <= k; m++) {
      if (m > 0) ways = (ways * (m + k - 1)) / m;
      fail += ways * p ** k * q ** m * (1 - (q / p) ** (k - m + 1));
    }
    return 1 - fail;
  }

  /** The race played out block by block, as strategies/double-spend.ts does it. */
  function monteCarlo(q: number, k: number, maxDeficit: number, trials: number): number {
    const rng = new Rng(7);
    let wins = 0;
    for (let t = 0; t < trials; t++) {
      let honest = 0;
      let attacker = 0;
      for (;;) {
        if (rng.next() < q) {
          attacker++;
          if (honest >= k && attacker > honest) break;
        } else {
          honest++;
          if (honest >= k && attacker > honest) break;
          if (honest - attacker >= maxDeficit) {
            wins--;
            break;
          }
        }
      }
      wins++;
    }
    return wins / trials;
  }

  it('matches the closed form when the attacker never gives up', () => {
    for (const q of [0.05, 0.1, 0.25, 0.4, 0.45]) {
      for (const k of [1, 2, 3, 6, 10]) expect(doubleSpendSuccess(q, k)).toBeCloseTo(closedForm(q, k), 12);
    }
  });

  it('matches a block-by-block simulation of the race, with a give-up point', () => {
    for (const [q, k, d] of [[0.3, 2, 5], [0.45, 4, 8], [0.6, 6, 3], [0.2, 3, 2]]) {
      expect(Math.abs(doubleSpendSuccess(q, k, d) - monteCarlo(q, k, d, 40_000))).toBeLessThan(0.01);
    }
  });

  it('needs strictly more blocks, so it is lower than Nakamoto\'s figure', () => {
    for (const q of [0.1, 0.2, 0.3, 0.4]) {
      for (const z of [1, 3, 6]) expect(doubleSpendSuccess(q, z)).toBeLessThan(nakamotoSuccess(q, z));
    }
  });

  it('is certain with a majority that never gives up, and not certain with one that does', () => {
    expect(doubleSpendSuccess(0.5, 6)).toBe(1);
    expect(doubleSpendSuccess(0.55, 6)).toBe(1);
    const patient = doubleSpendSuccess(0.55, 6, 50);
    const impatient = doubleSpendSuccess(0.55, 6, 3);
    expect(patient).toBeGreaterThan(0.99);
    expect(impatient).toBeLessThan(patient);
    expect(doubleSpendSuccess(0, 1)).toBe(0);
  });

  it('checks its inputs', () => {
    expect(() => doubleSpendSuccess(0.2, 0)).toThrow(RangeError);
    expect(() => doubleSpendSuccess(0.2, 1, 0)).toThrow(RangeError);
    expect(() => doubleSpendSuccess(-0.1, 1)).toThrow(RangeError);
  });
});

describe('selfish mining (Eyal & Sirer 2014)', () => {
  it('threshold is 1/3 at γ = 0 and 1/4 at γ = 1/2', () => {
    expect(selfishThreshold(0)).toBeCloseTo(1 / 3, 12);
    expect(selfishThreshold(0.5)).toBeCloseTo(1 / 4, 12);
    expect(selfishThreshold(1)).toBe(0);
  });

  it('revenue equals the fair share α exactly at the threshold', () => {
    for (const gamma of [0, 0.25, 0.5, 0.75]) {
      const t = selfishThreshold(gamma);
      expect(selfishRevenue(t, gamma)).toBeCloseTo(t, 12);
      expect(selfishRevenue(t + 0.05, gamma)).toBeGreaterThan(t + 0.05);
      expect(selfishRevenue(t - 0.05, gamma)).toBeLessThan(t - 0.05);
    }
  });

  it('matches values worked out from the formula', () => {
    expect(selfishRevenue(0.4, 0)).toBeCloseTo(0.1664 / 0.344, 10);
    expect(selfishRevenue(0.4, 0.5)).toBeCloseTo(0.1808 / 0.344, 10);
    expect(selfishRevenue(0, 0)).toBe(0);
  });

  it('is a share: it rises from 0 to 1 as α goes from 0 to 1/2, for every γ', () => {
    for (const gamma of [0, 0.25, 0.5, 0.75, 1]) {
      let prev = 0;
      for (let i = 0; i <= 100; i++) {
        const r = selfishRevenue(i / 200, gamma);
        expect(r).toBeGreaterThanOrEqual(prev - 1e-12);
        expect(r).toBeLessThanOrEqual(1);
        prev = r;
      }
      expect(selfishRevenue(0.4999, gamma)).toBeCloseTo(1, 2);
    }
  });

  it('is 1 for a majority, where the formula no longer applies (it would give 691% at α = 0.55, then negative values)', () => {
    for (const alpha of [0.5, 0.52, 0.55, 0.56, 0.6, 0.75, 0.95, 1]) {
      expect(selfishRevenue(alpha, 0)).toBe(1);
      expect(selfishRevenue(alpha, 0.5)).toBe(1);
    }
  });
});
