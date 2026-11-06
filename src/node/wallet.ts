/**
 * Wallet: turns "pay X coins to Y" into a signed transaction.
 *
 * In the UTXO model a payment spends whole outputs. The wallet picks enough
 * of its outputs to cover amount + fee, pays the recipient, and sends the
 * leftover back to itself as a "change" output.
 *
 * The wallet deliberately doesn't refuse an overspend: it builds the tx anyway
 * so the node's validation can be seen rejecting it (the explorer's
 * invalid-tx demo). A real wallet would check first.
 */
import { type Address, type KeyPair, type StandardTx, type TxOutput, type UtxoSet, bytesToHex, signTransaction } from '../core';

export function buildPayment(utxos: UtxoSet, from: KeyPair, to: Address, amount: number, fee: number): StandardTx {
  // Largest first keeps the number of inputs (and so the tx size) small.
  // Equal coins: by txid, then output index (numerically, so :2 before :10),
  // so the same wallet state always produces the same transaction.
  const coins = utxos.utxosOf(from.address).sort((a, b) => {
    if (a.output.value !== b.output.value) return b.output.value - a.output.value;
    const ta = bytesToHex(a.outPoint.txid);
    const tb = bytesToHex(b.outPoint.txid);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.outPoint.index - b.outPoint.index;
  });

  const selected: typeof coins = [];
  let total = 0;
  for (const coin of coins) {
    if (total >= amount + fee) break;
    selected.push(coin);
    total += coin.output.value;
  }

  const outputs: TxOutput[] = [{ value: amount, address: to }];
  const change = total - amount - fee;
  if (change > 0) outputs.push({ value: change, address: from.address });

  return signTransaction(
    selected.map((c) => ({ prevOut: c.outPoint, key: from })),
    outputs,
  );
}
