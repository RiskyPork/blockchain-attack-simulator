/**
 * Closed-form results from the papers, for the simulation to be checked
 * against.
 */

/**
 * Chance that an attacker with share q of the hash power ever catches up
 * from z blocks behind (Nakamoto 2008, section 11, the gambler's ruin):
 *
 *   q_z = 1            if q ≥ p
 *   q_z = (q / p)^z    if q < p,   where p = 1 − q
 *
 * Each block moves the gap one step, towards the attacker with probability
 * q. With q < p the walk drifts away from the attacker and the chance of ever
 * closing a gap of z falls off exponentially in z. With q ≥ p it drifts the
 * attacker's way, so it catches up in the end with certainty: the chain is
 * only immutable while nobody controls more than half of the hash power.
 */
export function catchUpProbability(q: number, z: number): number {
  checkShare(q, 'q');
  if (!Number.isInteger(z) || z < 0) throw new RangeError('z must be an integer >= 0');
  const p = 1 - q;
  return q >= p ? 1 : (q / p) ** z;
}

/**
 * Chance that a double spend succeeds against a merchant who waits for z
 * confirmations (Nakamoto 2008, section 11):
 *
 *   P = 1 − Σₖ₌₀ᶻ (λᵏ e^(−λ) / k!) (1 − (q/p)^(z−k)),   λ = z·q/p
 *
 * While the honest network mines its z blocks, the attacker mines in secret.
 * Nakamoto takes the honest blocks to arrive at their average pace, so the
 * attacker's progress k in that time is Poisson with mean λ = z·q/p. From
 * z − k behind it then catches up with probability (q/p)^(z−k)
 * (catchUpProbability), and from k ≥ z it is already level. The sum is the
 * chance it does NOT catch up, over the k ≤ z for which that is possible.
 *
 * Nakamoto counts the attacker as successful once it draws level. With q ≥ p
 * that happens in the end with certainty, so P = 1.
 */
export function nakamotoSuccess(q: number, z: number): number {
  checkShare(q, 'q');
  if (!Number.isInteger(z) || z < 0) throw new RangeError('z must be an integer >= 0');
  const p = 1 - q;
  if (q >= p) return 1;
  const lambda = (z * q) / p;
  let poisson = Math.exp(-lambda); // P(k = 0)
  let sum = 0;
  for (let k = 0; k <= z; k++) {
    if (k > 0) poisson *= lambda / k;
    sum += poisson * (1 - (q / p) ** (z - k));
  }
  return Math.min(1, Math.max(0, 1 - sum));
}

/**
 * Exact chance of success for this simulator's double-spend attacker
 * (strategies/double-spend.ts), on a network without latency, so each block
 * is the attacker's with probability q and the honest network's otherwise.
 * It differs from nakamotoSuccess in three ways, each true to the code:
 *
 *   - It needs strictly more blocks than the public chain, not a tie: on a
 *     tie, nodes keep the branch they saw first, which is the public one.
 *   - The merchant's k confirmations count the block holding the payment, so
 *     the attacker's head count when the honest side reaches k is negative
 *     binomial (it mines from the same moment), not Poisson.
 *   - It gives up once the public chain is `maxDeficit` blocks ahead. Pass
 *     Infinity for an attacker that never gives up.
 *
 * Phase 1, until the honest side has found its k blocks: track the chance of
 * each attacker count a (0 to k) at each honest block, dropping paths where
 * the attacker gives up. Between two honest blocks the attacker finds j more
 * with probability q^j·p. Once it has k + 1 it is sure to win: it is ahead
 * the moment the merchant ships.
 * Phase 2, from a gap g = honest − attacker blocks: a gambler's ruin. The
 * attacker wins on reaching g = −1 before g = maxDeficit. From x = g + 1
 * steps away that chance is ((q/p)^x − (q/p)^N) / (1 − (q/p)^N), with
 * N = maxDeficit + 1, and tends to (q/p)^x as N grows (catchUpProbability).
 */
export function doubleSpendSuccess(q: number, k: number, maxDeficit = Infinity): number {
  checkShare(q, 'q');
  if (!Number.isInteger(k) || k < 1) throw new RangeError('k must be an integer >= 1');
  if (maxDeficit !== Infinity && (!Number.isInteger(maxDeficit) || maxDeficit < 1)) {
    throw new RangeError('maxDeficit must be an integer >= 1, or Infinity');
  }
  if (q === 0) return 0;
  const p = 1 - q;
  if (p === 0) return 1;

  const r = q / p;
  const N = maxDeficit + 1;
  /** Chance the attacker gets strictly ahead from gap g before giving up. */
  const ruin = (g: number): number => {
    const x = g + 1;
    if (x <= 0) return 1;
    if (x >= N) return 0;
    if (N === Infinity) return r >= 1 ? 1 : r ** x;
    if (r === 1) return 1 - x / N;
    return (r ** x - r ** N) / (1 - r ** N);
  };

  // Phase 1. ways[a] = chance the attacker has a blocks at the latest honest
  // block and is still racing.
  let success = 0;
  let ways = [1, ...new Array<number>(k).fill(0)];
  for (let h = 1; h <= k; h++) {
    const next = new Array<number>(k + 1).fill(0);
    // carry = chance of reaching attacker count a before honest block h.
    let carry = 0;
    for (let a = 0; a <= k; a++) {
      carry = carry * q + ways[a];
      // Honest block h arrives now. The attacker gives up h − a ≥ maxDeficit behind.
      if (h - a < maxDeficit) next[a] = carry * p;
    }
    // Paths that reach k + 1 attacker blocks first: already won.
    success += carry * q;
    ways = next;
  }
  // The honest side has just found block k, and the merchant ships.
  for (let a = 0; a <= k; a++) success += ways[a] * ruin(k - a);
  return Math.min(1, Math.max(0, success));
}

/**
 * Expected share of main-chain blocks earned by a selfish miner with hash
 * share α, when a fraction γ of honest miners mine on its block during a tie
 * (Eyal & Sirer 2014, equation 8):
 *
 *   R = [α(1 − α)²(4α + γ(1 − 2α)) − α³] / [1 − α(1 + (2 − α)α)]
 *
 * Honest mining earns α. Selfish mining earns more once α passes
 * selfishThreshold(γ).
 *
 * The formula holds for a minority, α < 1/2: it comes from the long-run
 * distribution of the private lead, which only exists while the lead keeps
 * falling back to 0. With α ≥ 1/2 the lead drifts upwards instead, so from
 * some point on the private branch is never caught and every block is the
 * selfish miner's: the share tends to 1. Past 1/2 the expression itself
 * stops meaning anything (its denominator reaches 0 near α = 0.555 and
 * then turns negative), so a majority gets 1. At α = 1/2 the formula also
 * gives exactly 1, so the two pieces meet.
 */
export function selfishRevenue(alpha: number, gamma: number): number {
  checkShare(alpha, 'alpha');
  checkShare(gamma, 'gamma');
  if (alpha >= 0.5) return 1;
  const a = alpha;
  return (a * (1 - a) ** 2 * (4 * a + gamma * (1 - 2 * a)) - a ** 3) / (1 - a * (1 + (2 - a) * a));
}

/**
 * Smallest hash share at which selfish mining beats honest mining
 * (Eyal & Sirer 2014): (1 − γ) / (3 − 2γ). 1/3 with γ = 0, 1/4 with γ = 1/2,
 * and 0 with γ = 1.
 */
export function selfishThreshold(gamma: number): number {
  checkShare(gamma, 'gamma');
  return (1 - gamma) / (3 - 2 * gamma);
}

function checkShare(x: number, name: string): void {
  if (!(x >= 0 && x <= 1)) throw new RangeError(`${name} must be in [0, 1]`);
}
