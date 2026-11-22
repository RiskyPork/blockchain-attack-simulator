/**
 * strategies/: miner behaviours that plug into the mining engine (network/mining.ts): honest miner,
 * 51% / double-spend attacker (private chain released after k confirmations) and selfish miner (Eyal & Sirer 2014).
 */
export * from './honest';
export * from './double-spend';
export * from './selfish';
