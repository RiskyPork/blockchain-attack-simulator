/**
 * experiments/: attack metrics (revenue share, stale rate, reorg depths), theory formulas (Nakamoto whitepaper
 * section 11, Eyal & Sirer 2014), the attack scenario shared with the live tab, and the batch runner whose
 * simulated-vs-theory results the Experiments tab charts.
 */
export * from './metrics';
export * from './theory';
export * from './scenario';
export * from './batch';
export * from './stats';
export * from './export';
