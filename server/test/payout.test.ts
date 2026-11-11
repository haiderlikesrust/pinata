import { beforeEach, describe, expect, it } from 'vitest';
import type { RoundSummary } from '@pinata/shared';
import { Db } from '../src/db';
import { newHp } from '../src/engine/pinata';
import { MemChain } from '../src/payout/memChain';
import { runPayout, type PayoutCfg } from '../src/payout/runner';

/** Price of the fee token ($CARDS) in the tests. */
const FEE_USD = 0.2;
const cfg: PayoutCfg = {
  split: { packs: 25, buyback: 25, usdc: 50 },
  weights: [30, 25, 20, 15, 10],
  packTiers: [25, 50, 100],
  maxPacksPerWinner: 3,
  minBuyUsd: 10,
  blocklist: [],
  backoffMs: 1,
  pollMs: 1,
  maxAttempts: 3,
};

let db: Db;
let chain: MemChain;
let roundId: number;

/** A finished round: five buyers, W5 lands the breaking hit. */
function setup(potUsd: number) {
  db = new Db(':memory:');
  chain = new MemChain(() => FEE_USD);
  chain.accrueUsd(potUsd); // creator fees waiting to be claimed, in $CARDS
  const round = db.createRound(newHp(1000, 1));
  roundId = round.id;
  const buys: [string, number][] = [
    ['W1', 400],
    ['W2', 300],
    ['W3', 200],
    ['W4', 100],
    ['W5', 50],
  ];
  buys.forEach(([wallet, usd], i) =>
    db.insertTrade({ sig: `sig${i + 1}`, round: roundId, seq: i + 1, slot: i + 1, wallet, side: 'buy', quote: usd / FEE_USD, tokens: usd * 1000, usd, ts: i + 1 }),
  );
  const summary: RoundSummary = { round: roundId, startedAt: 1, endedAt: 2, maxHp: 1000, potUsd: null, breaker: 'W5', status: 'paying', provisional: true, winners: [] };
  db.endRound(roundId, 2, 'sig5', false, summary);
}

const run = () => runPayout({ db, chain, cfg }, roundId);
const sum = (m: Map<string, bigint>) => [...m.values()].reduce((a, b) => a + b, 0n);

describe('payout runner', () => {
  beforeEach(() => setup(4000));

  it('pays a $4,000 pot as packs, USDC and tokens with nothing left over', async () => {
    const s = await run();
    expect(s.status).toBe('paid');
    expect(s.provisional).toBe(false);
    // $4,000 of fees, minus the 0.3% it costs to swap them into USDC.
    expect(s.potUsd).toBeCloseTo(3988, 0);
    expect(s.winners.map((w) => w.wallet)).toEqual(['W5', 'W1', 'W2', 'W3', 'W4']);
    expect(s.winners[0]!.role).toBe('breaker');

    // $1,000 pack bucket (minus the slippage margin) -> everyone gets a $100 pack, upgrades by rank.
    expect(chain.paid.packs.length).toBeGreaterThanOrEqual(5);
    for (const w of s.winners) expect(w.packs.every((p) => p.status === 'delivered' && p.nft)).toBe(true);
    const packUsd = chain.paid.packs.reduce((a, p) => a + p.tier, 0);
    expect(packUsd).toBeLessThanOrEqual(1000);
    expect(packUsd).toBeGreaterThanOrEqual(900);

    // Everything that was swapped is paid out.
    expect(chain.usdc).toBe(0n);
    expect(chain.tokens).toBe(0n);
    expect(chain.fees).toBe(0n);
    expect(chain.unclaimed).toBe(0n);
    expect([...chain.packWallets.values()].every((w) => w.usdc === 0n)).toBe(true);

    // Breaker gets 30% of the USDC and of the tokens.
    const usdcTotal = Number(sum(chain.paid.usdc));
    expect(Number(chain.paid.usdc.get('W5')) / usdcTotal).toBeCloseTo(0.3, 3);
    const tokenTotal = Number(sum(chain.paid.tokens));
    expect(Number(chain.paid.tokens.get('W5')) / tokenTotal).toBeCloseTo(0.3, 3);
    expect(Number(chain.paid.tokens.get('W4')) / tokenTotal).toBeCloseTo(0.1, 3);
  });

  it('running it again changes nothing', async () => {
    await run();
    const before = { usdc: sum(chain.paid.usdc), tokens: sum(chain.paid.tokens), packs: chain.paid.packs.length, n: chain.broadcasts };
    const again = await run();
    expect(again.status).toBe('paid');
    expect({ usdc: sum(chain.paid.usdc), tokens: sum(chain.paid.tokens), packs: chain.paid.packs.length, n: chain.broadcasts }).toEqual(before);
  });

  it('survives a crash at every single step without paying twice', async () => {
    // Reference run with no crashes.
    await run();
    const ref = { usdc: new Map(chain.paid.usdc), tokens: new Map(chain.paid.tokens), packs: chain.paid.packs.map((p) => `${p.to}:${p.tier}`).sort(), total: chain.broadcasts };

    for (let crashAt = 1; crashAt <= ref.total; crashAt++) {
      for (const when of ['before-send', 'after-send'] as const) {
        setup(4000);
        let n = 0;
        const realBroadcast = chain.broadcast.bind(chain);
        chain.broadcast = async (kind, p) => {
          n++;
          if (n === crashAt && when === 'before-send') throw new Crash();
          await realBroadcast(kind, p);
          if (n === crashAt && when === 'after-send') throw new Crash();
        };
        // The runner swallows broadcast errors by design, so simulate the process
        // dying by making every later chain call throw too.
        let dead = false;
        const guard = <T extends (...a: any[]) => Promise<any>>(fn: T): T =>
          (async (...a: any[]) => {
            if (dead) throw new Crash();
            try {
              return await fn(...a);
            } catch (e) {
              if (e instanceof Crash) dead = true;
              throw e;
            }
          }) as T;
        chain.broadcast = guard(chain.broadcast);
        chain.status = guard(chain.status.bind(chain));
        chain.prepare = guard(chain.prepare.bind(chain)) as typeof chain.prepare;
        chain.outcome = guard(chain.outcome.bind(chain)) as typeof chain.outcome;

        const first = await run();
        expect(first.status).toBe('attention');

        // "Restart": the chain works again, same database.
        dead = false;
        n = 1e9;
        const second = await run();
        expect(second.status, `crash ${when} #${crashAt}`).toBe('paid');
        expect(chain.paid.usdc, `usdc after crash ${when} #${crashAt}`).toEqual(ref.usdc);
        expect(chain.paid.tokens, `tokens after crash ${when} #${crashAt}`).toEqual(ref.tokens);
        expect(chain.paid.packs.map((p) => `${p.to}:${p.tier}`).sort()).toEqual(ref.packs);
        expect(chain.usdc).toBe(0n);
        expect(chain.tokens).toBe(0n);
      }
    }
  });

  it('retries a transaction that was dropped by the network', async () => {
    let dropped = false;
    chain.hooks.onBroadcast = (kind) => {
      if (kind === 'sendUsdc' && !dropped) {
        dropped = true;
        return 'drop';
      }
    };
    const s = await run();
    expect(s.status).toBe('paid');
    expect(chain.usdc).toBe(0n);
    expect(chain.paid.usdc.size).toBe(5);
  });

  it('pays USDC instead when a pack cannot be bought', async () => {
    chain.hooks.onBroadcast = (kind, args) => (kind === 'pack' && args.to === 'W1' ? 'fail' : undefined);
    const s = await run();
    expect(s.status).toBe('paid');
    const w1 = s.winners.find((w) => w.wallet === 'W1')!;
    expect(w1.packs.every((p) => p.status === 'paid_usdc')).toBe(true);
    expect(chain.paid.packs.some((p) => p.to === 'W1')).toBe(false);
    const missed = BigInt(w1.packs.reduce((a, p) => a + p.tier, 0)) * 1_000_000n;
    const w2 = s.winners.find((w) => w.wallet === 'W2')!;
    // W1 (25%) and W2 (20%): W1's USDC is its share plus the full pack value.
    const pool = sum(chain.paid.usdc) - missed;
    expect(Number(chain.paid.usdc.get('W1')! - missed) / Number(pool)).toBeCloseTo(0.25, 3);
    expect(Number(chain.paid.usdc.get('W2')!) / Number(pool)).toBeCloseTo(0.2, 3);
    expect(w2.packs.every((p) => p.status === 'delivered')).toBe(true);
    expect(chain.usdc).toBe(0n);

    // A later retry must not deliver the pack on top of the USDC.
    chain.hooks.onBroadcast = undefined;
    await run();
    expect(chain.paid.packs.some((p) => p.to === 'W1')).toBe(false);
  });

  it('flags a pack that was paid for but could not be opened', async () => {
    chain.hooks.packResult = (a) => (a.to === 'W2' ? { ok: false, spent: true, reason: 'open timed out' } : undefined);
    const s = await run();
    expect(s.status).toBe('attention');
    expect(s.winners.find((w) => w.wallet === 'W2')!.packs[0]!.status).toBe('failed');
    // Everyone still gets their USDC and tokens.
    expect(chain.paid.usdc.size).toBe(5);
    expect(chain.paid.tokens.size).toBe(5);
  });

  it('passes a slot down when a winner no longer holds', async () => {
    db.insertTrade({ sig: 'sig6', round: roundId, seq: 6, slot: 6, wallet: 'W6', side: 'buy', quote: 100, tokens: 20_000, usd: 20, ts: 6 });
    chain.hooks.holds = (w) => w !== 'W1';
    const s = await run();
    expect(s.winners.map((w) => w.wallet)).toEqual(['W5', 'W2', 'W3', 'W4', 'W6']);
    expect(chain.paid.usdc.has('W1')).toBe(false);
  });

  it('gives small packs only to the top ranks when the pot is small', async () => {
    setup(240); // $60 pack bucket -> two $25 packs
    const s = await run();
    expect(s.status).toBe('paid');
    expect(s.winners.map((w) => w.packs.map((p) => p.tier))).toEqual([[25], [25], [], [], []]);
    expect(chain.usdc).toBe(0n);
  });

  it('counts USDC already in the wallet toward the pot', async () => {
    setup(1000);
    chain.usdc = 500_000_000n; // someone sent $500 straight to the prize wallet
    const s = await run();
    expect(s.status).toBe('paid');
    expect(s.potUsd).toBeCloseTo(500 + 1000 * 0.997, 1);
    expect(chain.usdc).toBe(0n);
    const usdcBucket = [...chain.paid.usdc.values()].reduce((a, b) => a + b, 0n);
    // Half the pot is USDC, plus whatever the pack bucket could not turn into whole packs.
    expect(Number(usdcBucket) / 1e6).toBeGreaterThanOrEqual((s.potUsd ?? 0) * 0.5);
  });

  it('pays out a pot made only of USDC that was sent in', async () => {
    setup(0);
    chain.usdc = 300_000_000n;
    const s = await run();
    expect(s.status).toBe('paid');
    expect(s.potUsd).toBe(300);
    expect(chain.usdc).toBe(0n);
    expect(chain.paid.usdc.size).toBe(5);
  });

  it('does nothing when there is no pot', async () => {
    setup(0);
    const s = await run();
    expect(s.status).toBe('paid');
    expect(chain.broadcasts).toBe(0);
  });
});

class Crash extends Error {}
