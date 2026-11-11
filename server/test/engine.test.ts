import { describe, expect, it } from 'vitest';
import { applyDecay, applyTrade, newHp, type EngineCfg } from '../src/engine/pinata';
import { assignWeights, pickWinners, rankCandidates, type RoundTrade } from '../src/engine/winners';
import { planCost, planPacks, splitByWeight, splitPot } from '../src/engine/allocation';

const cfg: EngineCfg = { sellHealFactor: 0.5, minBuyUsd: 10, minPotUsd: 150, decayAfterMs: 6 * 3_600_000, decayPctPerHour: 10 };
const T0 = 1_000_000;
const buy = (usd: number, ts = T0) => ({ side: 'buy' as const, usd, ts });
const sell = (usd: number, ts = T0) => ({ side: 'sell' as const, usd, ts });

describe('HP', () => {
  it('buys damage and sells heal at half strength, capped at max', () => {
    let s = newHp(1000, T0);
    let r = applyTrade(s, buy(300), 500, cfg);
    expect(r.next.hp).toBe(700);
    expect(r.effect).toMatchObject({ kind: 'hit', amount: 300, broke: false });
    r = applyTrade(r.next, sell(200), 500, cfg);
    expect(r.next.hp).toBe(800);
    r = applyTrade(r.next, sell(10_000), 500, cfg);
    expect(r.next.hp).toBe(1000);
    expect(r.effect.amount).toBe(200);
  });

  it('breaks on a qualifying buy when the pot is big enough', () => {
    const s = { ...newHp(1000, T0), hp: 50 };
    const r = applyTrade(s, buy(80), 500, cfg);
    expect(r.effect.broke).toBe(true);
    expect(r.effect.armoredBreak).toBe(false);
    expect(r.next.hp).toBe(0);
  });

  it('a buy under the minimum cannot finish it', () => {
    const s = { ...newHp(1000, T0), hp: 5 };
    const r = applyTrade(s, buy(9), 500, cfg);
    expect(r.effect.broke).toBe(false);
    expect(r.next.hp).toBe(1);
    expect(r.next.armored).toBe(false);
  });

  it('holds at 1 HP while the pot is too small, then breaks without the breaker bonus', () => {
    const s = { ...newHp(1000, T0), hp: 50 };
    const held = applyTrade(s, buy(500), 100, cfg);
    expect(held.effect.broke).toBe(false);
    expect(held.next).toMatchObject({ hp: 1, armored: true });
    const broke = applyTrade(held.next, buy(20), 200, cfg);
    expect(broke.effect).toMatchObject({ broke: true, armoredBreak: true });
  });

  it('a heal clears the armored state', () => {
    const s = { ...newHp(1000, T0), hp: 1, armored: true };
    const r = applyTrade(s, sell(100), 100, cfg);
    expect(r.next.armored).toBe(false);
    expect(r.next.hp).toBe(51);
  });

  it('decays only after the grace period and never below 1', () => {
    const s = newHp(1000, T0);
    expect(applyDecay(s, T0 + 5 * 3_600_000, cfg).hp).toBe(1000);
    expect(applyDecay(s, T0 + 8 * 3_600_000, cfg).hp).toBeCloseTo(800);
    expect(applyDecay(s, T0 + 100 * 3_600_000, cfg).hp).toBe(1);
    // applying in two steps equals applying once
    const twoStep = applyDecay(applyDecay(s, T0 + 7 * 3_600_000, cfg), T0 + 8 * 3_600_000, cfg);
    expect(twoStep.hp).toBeCloseTo(800);
  });
});

const t = (seq: number, wallet: string, side: 'buy' | 'sell', usd: number): RoundTrade => ({
  sig: `s${seq}`,
  seq,
  wallet,
  side,
  usd,
  tokens: usd * 1000,
});

describe('winners', () => {
  const weights = [30, 25, 20, 15, 10];
  const trades = [
    t(1, 'A', 'buy', 500),
    t(2, 'B', 'buy', 900),
    t(3, 'A', 'buy', 700),
    t(4, 'C', 'buy', 9),
    t(5, 'D', 'buy', 300),
    t(6, 'E', 'buy', 300),
    t(7, 'F', 'buy', 250),
    t(8, 'B', 'sell', 100),
    t(9, 'G', 'buy', 40),
    t(10, 'TREASURY', 'buy', 5000),
    t(11, 'Z', 'buy', 60),
  ];
  const opts = { minBuyUsd: 10, excluded: new Set(['TREASURY']), breakerSig: 's11' };

  it('ranks breaker first, one slot per wallet, skips sellers, small buys and excluded wallets', () => {
    const r = rankCandidates(trades, opts);
    expect(r.breaker?.wallet).toBe('Z');
    expect(r.others.map((c) => c.wallet)).toEqual(['A', 'D', 'E', 'F', 'G']);
    expect(r.others[0]!.usd).toBe(700);
  });

  it('passes slots down when a candidate fails the hold check', async () => {
    const r = rankCandidates(trades, opts);
    const picked = await pickWinners(r, async (c) => c.wallet !== 'D');
    expect(picked.others.map((c) => c.wallet)).toEqual(['A', 'E', 'F', 'G']);
    const w = assignWeights(picked, weights, false);
    expect(w.map((x) => [x.wallet, x.role, Math.round(x.weight * 100)])).toEqual([
      ['Z', 'breaker', 30],
      ['A', 'top', 25],
      ['E', 'top', 20],
      ['F', 'top', 15],
      ['G', 'top', 10],
    ]);
  });

  it('ranks the breaker by size after an armored break', async () => {
    const picked = await pickWinners(rankCandidates(trades, opts), async () => true);
    const w = assignWeights(picked, weights, true);
    expect(w.map((x) => x.wallet)).toEqual(['A', 'D', 'E', 'F', 'Z']);
    expect(w[4]!.role).toBe('breaker');
    expect(w.reduce((a, x) => a + x.weight, 0)).toBeCloseTo(1);
  });

  it('renormalises when fewer than five qualify', async () => {
    const few = [t(1, 'A', 'buy', 100), t(2, 'B', 'buy', 50)];
    const picked = await pickWinners(rankCandidates(few, { ...opts, breakerSig: 's2' }), async () => true);
    const w = assignWeights(picked, weights, false);
    expect(w.map((x) => x.wallet)).toEqual(['B', 'A']);
    expect(w[0]!.weight).toBeCloseTo(30 / 55);
    expect(w[1]!.weight).toBeCloseTo(25 / 55);
  });

  it('ties go to the earlier buy', () => {
    const r = rankCandidates(trades, { ...opts, breakerSig: null });
    expect(r.others.map((c) => c.wallet).slice(1, 3)).toEqual(['D', 'E']);
  });
});

describe('allocation', () => {
  const tiers = [25, 50, 100];

  it('splits the pot 25/25/50 with no lamports lost', () => {
    const s = splitPot(1_000_000_007n, { packs: 25, buyback: 25, usdc: 50 });
    expect(s.packs + s.buyback + s.usdc).toBe(1_000_000_007n);
    expect(s.packs).toBe(250_000_001n);
  });

  it('gives two $100 packs each from a $1,000 budget', () => {
    const plan = planPacks(1000, 5, tiers, 3);
    expect(plan).toEqual([[100, 100], [100, 100], [100, 100], [100, 100], [100, 100]]);
  });

  it('prefers a uniform tier then upgrades by rank', () => {
    expect(planPacks(200, 5, tiers, 3)).toEqual([[50], [50], [50], [25], [25]]);
    expect(planPacks(125, 5, tiers, 3)).toEqual([[25], [25], [25], [25], [25]]);
    expect(planPacks(520, 5, tiers, 3)).toEqual([[100], [100], [100], [100], [100]]);
  });

  it('gives small packs to the top ranks when the budget is short', () => {
    expect(planPacks(60, 5, tiers, 3)).toEqual([[25], [25], [], [], []]);
    expect(planPacks(20, 5, tiers, 3)).toEqual([[], [], [], [], []]);
  });

  it('never spends more than the budget and respects the per-winner cap', () => {
    for (const b of [0, 24, 25, 99, 137, 499, 777, 1500, 2000, 100_000]) {
      for (const n of [1, 2, 5]) {
        const plan = planPacks(b, n, tiers, 3);
        expect(planCost(plan)).toBeLessThanOrEqual(b);
        for (const p of plan) expect(p.length).toBeLessThanOrEqual(3);
      }
    }
    expect(planCost(planPacks(100_000, 5, tiers, 3))).toBe(1500);
  });

  it('splits by weight exactly', () => {
    const parts = splitByWeight(2_000_000_001n, [0.3, 0.25, 0.2, 0.15, 0.1]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(2_000_000_001n);
    expect(parts[1]).toBe(500_000_000n);
  });
});
