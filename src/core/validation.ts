/**
 * Consensus rules: when is a transaction or a block valid?
 *
 * Every node checks every block it receives against these rules before
 * accepting it, and doesn't trust the miner. That is why a miner can't print
 * extra coins, spend someone else's outputs or skip the proof of work: honest
 * nodes would reject the block and keep building on the previous tip.
 *
 * Each function returns the first rule that fails, as a typed error the UI
 * can explain, and never throws on malformed data.
 */
import { type Block, type BlockHeader, blockHash, meetsTarget, serializeHeader } from './block';
import { isValidAddress } from './keys';
import { merkleRoot } from './merkle';
import { BLOCK_SUBSIDY } from './miner';
import {
  COIN,
  type OutPoint,
  type StandardTx,
  type Transaction,
  type TxOutput,
  checkInputAuthorization,
  isCoinbase,
  outPointKey,
  totalOutputValue,
  txid,
} from './transaction';
import type { UtxoSet } from './utxo';

/** Bitcoin's 21 million coin cap. Bounding every value also keeps sums exact in JS numbers. */
export const MAX_MONEY = 21_000_000 * COIN;

export type TxError =
  | { code: 'unexpected-coinbase' }
  | { code: 'no-inputs' }
  | { code: 'no-outputs' }
  | { code: 'invalid-output-value'; output: number }
  | { code: 'invalid-address'; output: number }
  | { code: 'duplicate-input'; input: number }
  | { code: 'spent-in-block'; input: number }
  | { code: 'missing-input'; input: number }
  | { code: 'wrong-public-key'; input: number }
  | { code: 'bad-signature'; input: number }
  | { code: 'overspend'; inputTotal: number; outputTotal: number };

export type TxResult = { ok: true; fee: number } | { ok: false; error: TxError };

export interface BlockContext {
  /** UTXO set after the parent block. Never modified. */
  utxos: UtxoSet;
  /** Hash of the parent; block.header.prevHash must equal it. */
  parentHash: Uint8Array;
  /** Height of the new block; its coinbase must commit to it. */
  height: number;
  /** Network difficulty. The miner doesn't get to choose its own target. */
  target: bigint;
}

export type BlockError =
  | { code: 'malformed-header' }
  | { code: 'unknown-parent' }
  | { code: 'wrong-target' }
  | { code: 'bad-pow' }
  | { code: 'no-transactions' }
  | { code: 'first-tx-not-coinbase' }
  | { code: 'multiple-coinbase'; index: number }
  | { code: 'bad-coinbase-height'; expected: number; actual: number }
  | { code: 'invalid-tx'; index: number; error: TxError }
  | { code: 'bad-merkle-root' }
  | { code: 'coinbase-too-large'; claimed: number; allowed: number };

export type BlockResult = { ok: true; fees: number } | { ok: false; error: BlockError };

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/** Rules that need no UTXO set: shape, value ranges, addresses, no input listed twice. */
export function checkTxStructure(tx: Transaction): TxError | null {
  if (!isCoinbase(tx) && tx.inputs.length === 0) return { code: 'no-inputs' };
  if (tx.outputs.length === 0) return { code: 'no-outputs' };

  let total = 0;
  for (let i = 0; i < tx.outputs.length; i++) {
    const { value, address } = tx.outputs[i];
    if (!Number.isInteger(value) || value < 1 || value > MAX_MONEY) return { code: 'invalid-output-value', output: i };
    total += value;
    if (total > MAX_MONEY) return { code: 'invalid-output-value', output: i };
    if (!isValidAddress(address)) return { code: 'invalid-address', output: i };
  }

  if (!isCoinbase(tx)) {
    const seen = new Set<string>();
    for (let i = 0; i < tx.inputs.length; i++) {
      const key = outPointKey(tx.inputs[i].prevOut);
      if (seen.has(key)) return { code: 'duplicate-input', input: i };
      seen.add(key);
    }
  }
  return null;
}

/** Validate a standalone (mempool) transaction against a UTXO set. */
export function validateTransaction(utxos: UtxoSet, tx: Transaction): TxResult {
  if (isCoinbase(tx)) return fail({ code: 'unexpected-coinbase' });
  const structural = checkTxStructure(tx);
  if (structural) return fail(structural);
  return checkSpends(tx, (o) => utxos.get(o) ?? 'missing');
}

/** What an input's outpoint resolves to in the current view. */
type Lookup = (o: OutPoint) => TxOutput | 'missing' | 'spent-in-block';

/**
 * The rules that need the UTXO view, in order:
 *   1. every input exists (unspent);
 *   2. every input is authorized (owner's public key, valid signature);
 *   3. Σ outputs ≤ Σ inputs (the difference is the miner's fee).
 */
function checkSpends(tx: StandardTx, lookup: Lookup): TxResult {
  const spent: TxOutput[] = [];
  for (let i = 0; i < tx.inputs.length; i++) {
    const found = lookup(tx.inputs[i].prevOut);
    if (found === 'missing') return fail({ code: 'missing-input', input: i });
    if (found === 'spent-in-block') return fail({ code: 'spent-in-block', input: i });
    spent.push(found);
  }
  for (let i = 0; i < tx.inputs.length; i++) {
    const err = checkInputAuthorization(tx, i, spent[i]);
    if (err) return fail({ code: err, input: i });
  }
  const inputTotal = spent.reduce((sum, o) => sum + o.value, 0);
  const outputTotal = totalOutputValue(tx);
  if (outputTotal > inputTotal) return fail({ code: 'overspend', inputTotal, outputTotal });
  return { ok: true, fee: inputTotal - outputTotal };
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * Header-only rules: well-formed, uses the network's target, has real PoW.
 * They need nothing but the header, so a node runs them on every block it
 * receives before storing it anywhere, even in the orphan pool: a block
 * without valid PoW is never worth keeping.
 */
export function checkHeader(header: BlockHeader, target: bigint): BlockError | null {
  let hash: Uint8Array;
  try {
    hash = blockHash(header);
  } catch {
    return { code: 'malformed-header' };
  }
  if (header.target !== target) return { code: 'wrong-target' };
  if (!meetsTarget(hash, header.target)) return { code: 'bad-pow' };
  return null;
}

/**
 * Every block rule that doesn't need the UTXO set: checkHeader, then one
 * coinbase committing to `height`, well-formed txs and a matching Merkle root.
 * A node runs this on a side-branch block it stores but doesn't apply yet;
 * the spends are checked by validateBlock if that branch ever becomes the main chain.
 */
export function checkBlockStructure(block: Block, ctx: { height: number; target: bigint }): BlockError | null {
  const r = checkStructure(block, ctx);
  return 'error' in r ? r.error : null;
}

/** checkBlockStructure, also returning the txids so validateBlock doesn't hash every tx twice. */
function checkStructure(block: Block, ctx: { height: number; target: bigint }): { error: BlockError } | { ids: Uint8Array[] } {
  const { header, txs } = block;
  const headerError = checkHeader(header, ctx.target);
  if (headerError) return { error: headerError };

  // Exactly one coinbase, first, committing to this height.
  if (txs.length === 0) return { error: { code: 'no-transactions' } };
  const coinbase = txs[0];
  if (!isCoinbase(coinbase)) return { error: { code: 'first-tx-not-coinbase' } };
  const extra = txs.findIndex((tx, i) => i > 0 && isCoinbase(tx));
  if (extra !== -1) return { error: { code: 'multiple-coinbase', index: extra } };
  if (coinbase.height !== ctx.height) {
    return { error: { code: 'bad-coinbase-height', expected: ctx.height, actual: coinbase.height } };
  }

  for (let i = 0; i < txs.length; i++) {
    const error = checkTxStructure(txs[i]);
    if (error) return { error: { code: 'invalid-tx', index: i, error } };
  }

  // The header must commit to exactly these transactions.
  let ids: Uint8Array[];
  try {
    ids = txs.map(txid);
  } catch {
    return { error: { code: 'bad-merkle-root' } }; // a tx that can't be hashed can't match any root
  }
  if (!sameBytes(header.merkleRoot, merkleRoot(ids))) return { error: { code: 'bad-merkle-root' } };
  return { ids };
}

export function validateBlock(block: Block, ctx: BlockContext): BlockResult {
  const { header, txs } = block;

  // Header: well-formed and extends the expected parent; then everything checkBlockStructure checks.
  try {
    serializeHeader(header);
  } catch {
    return failBlock({ code: 'malformed-header' });
  }
  if (!sameBytes(header.prevHash, ctx.parentHash)) return failBlock({ code: 'unknown-parent' });
  const structure = checkStructure(block, ctx);
  if ('error' in structure) return failBlock(structure.error);
  const { ids } = structure;
  const coinbase = txs[0];

  // Spends, tx by tx. A view on top of ctx.utxos (which stays untouched):
  // outputs created by earlier txs in this block, minus outpoints they spent.
  // The coinbase's outputs are deliberately not added, so the block can't spend them.
  const created = new Map<string, TxOutput>();
  const spentInBlock = new Set<string>();
  const lookup: Lookup = (o) => {
    const key = outPointKey(o);
    if (spentInBlock.has(key)) return 'spent-in-block';
    return created.get(key) ?? ctx.utxos.get(o) ?? 'missing';
  };

  let fees = 0;
  for (let i = 1; i < txs.length; i++) {
    const tx = txs[i] as StandardTx; // no coinbase past index 0, checked above
    const r = checkSpends(tx, lookup);
    if (!r.ok) return failBlock({ code: 'invalid-tx', index: i, error: r.error });
    fees += r.fee;
    for (const input of tx.inputs) {
      const key = outPointKey(input.prevOut);
      spentInBlock.add(key);
      created.delete(key);
    }
    tx.outputs.forEach((output, index) => created.set(outPointKey({ txid: ids[i], index }), output));
  }

  // The miner may claim at most the subsidy plus the fees of the block's txs.
  const claimed = totalOutputValue(coinbase);
  const allowed = BLOCK_SUBSIDY + fees;
  if (claimed > allowed) return failBlock({ code: 'coinbase-too-large', claimed, allowed });
  return { ok: true, fees };
}

// ---------------------------------------------------------------------------
// Messages for the UI
// ---------------------------------------------------------------------------

const coins = (units: number) => `${units / COIN} coins`;

export function describeTxError(e: TxError): string {
  switch (e.code) {
    case 'unexpected-coinbase':
      return 'A coinbase transaction can only appear as the first transaction of a block.';
    case 'no-inputs':
      return 'The transaction has no inputs, so it spends nothing.';
    case 'no-outputs':
      return 'The transaction has no outputs.';
    case 'invalid-output-value':
      return `Output #${e.output} has an invalid value (must be a whole number of units, 1 to 21 million coins in total).`;
    case 'invalid-address':
      return `Output #${e.output} pays to an invalid address (bad Base58Check checksum or version).`;
    case 'duplicate-input':
      return `Input #${e.input} spends the same output as an earlier input of this transaction.`;
    case 'spent-in-block':
      return `Input #${e.input} spends an output that an earlier transaction in this block already spent (double spend).`;
    case 'missing-input':
      return `Input #${e.input} spends an output that doesn't exist or was already spent (double spend).`;
    case 'wrong-public-key':
      return `Input #${e.input}: the public key doesn't hash to the address that owns this output.`;
    case 'bad-signature':
      return `Input #${e.input}: the signature doesn't verify, so either the transaction was changed after signing or it was signed with the wrong key.`;
    case 'overspend':
      return `Outputs (${coins(e.outputTotal)}) exceed inputs (${coins(e.inputTotal)}).`;
  }
}

export function describeBlockError(e: BlockError): string {
  switch (e.code) {
    case 'malformed-header':
      return 'The block header has fields out of range.';
    case 'unknown-parent':
      return "The block's previous-hash doesn't point to the current tip.";
    case 'wrong-target':
      return "The block uses a different difficulty target from the network's.";
    case 'bad-pow':
      return "The block hash is above the target: the proof of work isn't valid.";
    case 'no-transactions':
      return 'The block has no transactions (it needs at least a coinbase).';
    case 'first-tx-not-coinbase':
      return 'The first transaction of a block must be the coinbase.';
    case 'multiple-coinbase':
      return `Transaction #${e.index} is a second coinbase; a block has exactly one.`;
    case 'bad-coinbase-height':
      return `The coinbase commits to height ${e.actual}, but this block would be at height ${e.expected}.`;
    case 'invalid-tx':
      return `Transaction #${e.index} is invalid: ${describeTxError(e.error)}`;
    case 'bad-merkle-root':
      return "The Merkle root in the header doesn't match the block's transactions.";
    case 'coinbase-too-large':
      return `The coinbase claims ${coins(e.claimed)}, but subsidy + fees allow only ${coins(e.allowed)}.`;
  }
}

// ---------------------------------------------------------------------------

function fail(error: TxError): TxResult {
  return { ok: false, error };
}

function failBlock(error: BlockError): BlockResult {
  return { ok: false, error };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

