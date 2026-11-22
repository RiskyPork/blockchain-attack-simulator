import { describe, expect, it } from 'vitest';
import { catchUpProbability, selfishRevenue, selfishThreshold } from './theory';

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
});
