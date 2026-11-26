# blockchain-attack-simulator

Interactive browser simulator for Proof-of-Work consensus and blockchain attacks (51%, double-spend, selfish mining). CSCI2730 project.

**Live demo:** https://riskypork.github.io/blockchain-attack-simulator/

> Work in progress. See the [sprint plan](docs/SPRINT_PLAN.md) for the roadmap.

## What it does
A browser-only simulation of a small Bitcoin-style PoW network. Nodes mine, broadcast blocks with network delay, and resolve forks by the most-work chain rule. You set each node's hash power and latency, launch a **51% / double-spend** or **selfish-mining** attack, and watch the chain react. Experiment mode runs many trials and compares attack success with theory (Nakamoto 2008 §11; Eyal & Sirer 2014).

## Getting started
Requires Node.js 22.12 or newer (Vitest 5 needs it; CI uses Node 24).

```bash
npm install
npm run dev        # start the dev server
npm test           # run unit tests (Vitest)
npm run build      # type-check and build to dist/
npm run preview    # serve the production build locally
```

Every push to `main` is tested, built and deployed to GitHub Pages by `.github/workflows/deploy.yml`.

## Project structure

```
src/
  core/         hashing, keys/addresses, transactions, blocks, Merkle root, UTXO set, validation
  node/         mempool, block tree (incl. stale blocks), fork choice by most cumulative work
  network/      discrete-event simulator, per-link latency, gossip, seeded RNG
  strategies/   honest miner, double-spend / 51% attacker, selfish miner
  experiments/  batch runner and theory formulas for simulated-vs-theory charts
  ui/           app shell and panels (explorer, wallets, network, chain tree, attacks, experiments)
docs/
  SPRINT_PLAN.md
```

Tests sit next to the code they cover (`*.test.ts`).

## Tech
Vite + TypeScript (no backend) · [@noble/hashes](https://github.com/paulmillr/noble-hashes) (SHA-256, RIPEMD-160) · [@noble/secp256k1](https://github.com/paulmillr/noble-secp256k1) (ECDSA) · Vitest

## License
MIT
