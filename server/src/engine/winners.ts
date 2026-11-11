// Pure winner selection.

import type { Side } from '@pinata/shared';

export interface RoundTrade {
  sig: string;
  seq: number;
  wallet: string;
  side: Side;
  usd: number;
  tokens: number;
}

export interface Candidate {
  wallet: string;
  sig: string;
  usd: number;
  tokens: number;
  seq: number;
}

export interface Winner extends Candidate {
  role: 'breaker' | 'top';
  rank: number;
  weight: number;
}

export interface RankOpts {
  minBuyUsd: number;
  excluded: Set<string>;
  breakerSig?: string | null;
}

/**
 * Orders everyone who could win. The breaker comes from the breaking trade
 * itself; the rest are each wallet's biggest single qualifying buy, biggest
 * first. Wallets that sold during the round are out of the "biggest buy" slots.
 */
export function rankCandidates(trades: RoundTrade[], opts: RankOpts): { breaker: Candidate | null; others: Candidate[] } {
  const sellers = new Set<string>();
  const best = new Map<string, Candidate>();
  let breaker: Candidate | null = null;

  for (const t of trades) {
    if (t.side === 'sell') {
      sellers.add(t.wallet);
      continue;
    }
    if (opts.excluded.has(t.wallet) || t.usd < opts.minBuyUsd) continue;
    const c: Candidate = { wallet: t.wallet, sig: t.sig, usd: t.usd, tokens: t.tokens, seq: t.seq };
    if (opts.breakerSig && t.sig === opts.breakerSig) breaker = c;
    const cur = best.get(t.wallet);
    if (!cur || c.usd > cur.usd) best.set(t.wallet, c);
  }

  const others = [...best.values()]
    .filter((c) => c.wallet !== breaker?.wallet && !sellers.has(c.wallet))
    .sort((a, b) => b.usd - a.usd || a.seq - b.seq);

  return { breaker, others };
}

/**
 * Takes candidates in order until `max` pass the eligibility check
 * (still holding, ordinary wallet). The check is async because it hits the chain.
 */
export async function pickWinners(
  ranked: { breaker: Candidate | null; others: Candidate[] },
  eligible: (c: Candidate) => Promise<boolean>,
  max = 5,
): Promise<{ breaker: Candidate | null; others: Candidate[] }> {
  const breaker = ranked.breaker && (await eligible(ranked.breaker)) ? ranked.breaker : null;
  const slots = max - (breaker ? 1 : 0);
  const others: Candidate[] = [];
  for (const c of ranked.others) {
    if (others.length >= slots) break;
    if (await eligible(c)) others.push(c);
  }
  return { breaker, others };
}

/**
 * Weights are listed breaker-first. If the break came out of the armored state
 * (or there is no eligible breaker) everyone is simply ranked by buy size.
 */
export function assignWeights(
  picked: { breaker: Candidate | null; others: Candidate[] },
  weights: number[],
  armoredBreak: boolean,
): Winner[] {
  type Slot = { c: Candidate; role: 'breaker' | 'top' };
  const tops: Slot[] = picked.others.map((c) => ({ c, role: 'top' }));
  let ordered: Slot[];
  if (picked.breaker && !armoredBreak) {
    ordered = [{ c: picked.breaker, role: 'breaker' }, ...tops];
  } else {
    if (picked.breaker) tops.push({ c: picked.breaker, role: 'breaker' });
    ordered = tops.sort((a, b) => b.c.usd - a.c.usd || a.c.seq - b.c.seq);
  }
  const used = weights.slice(0, ordered.length);
  const total = used.reduce((a, b) => a + b, 0) || 1;
  return ordered.map(({ c, role }, i) => ({ ...c, role, rank: i + 1, weight: (used[i] ?? 0) / total }));
}
