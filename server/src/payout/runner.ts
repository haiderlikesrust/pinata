// Resumable payout pipeline. Every transaction is written to the database
// (signed, with its signature) BEFORE it is sent, and every result is written
// once it lands. Running this again for the same round picks up where it
// stopped and never pays anything twice.

import type { PackResult, RoundSummary, WinnerPublic } from '@pinata/shared';
import type { Db } from '../db';
import { planCost, planPacks, splitByWeight, splitPot, type SplitPct } from '../engine/allocation';
import { assignWeights, pickWinners, rankCandidates, type Winner } from '../engine/winners';
import type { Chain, Prepared, StepArgs, StepKind, StepResult } from './chain';
import { MICRO } from './chain';

export interface PayoutCfg {
  split: SplitPct;
  weights: number[];
  packTiers: number[];
  maxPacksPerWinner: number;
  minBuyUsd: number;
  blocklist: string[];
  /** SOL sent to the pack wallet per pack to cover its network fees. */
  packGasLamports?: bigint;
  maxAttempts?: number;
  backoffMs?: number;
  pollMs?: number;
  pendingTimeoutMs?: number;
}

export interface RunnerDeps {
  db: Db;
  chain: Chain;
  cfg: PayoutCfg;
  onUpdate?: (s: RoundSummary) => void;
  /** True once the server is shutting down: no new step may start. */
  shouldStop?: () => boolean;
  log?: (msg: string) => void;
}

/** Every attempt definitely did not land. Safe to give up on this step. */
export class StepFailed extends Error {}
/** The server is shutting down. The next server resumes from the database. */
export class Stopped extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USDC = 1_000_000n;

export async function runPayout(d: RunnerDeps, roundId: number): Promise<RoundSummary> {
  const { db, chain, cfg } = d;
  const log = d.log ?? (() => {});
  const maxAttempts = cfg.maxAttempts ?? 3;
  const backoff = cfg.backoffMs ?? 1500;
  const pollMs = cfg.pollMs ?? 1500;
  const pendingTimeout = cfg.pendingTimeoutMs ?? 180_000;
  const k = (name: string) => `r${roundId}:${name}`;

  const round = db.round(roundId);
  if (!round || !round.summary) throw new Error(`round ${roundId} has not ended`);
  const summary: RoundSummary = round.summary;
  let attention: string | null = null;
  const flag = (why: string) => {
    attention ??= why;
    log(`[payout r${roundId}] needs attention: ${why}`);
  };
  const publish = () => {
    // A delivered pack counts at the card's insured value when known, otherwise at what it cost.
    // Packs paid out as USDC are already inside the USDC figure.
    for (const w of summary.winners) {
      const packs = w.packs.reduce((a, p) => a + (p.status === 'delivered' ? (p.insuredValue ?? p.tier) : 0), 0);
      w.totalUsd = Math.round((packs + (w.usdc ?? 0) + (w.tokensUsd ?? 0)) * 100) / 100;
    }
    db.saveSummary(roundId, summary, attention);
    d.onUpdate?.(summary);
  };

  /** Runs once, remembers the answer. For decisions, not transactions. */
  const halt = () => {
    if (d.shouldStop?.()) throw new Stopped('shutting down');
  };

  async function memo<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const row = db.step(k(name));
    if (row?.status === 'done') return row.result as T;
    halt();
    const result = await fn();
    db.putStep({ key: k(name), round: roundId, kind: 'memo', args: null, sig: null, blockhash: null, raw: null, extra: null, status: 'done', result, attempts: 1 });
    return result;
  }

  async function waitStatus(sig: string, blockhash: string) {
    const until = Date.now() + pendingTimeout;
    for (;;) {
      const st = await chain.status(sig, blockhash);
      if (st !== 'pending') return st;
      if (Date.now() > until) throw new Error(`transaction ${sig} still pending after ${pendingTimeout}ms`);
      await sleep(pollMs);
    }
  }

  /** Runs one on-chain step exactly once. */
  async function tx<K extends StepKind>(name: string, kind: K, args: StepArgs[K]): Promise<StepResult[K]> {
    const key = k(name);
    let row = db.step(key);
    if (row?.status === 'done') return row.result as StepResult[K];
    // A step left void by an earlier run gets a fresh set of attempts.
    let attempts = row?.status === 'sent' ? row.attempts : 0;
    let lastWhy = 'unknown';

    // Found mid-flight after a restart: resend the exact same signed bytes.
    if (row?.status === 'sent' && row.sig && row.raw) {
      await chain.broadcast(kind, { sig: row.sig, blockhash: row.blockhash!, raw: row.raw, extra: row.extra }).catch(() => {});
    }

    for (;;) {
      halt();
      if (!row || row.status === 'void') {
        if (attempts >= maxAttempts) throw new StepFailed(`${key}: ${lastWhy}`);
        attempts++;
        let p: Prepared | null;
        try {
          p = await chain.prepare(kind, args, roundId);
        } catch (e) {
          lastWhy = `prepare failed: ${(e as Error).message}`;
          log(`[payout r${roundId}] ${key} ${lastWhy}`);
          row = { key, round: roundId, kind, args, sig: null, blockhash: null, raw: null, extra: null, status: 'void', result: null, attempts };
          db.putStep(row);
          await sleep(backoff * attempts);
          continue;
        }
        if (!p) {
          const result = { skipped: true } as unknown as StepResult[K];
          db.putStep({ key, round: roundId, kind, args, sig: null, blockhash: null, raw: null, extra: null, status: 'done', result, attempts });
          return result;
        }
        row = { key, round: roundId, kind, args, sig: p.sig, blockhash: p.blockhash, raw: p.raw, extra: p.extra ?? null, status: 'sent', result: null, attempts };
        db.putStep(row); // saved before it is sent
        await chain.broadcast(kind, p).catch((e) => log(`[payout r${roundId}] ${key} broadcast error: ${(e as Error).message}`));
      }

      const st = await waitStatus(row.sig!, row.blockhash!);
      if (st === 'landed') {
        const result = await chain.outcome(kind, row.sig!, args, row.extra);
        db.putStep({ ...row, status: 'done', result });
        return result;
      }
      lastWhy = st;
      log(`[payout r${roundId}] ${key} ${st} (attempt ${attempts}/${maxAttempts})`);
      row = { ...row, status: 'void' };
      db.putStep(row);
      await sleep(backoff * attempts);
    }
  }

  try {
    // 1. Final winners: re-rank from the ledger and apply the hold rule.
    const excluded = new Set([...cfg.blocklist, ...chain.ownWallets()]);
    const winners = await memo<Winner[]>('winners', async () => {
      const ranked = rankCandidates(db.roundTrades(roundId), { minBuyUsd: cfg.minBuyUsd, excluded, breakerSig: round.breakerSig });
      const picked = await pickWinners(
        ranked,
        async (c) => (await chain.isOrdinaryWallet(c.wallet)) && (await chain.holds(c.wallet, c.tokens * 0.99)),
        cfg.weights.length,
      );
      return assignWeights(picked, cfg.weights, round.armoredBreak);
    });
    summary.provisional = false;
    summary.winners = winners.map<WinnerPublic>((w) => {
      const prev = summary.winners.find((x) => x.wallet === w.wallet);
      return {
        wallet: w.wallet,
        role: w.role,
        rank: w.rank,
        weight: w.weight,
        buyUsd: w.usd,
        buySig: w.sig,
        packs: prev?.packs ?? [],
        usdc: prev?.usdc ?? null,
        usdcSig: prev?.usdcSig,
        tokens: prev?.tokens ?? null,
        tokenSig: prev?.tokenSig,
        tokensUsd: prev?.tokensUsd ?? null,
      };
    });
    summary.breaker = winners.find((w) => w.role === 'breaker')?.wallet ?? summary.breaker;
    publish();

    if (winners.length === 0) {
      log(`[payout r${roundId}] no eligible winners, pot rolls over`);
      summary.potUsd = 0;
      summary.status = 'paid';
      publish();
      return summary;
    }
    const weights = winners.map((w) => w.weight);

    // 2. Claim creator fees.
    // A failed claim or fee swap must not hold up the payout: whatever USDC is already in the
    // wallet is still paid, and the fees stay put for the next round.
    try {
      const claimRow = await tx('claim', 'claim', {});
      if (!claimRow.skipped) summary.claimSig = db.step(k('claim'))?.sig ?? undefined;
    } catch (e) {
      if (!(e instanceof StepFailed)) throw e;
      flag('creator fees could not be claimed this round; they stay in the vault for the next one');
    }

    // 3. Turn every fee token in the wallet into USDC.
    try {
      await tx('swap-fees', 'swapFees', {});
    } catch (e) {
      if (!(e instanceof StepFailed)) throw e;
      flag('fees could not be swapped to USDC this round; they stay in the wallet for the next one');
    }

    // 4. The pot is the USDC in the wallet, whoever sent it. Measured once, before anything is spent.
    const pot = await memo('pot', async () => ({ usdc: await chain.potUsdc() }));
    summary.potUsd = Number(pot.usdc) / MICRO;
    publish();
    if (pot.usdc <= 0n) {
      // An empty pot is only "paid" if nothing went wrong on the way to finding it empty.
      summary.status = attention ? 'attention' : 'paid';
      publish();
      return summary;
    }

    // 5. Split and choose packs.
    const plan = await memo('plan', async () => {
      const split = splitPot(pot.usdc, cfg.split);
      const tiers = await chain.packTiers(cfg.packTiers).catch(() => [] as number[]);
      return { split, packs: planPacks(Number(split.packs) / MICRO, winners.length, tiers, cfg.maxPacksPerWinner) };
    });
    const packs = plan.packs.map((p) => [...p]);
    const packCost = BigInt(planCost(packs)) * USDC;
    const packCount = packs.reduce((a, p) => a + p.length, 0);
    winners.forEach((_w, i) => {
      if (summary.winners[i]!.packs.length === 0) summary.winners[i]!.packs = packs[i]!.map<PackResult>((tier) => ({ tier, status: 'pending' }));
    });
    publish();

    // 6. Packs, from a throwaway wallet holding exactly the pack budget.
    const fallback = winners.map(() => 0n);
    let swept = 0n;
    if (packCost > 0n) {
      const packWallet = await memo('pack-wallet', () => chain.packWallet(roundId));
      await tx('fund-pack', 'fundPack', { packWallet, usdc: packCost, lamports: (cfg.packGasLamports ?? 10_000_000n) * BigInt(packCount) });
      for (let i = 0; i < winners.length; i++) {
        for (let j = 0; j < packs[i]!.length; j++) {
          const tier = packs[i]![j]!;
          const name = `pack:${i}:${j}`;
          let res: StepResult['pack'];
          try {
            res = await tx(name, 'pack', { packWallet, to: winners[i]!.wallet, tier });
          } catch (e) {
            if (!(e instanceof StepFailed)) throw e;
            // Never landed, so the money is still in the pack wallet. Record the
            // failure as final so a later retry cannot deliver a pack on top of the USDC.
            res = { ok: false, reason: e.message };
            db.putStep({ key: k(name), round: roundId, kind: 'pack', args: null, sig: null, blockhash: null, raw: null, extra: null, status: 'done', result: res, attempts: maxAttempts });
          }
          const slot = summary.winners[i]!.packs[j]!;
          slot.sig = db.step(k(name))?.sig ?? undefined;
          if (res.ok) {
            slot.status = 'delivered';
            slot.nft = res.nft;
            slot.rarity = res.rarity;
            slot.name = res.name;
            slot.image = res.image;
            slot.insuredValue = res.insuredValue;
          } else if (res.spent) {
            slot.status = 'failed';
            flag(`pack for ${winners[i]!.wallet} was paid but could not be opened: ${res.reason ?? ''}`);
          } else {
            slot.status = 'paid_usdc';
            fallback[i] = fallback[i]! + BigInt(tier) * USDC;
          }
          publish();
        }
      }
      const sweep = await tx('sweep-pack', 'sweepPack', { packWallet });
      swept = sweep.skipped ? 0n : sweep.usdc;
    }

    // 7. USDC: weighted share plus the value of any pack that could not be bought.
    const fallbackTotal = fallback.reduce((a, b) => a + b, 0n);
    // Whatever the pack bucket did not spend goes out as USDC too.
    let distributable = plan.split.packs + plan.split.usdc - packCost + swept;
    if (distributable < fallbackTotal) {
      flag('less USDC came back from the pack wallet than expected');
      distributable = distributable < 0n ? 0n : distributable;
    }
    const pool = distributable > fallbackTotal ? distributable - fallbackTotal : 0n;
    const usdcShares = splitByWeight(pool, weights);
    for (let i = 0; i < winners.length; i++) {
      const amount = usdcShares[i]! + (distributable >= fallbackTotal ? fallback[i]! : 0n);
      if (amount <= 0n) continue;
      try {
        await tx(`usdc:${i}`, 'sendUsdc', { to: winners[i]!.wallet, amount });
        summary.winners[i]!.usdc = Number(amount) / 1e6;
        summary.winners[i]!.usdcSig = db.step(k(`usdc:${i}`))?.sig ?? undefined;
      } catch (e) {
        if (!(e instanceof StepFailed)) throw e;
        flag(`USDC transfer to ${winners[i]!.wallet} failed`);
      }
      publish();
    }

    // 8. Buyback, split up if the pool is thin.
    let bought = 0n;
    let spent = 0n;
    if (plan.split.buyback > 0n) {
      const chunks = await memo('chunks', async () => Math.max(1, Math.min(8, await chain.buybackChunks(plan.split.buyback))));
      const parts = splitByWeight(plan.split.buyback, Array(chunks).fill(1));
      for (let c = 0; c < parts.length; c++) {
        try {
          bought += (await tx(`buyback:${c}`, 'swapToken', { usdc: parts[c]! })).out;
          spent += parts[c]!;
        } catch (e) {
          if (!(e instanceof StepFailed)) throw e;
          flag(`buyback part ${c + 1}/${parts.length} failed`);
        }
      }
    }

    // 9. Send the bought tokens.
    const tokenShares = splitByWeight(bought, weights);
    for (let i = 0; i < winners.length; i++) {
      const amount = tokenShares[i]!;
      if (amount <= 0n) continue;
      try {
        await tx(`token:${i}`, 'sendToken', { to: winners[i]!.wallet, amount });
        summary.winners[i]!.tokens = Number(amount) / 10 ** chain.tokenDecimals;
        summary.winners[i]!.tokensUsd = bought > 0n ? ((Number(spent) / MICRO) * Number(amount)) / Number(bought) : 0;
        summary.winners[i]!.tokenSig = db.step(k(`token:${i}`))?.sig ?? undefined;
      } catch (e) {
        if (!(e instanceof StepFailed)) throw e;
        flag(`token transfer to ${winners[i]!.wallet} failed`);
      }
      publish();
    }

    summary.status = attention ? 'attention' : 'paid';
    publish();
    return summary;
  } catch (e) {
    if (e instanceof Stopped) return summary; // left as "paying": the next server picks it up
    flag((e as Error).message);
    summary.status = 'attention';
    publish();
    return summary;
  }
}
