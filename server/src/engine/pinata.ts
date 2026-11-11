// Pure HP rules. No I/O, no clocks: time and pot size are passed in.

import type { Side } from '@pinata/shared';

export interface EngineCfg {
  sellHealFactor: number;
  minBuyUsd: number;
  minPotUsd: number;
  decayAfterMs: number;
  /** Percent of max HP lost per hour once decay has started. */
  decayPctPerHour: number;
}

export interface Hp {
  hp: number;
  maxHp: number;
  /** True while the piñata is held at 1 HP only because the pot is too small. */
  armored: boolean;
  startedAt: number;
  /** Time up to which decay has already been applied. */
  decayAt: number;
}

export interface Effect {
  kind: 'hit' | 'heal';
  /** HP actually removed or restored. */
  amount: number;
  broke: boolean;
  /** The break came out of the armored state, so the breaker gets no bonus. */
  armoredBreak: boolean;
}

export function newHp(maxHp: number, now: number): Hp {
  return { hp: maxHp, maxHp, armored: false, startedAt: now, decayAt: now };
}

/** Time decay weakens the piñata but can never break it on its own. */
export function applyDecay(s: Hp, now: number, cfg: EngineCfg): Hp {
  const decayStart = s.startedAt + cfg.decayAfterMs;
  const from = Math.max(s.decayAt, decayStart);
  if (now <= from || cfg.decayPctPerHour <= 0) return now > s.decayAt ? { ...s, decayAt: now } : s;
  const hours = (now - from) / 3_600_000;
  const loss = s.maxHp * (cfg.decayPctPerHour / 100) * hours;
  return { ...s, hp: Math.max(1, s.hp - loss), decayAt: now };
}

export function applyTrade(
  state: Hp,
  trade: { side: Side; usd: number; ts: number },
  potUsd: number,
  cfg: EngineCfg,
): { next: Hp; effect: Effect } {
  const s = applyDecay(state, trade.ts, cfg);
  const usd = Math.max(0, trade.usd);

  if (trade.side === 'sell') {
    const heal = Math.min(usd * cfg.sellHealFactor, s.maxHp - s.hp);
    return {
      next: { ...s, hp: s.hp + heal, armored: heal > 0 ? false : s.armored },
      effect: { kind: 'heal', amount: heal, broke: false, armoredBreak: false },
    };
  }

  const raw = s.hp - usd;
  if (raw >= 1) {
    return { next: { ...s, hp: raw }, effect: { kind: 'hit', amount: usd, broke: false, armoredBreak: false } };
  }

  // This buy would finish it.
  const floored = Math.min(s.hp, 1);
  if (usd < cfg.minBuyUsd) {
    return {
      next: { ...s, hp: floored },
      effect: { kind: 'hit', amount: s.hp - floored, broke: false, armoredBreak: false },
    };
  }
  if (potUsd < cfg.minPotUsd) {
    return {
      next: { ...s, hp: floored, armored: true },
      effect: { kind: 'hit', amount: s.hp - floored, broke: false, armoredBreak: false },
    };
  }
  return {
    next: { ...s, hp: 0, armored: false },
    effect: { kind: 'hit', amount: s.hp, broke: true, armoredBreak: s.armored },
  };
}
