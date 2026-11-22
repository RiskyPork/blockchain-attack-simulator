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
 * Expected share of main-chain blocks earned by a selfish miner with hash
 * share α, when a fraction γ of honest miners mine on its block during a tie
 * (Eyal & Sirer 2014, equation 8):
 *
 *   R = [α(1 − α)²(4α + γ(1 − 2α)) − α³] / [1 − α(1 + (2 − α)α)]
 *
 * Honest mining earns α. Selfish mining earns more once α passes
 * selfishThreshold(γ).
 */
export function selfishRevenue(alpha: number, gamma: number): number {
  checkShare(alpha, 'alpha');
  checkShare(gamma, 'gamma');
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
