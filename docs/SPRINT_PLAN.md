# Sprint plan: Blockchain Attack Simulator

Solo project for CSCI2730. **Hard deadline: Sat 5 Dec 2026** (10% off per day late).
**Internal target: submit Fri 4 Dec**, which leaves one day of slack.

## How this plan works (Scrum, adapted for one person)

| Practice | Solo version |
|---|---|
| Product backlog | GitHub Issues, one per story below (`S<sprint>-<n>` in the title), labels `core` / `node` / `network` / `strategies` / `experiments` / `ui` / `docs` |
| Sprint board | GitHub Projects board: *Todo → In progress → Done* |
| Sprint length | 1 week (Fri → Thu), with shorter final sprints |
| Daily stand-up | 3 lines in the sprint's tracking issue: done / next / blocked |
| Sprint review | Run the live GitHub Pages build. |
| Retro | 3 bullets at the end of the tracking issue: keep / change / cut |
| Estimates | Story points (1, 2, 3, 5, 8), relative effort only |

### Definition of Done (every story)
- [ ] Code sits in the right module (`core/`, `node/`, `network/`, `strategies/`, `experiments/`, `ui/`), and the UI holds no consensus logic
- [ ] Unit tests cover the logic; `npm test` and `npm run build` pass
- [ ] Non-obvious logic is commented, with lecture references
- [ ] Merged to `main`, CI is green and the Pages site still works (main stays deployable)
- [ ] I can explain it out loud in under a minute (the video test)

### Priority / cut line
The brief's priority order decides what gets cut. If a sprint runs over, drop from the **bottom** of this list and never from the top:

1. Core chain + real PoW + validation + explorer UI → Sprint 1
2. Multi-node network, latency, forks, longest-chain rule → Sprint 2
3. 51% / double-spend attack → Sprint 3
4. Selfish mining → Sprint 3
5. Experiment mode with theory charts → Sprint 4
6. *Stretch:* difficulty-adjustment UI, PoS comparison → only if Sprint 4 finishes early

---

## Sprint 0: Setup (Wed 4 – Thu 5 Nov)
**Goal:** an empty but deployable app, with tests running in CI.

| ID | Story | Pts | Status |
|---|---|---|---|
| S0-1 | Vite + TypeScript scaffold, module folders per architecture | 2 | done |
| S0-2 | Vitest set up; `core/hash` (sha256, sha256d, hash160) and `network/rng` (seeded mulberry32 + exponential) with tests | 2 | done |
| S0-3 | GitHub Actions: test → build → deploy to Pages | 1 | written; turn on Pages in repo settings (Source: *GitHub Actions*) and check the live link |
| S0-4 | Create GitHub Issues + Project board from this plan | 1 | done |

---

## Sprint 1: Core chain (Fri 6 – Thu 12 Nov), 29 pts
**Goal:** one node can create keys, sign transactions, mine a genuinely valid block with real SHA-256 PoW, and show everything in an explorer.

| ID | Story | Pts | Acceptance criteria |
|---|---|---|---|
| S1-1 | **Keys & addresses** | 3 | secp256k1 keygen (wire `secp.hashes` to noble for sync signing); address = Base58Check(version ‖ HASH160(pubkey)); test against the Bitcoin wiki vector (compressed pubkey `0250863a…2352` → `1PMycacnJaSqwwJqjawXBErnLsZ7RkXUAs`) |
| S1-2 | **Transactions (UTXO model)** | 5 | Inputs reference `(txid, index)`; outputs `(value, address)`; txid = sha256d(serialized tx); each input is signed over the tx digest; coinbase tx type |
| S1-3 | **Merkle root** | 2 | Pairwise sha256d, last hash duplicated on odd levels; tested for 1, 2, 3 and 4 txs |
| S1-4 | **Block header & hash** | 3 | Header = prevHash, merkleRoot, timestamp, nonce, target (Lec05); deterministic serialization; block hash = sha256d(header) |
| S1-5 | **Real PoW miner** | 3 | Nonce loop until `hash ≤ target`; difficulty set as leading zero bits; mining runs in chunks so the UI never freezes; coinbase reward = subsidy + fees |
| S1-6 | **Validation rules** | 5 | Tx: inputs exist and are unspent, Σout ≤ Σin, signatures valid, no double use of an input inside a block. Block: known prev, Merkle root matches, PoW meets target, exactly one coinbase, coinbase ≤ subsidy + fees. Each rule has a failing-case test. |
| S1-7 | **UTXO set with apply / undo** | 3 | `applyBlock` / `undoBlock` are exact inverses (property test). Sprint 2 reorgs depend on this. |
| S1-8 | **Explorer + wallet UI** | 5 | Wallets tab: generate wallets, see balances, send a tx. Explorer tab: mine a block (shows nonce attempts and time), click a block to see header, txs and Merkle root, with an invalid-tx demo showing the rejection reason |

**Sprint review clip:** create two wallets → send coins → mine → inspect the block → attempt an overspend and watch it get rejected.

---

## Sprint 2: Network & forks (Fri 13 – Thu 19 Nov), 30 pts
**Goal:** several nodes mine and gossip blocks with delay, so forks happen naturally and resolve by most cumulative work.

| ID | Story | Pts | Acceptance criteria |
|---|---|---|---|
| S2-1 | **Discrete-event engine** | 3 | Priority queue of timestamped events on a simulated clock; same seed gives an identical event log (test) |
| S2-2 | **Block tree** | 5 | Each node stores ALL blocks, including stale ones; orphan pool for blocks whose parent is unknown, connected when the parent arrives (Lec05 orphan vs stale definitions) |
| S2-3 | **Fork choice + reorg** | 5 | Tip = most cumulative work (not just height); reorg = undo to the common ancestor, then apply the new branch; txs from dropped blocks go back to the mempool; confirmation counts |
| S2-4 | **Network & propagation** | 3 | Nodes + links with per-link latency (+ seeded jitter); flooding gossip that never re-sends a known block |
| S2-5 | **Fast mining mode** | 2 | Next block time ~ Exp(total rate); winner chosen with probability equal to hash share; blocks marked "simulated PoW". Real PoW stays available as a toggle. |
| S2-6 | **Honest miner** | 2 | Follows the Lec05 mining steps: sync → validate txs → validate blocks → create block → PoW → collect reward |
| S2-7 | **Network panel UI** | 5 | Add/remove nodes; sliders for hash power % and latency; play / pause / step / speed; seed field; blocks animate along the links |
| S2-8 | **Chain tree view** | 5 | D3 tree of every block; main chain highlighted, stale branches greyed out; per-node "my tip" markers; "final after 6 confirmations" badge |

**Sprint review clip:** raise latency until forks appear, then show the fork resolving and the stale block left behind.

---

## Sprint 3: Attacks (Fri 20 – Thu 26 Nov), 22 pts
**Goal:** the user launches a double-spend / 51% attack or selfish mining and watches it succeed or fail live.

| ID | Story | Pts | Acceptance criteria |
|---|---|---|---|
| S3-1 | **Strategy interface** | 2 | `MinerStrategy` hooks (`onBlockFound`, `onBlockReceived`) so honest and attacker miners plug into the same engine |
| S3-2 | **Double-spend attacker** | 5 | Attacker pays the merchant on the public chain while privately mining a conflicting tx; publishes the private chain once the merchant has k confirmations and the private chain has more work; gives up after a configurable deficit. Outcome = success / fail. |
| S3-3 | **51% attack preset** | 2 | One click sets attacker hash > 50% and shows that success is eventually certain, matching the lecture claim "immutable unless > 51%" |
| S3-4 | **Selfish miner (Eyal & Sirer 2014)** | 5 | Full state machine (lead 0, 1, 2, >2, and the 0′ race); γ parameter sets what fraction of honest nodes mine on the attacker's block during a tie |
| S3-5 | **Attack panel UI** | 5 | Pick an attack and its parameters (α, k, γ); live readout of attacker lead, merchant confirmations, outcome banner; attacker blocks drawn in a distinct colour in the chain tree |
| S3-6 | **Metrics** | 3 | Attacker revenue share, stale-block rate, reorg depth histogram; shared with Sprint 4 |

**Sprint review clip:** a double-spend at 30% fails, then at 55% succeeds; selfish mining at α = 0.4 earns more than its fair share.

---

## Sprint 4: Experiments & polish (Fri 27 Nov – Tue 1 Dec), 15 pts
**Goal:** run thousands of trials and plot simulated results against the theory curves.

| ID | Story | Pts | Acceptance criteria |
|---|---|---|---|
| S4-1 | **Batch runner** | 3 | Headless Fast-mode trials; N trials × a sweep of α values; runs in chunks or a Web Worker with a progress bar; reproducible from the seed |
| S4-2 | **Theory module** | 3 | Nakamoto §11: P = 1 − Σₖ₌₀ᶻ (λᵏe^(−λ)/k!)(1 − (q/p)^(z−k)), λ = z·q/p (tested against the whitepaper's table, e.g. q = 0.1, z = 5 → 0.0009137). Selfish-mining revenue formula; threshold (1−γ)/(3−2γ) gives 1/3 at γ = 0 and 1/4 at γ = 0.5. |
| S4-3 | **Experiment UI + charts** | 5 | Chart 1: double-spend success vs q for z = 1…6, simulated points vs theory line. Chart 2: selfish revenue vs α for γ = 0 and 0.5 against the fair-share line. Settings shown alongside each chart. |
| S4-4 | **Export results** | 1 | Download CSV/JSON including the seed and parameters (reproducible results) |
| S4-5 | **Bug bash & UX pass** | 3 | Consistent layout and colours, empty and error states, tooltips explaining terms, mobile-safe layout; fix every known bug |

---

## Sprint 5: Documentation & submission (Wed 2 – Fri 4 Dec, slack Sat 5)
**Goal:** a reviewer can run, understand and grade everything.

| ID | Story | Pts | Acceptance criteria |
|---|---|---|---|
| S5-1 | **README & usage guide** | 2 | Live link, screenshots, how to run, architecture diagram, module map, how to reproduce the experiment charts |
| S5-2 | **Report (1–2 pages)** | 3 | Architecture, key algorithms, simulated-vs-theory results, discussion using the blockchain triangle (decentralization / security / scalability), GitHub link |
| S5-3 | **Demo video (5–10 min)** | 5 | Script → record (face + voice, ≥ 1024×768, .mp4): intro → core → network/forks → attacks → experiments → code tour → wrap-up. Reuse the sprint-review clips. |
| S5-4 | **Submit** | 1 | Make the repo public (the brief requires it), tag `v1.0`, check the live link in a private window, zip the program (no `node_modules`), upload everything |

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Fork/reorg logic (S2-3) is buggier than expected | High | High | Build on the S1-7 apply/undo property tests; write reorg tests before the UI |
| Real PoW freezes the browser | Medium | Medium | Low difficulty + chunked loop; Fast mode for anything multi-node |
| Selfish-mining results don't match theory | Medium | Medium | Test the state machine against the paper's transitions; compare with theory using many trials and γ handled exactly |
| Sprint 2 overruns and squeezes attacks | Medium | High | Sprint 2 UI (S2-7/S2-8) can ship minimal; attacks matter more for grading |
| Late video / report | Medium | High (30% of grade) | Recording clips each sprint; report notes collected in the Sprint 4 retro |
| Dependency / build issues on CI | Low | High | CI runs on every push, so breakage is caught the same day |

## Grading map (where the points come from)

| Criterion | Weight | Covered by |
|---|---|---|
| Usability | 25% | S0-3 hosting, S2-7, S3-5, S4-3, S4-5 |
| Functionality | 50% | Sprints 1–4 (real crypto, consensus, attacks, theory validation) |
| Documentation | 25% | DoD comments/tests, S4-4 reproducibility, S5-1, S5-2 |
