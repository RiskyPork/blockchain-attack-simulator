/**
 * Seeded pseudo-random number generator.
 *
 * Every random choice in the simulation (who finds the next block, link
 * jitter, ...) goes through one of these so that a run can be replayed exactly
 * from its seed. Math.random() must not be used inside the simulation.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Force to an unsigned 32-bit integer.
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). Algorithm: mulberry32 (small, fast, good enough for simulation). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /**
   * Exponentially distributed waiting time with the given rate.
   * Block discovery is a Poisson process, so the time until a miner with
   * hash share p finds a block is Exp(p / blockInterval). Used by "Fast" mode.
   */
  exponential(rate: number): number {
    if (rate <= 0) throw new RangeError('rate must be positive');
    // 1 - next() is in (0, 1], so the log is finite.
    return -Math.log(1 - this.next()) / rate;
  }
}
