/**
 * Error bars for simulated results, so a chart can show whether a gap between
 * simulation and theory is bigger than chance alone would explain.
 */

/** z for a two-sided 95% interval. */
export const Z95 = 1.959964;

export interface Interval {
  /** The point estimate. */
  value: number;
  low: number;
  high: number;
}

/**
 * 95% Wilson score interval for a success rate of `successes` out of `n`.
 * Unlike the textbook p ± z·√(p(1 − p)/n), it stays inside [0, 1] and
 * doesn't shrink to nothing at 0 or n successes, which matters here: a
 * double spend at small q usually succeeds 0 times out of 100.
 */
export function wilsonInterval(successes: number, n: number, z = Z95): Interval {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('n must be an integer >= 0');
  if (!Number.isInteger(successes) || successes < 0 || successes > n) throw new RangeError('successes must be an integer in [0, n]');
  if (n === 0) return { value: 0, low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { value: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/**
 * Mean of `xs` with a 95% interval of ± z·s/√n, where s is the sample
 * standard deviation. With one value there is no spread to go on, so the
 * interval is just the value.
 */
export function meanInterval(xs: readonly number[], z = Z95): Interval {
  const n = xs.length;
  if (n === 0) return { value: NaN, low: NaN, high: NaN };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  if (n === 1) return { value: mean, low: mean, high: mean };
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const half = (z * Math.sqrt(variance)) / Math.sqrt(n);
  return { value: mean, low: mean - half, high: mean + half };
}
