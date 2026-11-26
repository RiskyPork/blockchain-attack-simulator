import { describe, expect, it } from 'vitest';
import { COIN, type MineOptions, mineBlock, targetFromLeadingZeroBits } from '../core';
import { buildPayment } from '../node';
import { DEMOS } from './demos';
import { App } from './state';

const noYield: MineOptions = { yieldToEventLoop: async () => {} };

/** Alice and Bob, with the genesis block's 50 coins paid to Alice, at a difficulty that mines at once. */
async function fundedApp(): Promise<App> {
  const app = new App();
  app.chain.target = targetFromLeadingZeroBits(4);
  const alice = app.addWallet();
  app.addWallet();
  const { block } = await mineBlock(app.chain.createBlockTemplate(alice.key.address, 0), noYield);
  expect(app.chain.submitBlock(block).ok).toBe(true);
  return app;
}

describe('rule-breaking demos', () => {
  it('every demo is rejected by the validation rules, and none changes the chain or mempool', async () => {
    const app = await fundedApp();
    const height = app.chain.height;
    for (const demo of DEMOS) {
      const outcome = await demo.run(app, noYield);
      expect(outcome.accepted, `${demo.id}: ${outcome.reason}`).toBe(false);
    }
    expect(app.chain.height).toBe(height);
    expect(app.chain.mempool).toHaveLength(0);
  });

  it('editing a transaction breaks its signature even when the largest coin is exactly the 1 coin it signs for', async () => {
    const app = await fundedApp();
    const [alice, bob] = app.wallets;
    // Alice pays Bob 1 coin and the other 49 as fee, so the only coin left anywhere is Bob's 1 coin.
    const tx = buildPayment(app.chain.spendableUtxos(), alice.key, bob.key.address, COIN, 49 * COIN);
    expect(app.chain.submitTransaction(tx).ok).toBe(true);

    const outcome = await DEMOS.find((d) => d.id === 'tamper-tx')!.run(app, noYield);
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toMatch(/signature/);
  });
});
