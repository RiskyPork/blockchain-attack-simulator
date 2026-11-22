/**
 * The attack scenario shared by the live Attacks tab (ui/playground.ts) and
 * the batch runner (batch.ts): deterministic keys for every miner, the
 * attacker and the merchant, and a genesis block that pays the attacker, so a
 * double spend can start at t = 0 without the attacker first mining coins.
 *
 * Keys come from fixed labels (private key = sha256(label)), never from a
 * random source, so a run replays exactly from its seed and settings.
 */
import {
  type Address,
  type Block,
  COIN,
  type KeyPair,
  ZERO_HASH,
  assembleBlock,
  keyPairFromPrivate,
  mineChunk,
  sha256,
  targetFromLeadingZeroBits,
  utf8ToBytes,
} from '../core';
import { type NodeId, SIMULATED_POW_TARGET } from '../network';

/** Fast mode skips the nonce search; real mode does it at a low difficulty. */
export type PowMode = 'simulated' | 'real';

/** Leading zero bits per block in real PoW mode: about 4,096 hashes each, quick enough to mine inside the event loop. */
export const REAL_POW_BITS = 12;

/** What the double spend pays the merchant. The attacker starts with the 50-coin genesis reward. */
export const ATTACK_PAYMENT = 10 * COIN;

const addressCache = new Map<string, Address>();

function addressFor(label: string): Address {
  let a = addressCache.get(label);
  if (!a) {
    a = keyPairFromPrivate(sha256(utf8ToBytes(label))).address;
    addressCache.set(label, a);
  }
  return a;
}

/** The reward address of node `id`'s miner. It only depends on the id, so runs replay exactly. */
export function minerAddress(id: NodeId): Address {
  return addressFor(`playground node ${id}`);
}

let attacker: KeyPair | null = null;

/** The attacker's wallet: it signs the double spend and collects the attacker's rewards. */
export function attackerKey(): KeyPair {
  return (attacker ??= keyPairFromPrivate(sha256(utf8ToBytes('playground attacker'))));
}

/** Who the double spend pays, and then takes back. */
export function merchantAddress(): Address {
  return addressFor('playground merchant');
}

const genesisCache = new Map<PowMode, Block>();

/** The shared first block. Its target sets the network's difficulty, and so the PoW mode. */
export function genesisFor(pow: PowMode): Block {
  let g = genesisCache.get(pow);
  if (!g) {
    const target = pow === 'real' ? targetFromLeadingZeroBits(REAL_POW_BITS) : SIMULATED_POW_TARGET;
    // The genesis reward is the attacker's starting balance.
    const t = assembleBlock({ prevHash: ZERO_HASH, height: 0, timestamp: 0, target, minerAddress: attackerKey().address, txs: [], fees: 0 });
    g = { header: mineChunk(t.header, Number.MAX_SAFE_INTEGER).header, txs: t.txs };
    genesisCache.set(pow, g);
  }
  return g;
}
