// Pure reward maths: pot split, pack tiers, weighted shares.

export interface SplitPct {
  packs: number;
  buyback: number;
  usdc: number;
}

/** Splits lamports into the three buckets. Rounding dust goes to USDC. */
export function splitPot(lamports: bigint, pct: SplitPct): { packs: bigint; buyback: bigint; usdc: bigint } {
  const total = pct.packs + pct.buyback + pct.usdc;
  if (lamports <= 0n || total <= 0) return { packs: 0n, buyback: 0n, usdc: 0n };
  const part = (p: number) => (lamports * BigInt(Math.round(p * 1000))) / BigInt(Math.round(total * 1000));
  const packs = part(pct.packs);
  const buyback = part(pct.buyback);
  return { packs, buyback, usdc: lamports - packs - buyback };
}

/**
 * Decides which packs each winner gets (winners are in rank order).
 *  1. If everyone can get a pack, everyone gets the biggest tier that fits,
 *     then leftovers upgrade winners by rank, then add extra top-tier packs.
 *  2. Otherwise the smallest tier goes to as many top ranks as fit.
 * Returns one array of tier prices per winner. Unspent budget stays as USDC.
 */
export function planPacks(budgetUsd: number, winners: number, tiers: number[], maxPerWinner: number): number[][] {
  const plan: number[][] = Array.from({ length: winners }, () => []);
  const sorted = [...new Set(tiers)].filter((t) => t > 0).sort((a, b) => a - b);
  if (winners <= 0 || sorted.length === 0 || maxPerWinner <= 0) return plan;
  const min = sorted[0]!;
  const top = sorted[sorted.length - 1]!;
  let rem = Math.floor(budgetUsd);

  if (rem < winners * min) {
    const k = Math.min(winners, Math.floor(rem / min));
    for (let i = 0; i < k; i++) plan[i]!.push(min);
    return plan;
  }

  const uniform = [...sorted].reverse().find((t) => winners * t <= rem)!;
  for (const p of plan) p.push(uniform);
  rem -= winners * uniform;

  // Upgrade single packs by rank.
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of plan) {
      const cur = p[0]!;
      const next = sorted[sorted.indexOf(cur) + 1];
      if (next !== undefined && rem >= next - cur) {
        p[0] = next;
        rem -= next - cur;
        changed = true;
      }
    }
  }

  // Extra packs, biggest affordable tier first, by rank.
  changed = true;
  while (changed) {
    changed = false;
    for (const p of plan) {
      if (p.length >= maxPerWinner || p[0] !== top) continue;
      const tier = [...sorted].reverse().find((t) => t <= rem);
      if (tier === undefined) continue;
      p.push(tier);
      rem -= tier;
      changed = true;
    }
  }
  return plan;
}

export const planCost = (plan: number[][]) => plan.reduce((a, p) => a + p.reduce((x, y) => x + y, 0), 0);

/** Splits an integer amount by weights. Rounding dust goes to the first entry. */
export function splitByWeight(total: bigint, weights: number[]): bigint[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0n || sum <= 0) return weights.map(() => 0n);
  const SCALE = 1_000_000n;
  const out = weights.map((w) => (total * BigInt(Math.round((w / sum) * Number(SCALE)))) / SCALE);
  const used = out.reduce((a, b) => a + b, 0n);
  out[0] = out[0]! + (total - used);
  return out;
}
