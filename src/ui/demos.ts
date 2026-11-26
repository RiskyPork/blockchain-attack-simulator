/**
 * "Try to break the rules": each demo builds an invalid transaction or block
 * and asks the node's validation rules to judge it.
 *
 * Demos run on copies of the node's state (dry runs), so they never change the
 * chain or the mempool. The rejection reason comes from core/validation, not
 * from this file: the UI only builds the attempts.
 */
import {
  BLOCK_SUBSIDY,
  COIN,
  type Block,
  type BlockContext,
  type BlockResult,
  type CoinbaseTx,
  type KeyPair,
  type MineOptions,
  type TxResult,
  type Utxo,
  assembleBlock,
  blockHash,
  describeBlockError,
  describeTxError,
  generateKeyPair,
  meetsTarget,
  mineBlock,
  signTransaction,
  validateBlock,
  validateTransaction,
} from '../core';
import { buildPayment } from '../node';
import { fmtCoins } from './format';
import type { App, NamedWallet } from './state';

export interface DemoOutcome {
  /** What was attempted, in plain words. */
  attempt: string;
  accepted: boolean;
  /** The rule that rejected it (or a note if it was unexpectedly accepted). */
  reason: string;
}

export interface Demo {
  id: string;
  label: string;
  kind: 'tx' | 'block';
  /** Tx demos need a wallet that owns at least one confirmed output. */
  needsFunds: boolean;
  run(app: App, mining: MineOptions): Promise<DemoOutcome>;
}

/** The wallet with the largest confirmed balance, and its largest coin. */
function richest(app: App): { wallet: NamedWallet; coin: Utxo } | null {
  const utxos = app.chain.spendableUtxos();
  let best: { wallet: NamedWallet; coin: Utxo } | null = null;
  for (const wallet of app.wallets) {
    for (const coin of utxos.utxosOf(wallet.key.address)) {
      if (!best || coin.output.value > best.coin.output.value) best = { wallet, coin };
    }
  }
  return best;
}

/** Another wallet to pay, or a throwaway key if the user has only one wallet. */
function someoneElse(app: App, not: NamedWallet): { name: string; key: KeyPair } {
  return app.wallets.find((w) => w !== not) ?? { name: 'a stranger', key: generateKeyPair() };
}

function txOutcome(attempt: string, r: TxResult): DemoOutcome {
  return r.ok
    ? { attempt, accepted: true, reason: `Accepted (fee ${fmtCoins(r.fee)}). This demo expected a rejection.` }
    : { attempt, accepted: false, reason: describeTxError(r.error) };
}

function blockOutcome(attempt: string, r: BlockResult): DemoOutcome {
  return r.ok
    ? { attempt, accepted: true, reason: 'Accepted. This demo expected a rejection.' }
    : { attempt, accepted: false, reason: describeBlockError(r.error) };
}

function blockContext(app: App): BlockContext {
  const c = app.chain;
  return { utxos: c.confirmedUtxos(), parentHash: c.tipHash, height: c.height + 1, target: c.target };
}

function minerKey(app: App): KeyPair {
  if (app.wallets.length === 0) throw new Error('Create a wallet first.');
  return app.wallets[0].key;
}

function funded(app: App) {
  const r = richest(app);
  if (!r) throw new Error('No wallet owns any coins yet. Mine a block first.');
  return r;
}

export const DEMOS: Demo[] = [
  {
    id: 'overspend',
    label: 'Spend more than you have',
    kind: 'tx',
    needsFunds: true,
    async run(app) {
      const { wallet } = funded(app);
      const to = someoneElse(app, wallet);
      const balance = app.chain.balanceOf(wallet.key.address, { includeMempool: true });
      const amount = balance + COIN;
      const tx = buildPayment(app.chain.spendableUtxos(), wallet.key, to.key.address, amount, 0);
      return txOutcome(
        `${wallet.name} owns ${fmtCoins(balance)} coins and tries to send ${fmtCoins(amount)} to ${to.name}.`,
        validateTransaction(app.chain.spendableUtxos(), tx),
      );
    },
  },
  {
    id: 'double-spend',
    label: 'Spend the same coin twice',
    kind: 'tx',
    needsFunds: true,
    async run(app) {
      const { wallet, coin } = funded(app);
      const to = someoneElse(app, wallet);
      const view = app.chain.spendableUtxos();
      const value = coin.output.value;
      const first = signTransaction([{ prevOut: coin.outPoint, key: wallet.key }], [{ value, address: to.key.address }]);
      const r1 = validateTransaction(view, first);
      if (!r1.ok) return txOutcome('First payment', r1);
      view.applyTransactions([first]);
      const second = signTransaction([{ prevOut: coin.outPoint, key: wallet.key }], [{ value, address: wallet.key.address }]);
      return txOutcome(
        `${wallet.name} pays the same ${fmtCoins(value)}-coin output to ${to.name} (accepted), then signs a second payment of that same output back to its own address.`,
        validateTransaction(view, second),
      );
    },
  },
  {
    id: 'steal',
    label: "Spend someone else's coin",
    kind: 'tx',
    needsFunds: true,
    async run(app) {
      const { wallet, coin } = funded(app);
      const thief = generateKeyPair();
      const tx = signTransaction([{ prevOut: coin.outPoint, key: thief }], [{ value: coin.output.value, address: thief.address }]);
      return txOutcome(
        `A thief signs a transaction spending ${wallet.name}'s ${fmtCoins(coin.output.value)}-coin output with the thief's own key.`,
        validateTransaction(app.chain.spendableUtxos(), tx),
      );
    },
  },
  {
    id: 'tamper-tx',
    label: 'Edit a transaction after signing',
    kind: 'tx',
    needsFunds: true,
    async run(app) {
      const { wallet, coin } = funded(app);
      const to = someoneElse(app, wallet);
      const tx = buildPayment(app.chain.spendableUtxos(), wallet.key, to.key.address, COIN, 0);
      // Up to the whole coin, so the signature is the only thing wrong, but always
      // more than the 1 coin signed for: an unchanged amount would still verify.
      const forged = Math.max(Math.min(coin.output.value, 10 * COIN), 2 * COIN);
      const tampered = { ...tx, outputs: [{ ...tx.outputs[0], value: forged }, ...tx.outputs.slice(1)] };
      return txOutcome(
        `${wallet.name} signs "pay ${to.name} 1 coin"; someone then changes the amount to ${fmtCoins(forged)} without re-signing.`,
        validateTransaction(app.chain.spendableUtxos(), tampered),
      );
    },
  },
  {
    id: 'fake-pow',
    label: 'Skip the proof of work',
    kind: 'block',
    needsFunds: false,
    async run(app) {
      const template = app.chain.createBlockTemplate(minerKey(app).address, Date.now());
      let header = template.header;
      while (meetsTarget(blockHash(header), header.target)) header = { ...header, nonce: header.nonce + 1 };
      return blockOutcome(
        'A miner broadcasts a block without searching for a valid nonce.',
        validateBlock({ ...template, header }, blockContext(app)),
      );
    },
  },
  {
    id: 'inflate',
    label: 'Pay yourself a bigger reward',
    kind: 'block',
    needsFunds: false,
    async run(app, mining) {
      const miner = minerKey(app);
      const c = app.chain;
      const template = c.createBlockTemplate(miner.address, Date.now());
      const fees = (template.txs[0] as CoinbaseTx).outputs[0].value - BLOCK_SUBSIDY;
      const greedy = assembleBlock({
        prevHash: c.tipHash,
        height: c.height + 1,
        timestamp: template.header.timestamp,
        target: c.target,
        minerAddress: miner.address,
        txs: c.mempool,
        fees: fees + 1000 * COIN,
      });
      const { block } = await mineBlock(greedy, mining);
      return blockOutcome(
        'A miner does real proof of work on a block whose coinbase claims 1000 extra coins.',
        validateBlock(block, blockContext(app)),
      );
    },
  },
  {
    id: 'tamper-block',
    label: 'Edit a block after mining',
    kind: 'block',
    needsFunds: false,
    async run(app, mining) {
      const template = app.chain.createBlockTemplate(minerKey(app).address, Date.now());
      const { block } = await mineBlock(template, mining);
      const coinbase = block.txs[0] as CoinbaseTx;
      const edited: Block = {
        header: block.header,
        txs: [{ ...coinbase, outputs: [{ ...coinbase.outputs[0], value: coinbase.outputs[0].value - COIN }] }, ...block.txs.slice(1)],
      };
      return blockOutcome(
        'A valid block is mined, then one transaction in it is changed (the header and its PoW stay the same).',
        validateBlock(edited, blockContext(app)),
      );
    },
  },
];
