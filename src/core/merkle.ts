/**
 * Merkle root of a block's transactions.
 *
 * The leaves are txids. Each level hashes adjacent pairs with sha256d; if a
 * level has an odd number of nodes, the last one is paired with itself
 * (Bitcoin's rule). The single remaining hash is the root stored in the block
 * header, so changing any transaction changes the block hash.
 */
import { concatBytes, sha256d } from './hash';

export function merkleRoot(txids: readonly Uint8Array[]): Uint8Array {
  // Every valid block has at least its coinbase transaction.
  if (txids.length === 0) throw new Error('Merkle root of zero transactions is undefined');

  let level = [...txids];
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left; // odd count: duplicate the last hash
      next.push(sha256d(concatBytes(left, right)));
    }
    level = next;
  }
  return level[0];
}
