import { describe, expect, it } from 'vitest';
import { blockHashHex } from '../core/block';
import { txidHex } from '../core/transaction';
import { HonestMiner } from '../strategies/honest';
import { type DoubleSpendReadout, type SelfishReadout, readAttack } from './attack-readout';
import {
  ATTACK_PAYMENT,
  type AttackConfig,
  DEFAULT_ATTACK,
  PRESET_51,
  Playground,
  attackHashPowers,
  attackerKey,
  merchantAddress,
} from './playground';

const selfish = (alpha: number, gamma: number): AttackConfig => ({ ...DEFAULT_ATTACK, kind: 'selfish', alpha, gamma });

/** Run until the double spend is decided (released or abandoned), in 10-minute slices. */
function runToVerdict(pg: Playground, limitBlocks = 2000): DoubleSpendReadout {
  for (let i = 0; i < limitBlocks; i++) {
    const r = readAttack(pg) as DoubleSpendReadout;
    if (r.phase !== 'mining') return r;
    pg.advance(600);
  }
  throw new Error('the attack was never decided');
}

/** Stop all mining and deliver everything still on the wire. */
function settle(pg: Playground): void {
  for (const id of pg.ring) pg.setHashPower(id, 0);
  while (pg.step());
}

describe('attackHashPowers', () => {
  it('gives the first node α and splits the rest in the old ratio, out of 100', () => {
    expect(attackHashPowers([30, 20, 15, 15, 10, 10], 0.3)).toEqual([30, 20, 15, 15, 10, 10]);
    const p = attackHashPowers([30, 20, 10, 10], 0.55);
    expect(p).toEqual([55, 20, 10, 10].map((x, i) => (i === 0 ? x : Math.round(x * 45 / 40 * 100) / 100)));
    expect(p.reduce((s, x) => s + x, 0)).toBeCloseTo(100, 1);
  });

  it('shares equally when no honest node had any hash power', () => {
    expect(attackHashPowers([5, 0, 0], 0.4)).toEqual([40, 30, 30]);
  });
});

describe('Playground attacks: setup (S3-5)', () => {
  it('has no attack until one is launched', () => {
    const pg = new Playground();
    expect(pg.attack).toBeNull();
    expect(readAttack(pg)).toBeNull();
    expect(pg.hiddenBlocks()).toEqual([]);
  });

  it('a double spend restarts the run with N0 as attacker and the payment already out', () => {
    const pg = new Playground();
    pg.advance(600 * 5);
    pg.launchAttack({ ...DEFAULT_ATTACK, alpha: 0.3, confirmations: 3 });

    expect(pg.now).toBe(0);
    const a = pg.attack!;
    expect(a.kind).toBe('double-spend');
    expect(a.node).toBe(pg.ring[0]);
    expect(pg.net.mining.share(a.node)).toBeCloseTo(0.3, 3);
    if (a.kind !== 'double-spend') throw new Error('unreachable');
    expect(a.strategy.phase).toBe('mining');
    expect(a.strategy.payment!.outputs[0]).toEqual({ value: ATTACK_PAYMENT, address: merchantAddress() });
    for (const id of pg.ring) expect(pg.chain(id).mempool.map(txidHex)).toEqual([txidHex(a.strategy.payment!)]);

    const r = readAttack(pg) as DoubleSpendReadout;
    expect(r).toMatchObject({ kind: 'double-spend', phase: 'mining', outcome: 'pending', needed: 3, privateBlocks: 0, publicBlocks: 0, toGetAhead: 1 });
    expect(r.catchUp).toBeCloseTo(0.3 / 0.7);
  });

  it('checks the settings, and needs a second node', () => {
    const pg = new Playground();
    expect(() => pg.launchAttack({ ...DEFAULT_ATTACK, alpha: 1 })).toThrow(RangeError);
    expect(() => pg.launchAttack({ ...DEFAULT_ATTACK, gamma: -0.1 })).toThrow(RangeError);
    expect(() => pg.launchAttack({ ...DEFAULT_ATTACK, confirmations: 0 })).toThrow(RangeError);
    expect(() => pg.launchAttack({ ...DEFAULT_ATTACK, maxDeficit: 2.5 })).toThrow(RangeError);
    expect(pg.attack).toBeNull();
    expect(() => new Playground({ hashPowers: [1] }).launchAttack(DEFAULT_ATTACK)).toThrow(/two nodes/);
  });

  it("keeps the attacker in place: it can't be removed, and new nodes join as honest miners", () => {
    const pg = new Playground();
    pg.launchAttack(selfish(0.35, 0.5));
    expect(() => pg.removeNode(pg.attack!.node)).toThrow(/attacker/);
    const id = pg.addNode();
    const miner = pg.net.mining.strategyOf(id) as HonestMiner;
    expect(miner).toBeInstanceOf(HonestMiner);
    // Under selfish mining, honest miners split ties by γ.
    expect(miner.tieBreak).toEqual({ favour: attackerKey().address, gamma: 0.5 });
  });

  it('reset replays the same attack; endAttack goes back to every node honest', () => {
    const pg = new Playground();
    pg.launchAttack(selfish(0.4, 0));
    pg.advance(600 * 20);
    const first = pg.net.mining.minedBlocks();
    pg.reset();
    expect(pg.attack?.kind).toBe('selfish');
    pg.advance(600 * 20);
    expect(pg.net.mining.minedBlocks()).toEqual(first);

    pg.endAttack();
    expect(pg.attack).toBeNull();
    expect(pg.now).toBe(0);
    for (const id of pg.ring) expect((pg.net.mining.strategyOf(id) as HonestMiner).tieBreak).toBeUndefined();
  });
});

describe('Playground attacks: outcomes (S3-3, S3-5)', () => {
  it('51% preset: the double spend succeeds, and every node undoes the blocks that held the payment', () => {
    const pg = new Playground();
    pg.launchAttack(PRESET_51);
    expect(pg.net.mining.share(pg.attack!.node)).toBeCloseTo(0.55, 3);
    const r = runToVerdict(pg);
    expect(r.phase).toBe('released');
    expect(r.confirmations).toBeGreaterThanOrEqual(PRESET_51.confirmations);
    expect(r.privateBlocks).toBeGreaterThan(r.publicBlocks);
    settle(pg);

    const after = readAttack(pg) as DoubleSpendReadout;
    expect(after.outcome).toBe('success');
    const a = pg.attack!;
    if (a.kind !== 'double-spend') throw new Error('unreachable');
    for (const id of pg.ring) {
      expect(pg.chain(id).txConfirmations(txidHex(a.strategy.doubleSpend!))).toBeGreaterThan(0);
      expect(pg.chain(id).balanceOf(merchantAddress())).toBe(0);
    }
    // The release shows up as reorgs at least k deep, and the activity log agrees on the depths.
    expect(pg.reorgs.deepest).toBeGreaterThanOrEqual(PRESET_51.confirmations);
    const logged = pg.activity.flatMap((x) => (x.kind === 'reorg' ? [x.depth] : []));
    expect(Math.max(...logged)).toBe(pg.reorgs.deepest);
    expect(logged).toHaveLength(pg.reorgs.count);
  });

  it('a 30% attacker against 6 confirmations mostly gives up', () => {
    let failed = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const pg = new Playground({ seed });
      pg.launchAttack({ ...DEFAULT_ATTACK, alpha: 0.3, confirmations: 6, maxDeficit: 6 });
      if (runToVerdict(pg).outcome === 'failed') failed++;
    }
    expect(failed).toBeGreaterThanOrEqual(5);
  });

  it('selfish mining at α = 0.4 earns more than its fair share, hiding blocks along the way', () => {
    const pg = new Playground({ seed: 4 });
    pg.launchAttack(selfish(0.4, 0.5));
    let sawHidden = false;
    for (let i = 0; i < 400; i++) {
      pg.advance(600);
      sawHidden ||= pg.hiddenBlocks().length > 0;
    }
    expect(sawHidden).toBe(true);
    const withheld = pg.activity.filter((x) => x.kind === 'withheld');
    expect(withheld.length).toBeGreaterThan(0);
    for (const w of withheld) expect(pg.isAttackerBlock(w.block.hash)).toBe(true);

    const r = readAttack(pg) as SelfishReadout;
    expect(r.kind).toBe('selfish');
    expect(r.mainBlocks).toBeGreaterThan(200);
    expect(r.revenue).toBeGreaterThan(0.4);
    expect(r.theory).toBeCloseTo(0.5256, 3);
    expect(r.threshold).toBeCloseTo(0.25);
    expect(r.counters.races + r.counters.overrides).toBeGreaterThan(0);
  });

  it('hidden blocks are found by the attacker and stored by no node', () => {
    const pg = new Playground({ seed: 2 });
    pg.launchAttack(selfish(0.45, 0));
    for (let i = 0; i < 200 && pg.hiddenBlocks().length === 0; i++) pg.advance(600);
    const hidden = pg.hiddenBlocks();
    expect(hidden.length).toBeGreaterThan(0);
    for (const b of hidden) {
      const hash = blockHashHex(b.header);
      expect(pg.isAttackerBlock(hash)).toBe(true);
      for (const id of pg.ring) expect(pg.chain(id).tree.has(hash)).toBe(false);
    }
  });
});
