// The game coordinator: turns trades into HP changes, decides when the piñata
// breaks, starts payouts and new rounds, and tells the site what happened.

import type { LeaderEntry, Phase, PublicState, RoundSummary, ServerEvent, Side, TradeMsg, WinnerPublic } from '@pinata/shared';
import type { Config } from './config';
import type { Db, RoundRow, TradeRow } from './db';
import { applyDecay, applyTrade, newHp, type Hp } from './engine/pinata';
import { assignWeights, rankCandidates } from './engine/winners';
import type { Chain } from './payout/chain';
import { MICRO } from './payout/chain';
import { runPayout } from './payout/runner';

export interface IncomingTrade {
  sig: string;
  slot: number;
  wallet: string;
  side: Side;
  /** Size of the trade in the coin's quote asset ($CARDS or SOL). */
  quote: number;
  tokens: number;
  ts: number;
}

export interface GameDeps {
  cfg: Config;
  db: Db;
  chain: Chain;
  /** USD price of one unit of the quote asset. */
  quoteUsd: () => number;
  broadcast: (e: ServerEvent) => void;
  log?: (msg: string) => void;
  onRoundStart?: (round: number) => void;
}

const FEED_LEN = 40;
const PROVISIONAL_TTL = 120_000;

export class Game {
  private round!: RoundRow;
  private hp!: Hp;
  private trades: TradeRow[] = [];
  private phase: Phase = 'alive';
  private buffer: IncomingTrade[] = [];
  private nextRoundAt: number | null = null;
  private feed: TradeMsg[] = [];
  private potMicro = 0n;
  private provisional = new Map<string, { t: IncomingTrade; usd: number; at: number }>();
  private lastSummary: RoundSummary | null = null;
  private payQueue: Promise<unknown> = Promise.resolve();
  private timers: NodeJS.Timeout[] = [];
  private lastPotAt = 0;
  private lastStateAt = 0;
  private maxHpUsd: number;
  private stopped = false;
  private readonly log: (msg: string) => void;

  constructor(private readonly d: GameDeps) {
    this.log = d.log ?? (() => {});
    this.maxHpUsd = d.db.get<number>('maxHpUsd') ?? d.cfg.maxHpUsd;
  }

  async init() {
    const { db } = this.d;
    this.lastSummary = db.history(1)[0] ?? null;
    await this.refreshPot();
    const active = db.activeRound();
    if (active) {
      this.round = active;
      this.hp = active.hp;
      this.trades = db.roundTrades(active.id);
      this.feed = this.trades.slice(-FEED_LEN).map(toMsg).reverse();
      this.log(`resumed round ${active.id} at ${this.hp.hp.toFixed(0)}/${this.hp.maxHp} HP`);
      // The server stopped while the breaking trade was still being confirmed: confirm it now.
      const last = [...this.trades].reverse().find((t) => t.side === 'buy');
      if (this.hp.hp <= 0 && last) void this.crack(last, { ...this.hp, hp: 1 }, false);
    } else {
      this.startRound();
    }
    // Finish any payout that was interrupted.
    for (const r of db.roundsByStatus('paying')) this.queuePayout(r.id);
    this.timers.push(setInterval(() => void this.tick(), 1000));
  }

  /** Stops the clock and lets no new payout step begin. */
  stop() {
    this.stopped = true;
    this.timers.forEach((t) => clearInterval(t));
  }

  /** Resolves when the payout step in flight (if any) has finished. */
  idle(): Promise<unknown> {
    return this.payQueue;
  }

  // ---------- trades ----------

  private excludedFromHp(wallet: string) {
    return this.d.chain.ownWallets().includes(wallet);
  }

  /** A trade from the source of truth (RPC ledger, or the simulator in dry-run). */
  ingest(t: IncomingTrade) {
    if (this.stopped) return;
    if (this.d.db.hasTrade(t.sig) || this.buffer.some((b) => b.sig === t.sig)) return;
    if (this.excludedFromHp(t.wallet) || !(t.quote > 0)) return;
    if (this.phase !== 'alive') {
      this.buffer.push(t); // counts toward the next piñata
      return;
    }
    this.apply(t);
  }

  /** A trade seen on the fast websocket. Animates immediately, decides nothing. */
  ingestProvisional(t: IncomingTrade) {
    if (this.stopped) return;
    if (this.phase !== 'alive' || this.provisional.has(t.sig) || this.d.db.hasTrade(t.sig)) return;
    if (this.excludedFromHp(t.wallet) || !(t.quote > 0)) return;
    const usd = t.quote * this.d.quoteUsd();
    const before = this.displayHp();
    this.provisional.set(t.sig, { t, usd, at: Date.now() });
    const after = this.displayHp();
    const msg: TradeMsg = { sig: t.sig, wallet: t.wallet, side: t.side, usd, ts: t.ts };
    this.pushFeed(msg);
    this.d.broadcast({ type: 'trade', trade: msg, amount: Math.abs(after - before), hp: after, maxHp: this.hp.maxHp, armored: this.hp.armored, confirmed: false });
  }

  private apply(t: IncomingTrade) {
    const { db, cfg } = this.d;
    const usd = t.quote * this.d.quoteUsd();
    const prev = this.hp;
    const { next, effect } = applyTrade(prev, { side: t.side, usd, ts: t.ts }, this.potUsd(), cfg.engine);
    const row: TradeRow = { ...t, round: this.round.id, seq: db.nextSeq(), usd };
    db.tx(() => {
      db.insertTrade(row);
      db.saveHp(this.round.id, next);
    });
    this.hp = next;
    this.trades.push(row);
    const wasShown = this.provisional.delete(t.sig);
    const msg = toMsg(row);
    if (!wasShown) this.pushFeed(msg);
    this.d.broadcast({ type: 'trade', trade: msg, amount: effect.amount, hp: this.displayHp(), maxHp: next.maxHp, armored: next.armored, confirmed: true });
    if (effect.broke) void this.crack(row, prev, effect.armoredBreak);
  }

  private pushFeed(m: TradeMsg) {
    this.feed.unshift(m);
    if (this.feed.length > FEED_LEN) this.feed.length = FEED_LEN;
  }

  /** Confirmed HP with not-yet-confirmed websocket trades layered on top. They can never break it. */
  private displayHp(): number {
    let h = this.hp.hp;
    if (h <= 0) return 0;
    for (const { t, usd } of this.provisional.values()) {
      h = t.side === 'buy' ? Math.max(1, h - usd) : Math.min(this.hp.maxHp, h + usd * this.d.cfg.engine.sellHealFactor);
    }
    return h;
  }

  // ---------- break ----------

  private async crack(row: TradeRow, prev: Hp, armoredBreak: boolean) {
    const { db, chain } = this.d;
    this.phase = 'cracking';
    this.provisional.clear();
    this.d.broadcast({ type: 'state', state: this.publicState() });
    let final = false;
    try {
      final = await chain.waitFinalized(row.sig);
    } catch (e) {
      this.log(`could not confirm the breaking trade: ${(e as Error).message}`);
    }
    if (!final) {
      // The breaking trade was dropped by the network: undo it and carry on.
      this.log(`breaking trade ${row.sig} was dropped, restoring the piñata`);
      db.tx(() => {
        db.deleteTrade(row.sig);
        db.saveHp(this.round.id, prev);
      });
      this.hp = prev;
      this.trades = this.trades.filter((x) => x.sig !== row.sig);
      this.phase = 'alive';
      this.d.broadcast({ type: 'state', state: this.publicState() });
      this.flushBuffer();
      return;
    }
    this.doBreak(row, armoredBreak);
  }

  private doBreak(row: TradeRow, armoredBreak: boolean) {
    const { db, cfg } = this.d;
    const now = Date.now();
    this.phase = 'broken';
    const ranked = rankCandidates(this.trades, { minBuyUsd: cfg.engine.minBuyUsd, excluded: this.excluded(), breakerSig: row.sig });
    const slots = cfg.weights.length - (ranked.breaker ? 1 : 0);
    const prov = assignWeights({ breaker: ranked.breaker, others: ranked.others.slice(0, slots) }, cfg.weights, armoredBreak);
    const potUsd = this.potUsd();
    const summary: RoundSummary = {
      round: this.round.id,
      startedAt: this.round.startedAt,
      endedAt: now,
      maxHp: this.hp.maxHp,
      potUsd,
      breaker: ranked.breaker?.wallet ?? row.wallet,
      status: 'paying',
      provisional: true,
      winners: prov.map<WinnerPublic>((w) => ({ wallet: w.wallet, role: w.role, rank: w.rank, weight: w.weight, buyUsd: w.usd, buySig: w.sig, packs: [], usdc: null, tokens: null })),
    };
    db.endRound(this.round.id, now, row.sig, armoredBreak, summary);
    this.lastSummary = summary;
    this.nextRoundAt = now + cfg.nextRoundDelayMs;
    this.log(`round ${this.round.id} BROKEN by ${row.wallet} — pot ≈ $${potUsd.toFixed(2)}`);
    this.d.broadcast({ type: 'break', summary, state: this.publicState() });

    const id = this.round.id;
    this.timers.push(setTimeout(() => this.startRound(), cfg.nextRoundDelayMs));
    this.timers.push(setTimeout(() => this.queuePayout(id), cfg.holdWindowMs));
  }

  queuePayout(roundId: number) {
    const { cfg, db, chain } = this.d;
    this.payQueue = this.payQueue
      .then(() =>
        runPayout(
          {
            db,
            chain,
            log: this.log,
            shouldStop: () => this.stopped,
            cfg: {
              split: cfg.split,
              weights: cfg.weights,
              packTiers: cfg.packTiers,
              maxPacksPerWinner: cfg.maxPacksPerWinner,
              minBuyUsd: cfg.engine.minBuyUsd,
              blocklist: cfg.blocklist,
            },
            onUpdate: (s) => {
              if (!this.lastSummary || s.round >= this.lastSummary.round) this.lastSummary = s;
              this.d.broadcast({ type: 'payout', summary: s });
            },
          },
          roundId,
        ),
      )
      .then((s) => {
        this.log(`round ${roundId} payout ${s.status}`);
        return this.refreshPot();
      })
      .catch((e) => this.log(`payout for round ${roundId} crashed: ${(e as Error).message}`));
    return this.payQueue;
  }

  private startRound() {
    if (this.stopped) return;
    const now = Date.now();
    this.hp = newHp(this.maxHpUsd, now);
    this.round = this.d.db.createRound(this.hp);
    this.trades = [];
    this.provisional.clear();
    this.phase = 'alive';
    this.nextRoundAt = null;
    this.d.onRoundStart?.(this.round.id);
    this.log(`round ${this.round.id} started with ${this.hp.maxHp} HP`);
    this.d.broadcast({ type: 'round', state: this.publicState() });
    this.flushBuffer();
  }

  private flushBuffer() {
    const buf = this.buffer;
    this.buffer = [];
    for (const t of buf) this.ingest(t);
  }

  // ---------- housekeeping ----------

  private async tick() {
    const now = Date.now();
    if (this.phase === 'alive') {
      const decayed = applyDecay(this.hp, now, this.d.cfg.engine);
      if (decayed.hp !== this.hp.hp) {
        this.hp = decayed;
        this.d.db.saveHp(this.round.id, decayed);
      }
    }
    for (const [sig, p] of this.provisional) if (now - p.at > PROVISIONAL_TTL) this.provisional.delete(sig);
    const potEvery = this.d.cfg.mode === 'dry' ? 2000 : 20_000;
    if (now - this.lastPotAt >= potEvery) await this.refreshPot();
    if (now - this.lastStateAt >= 4000) {
      this.lastStateAt = now;
      this.d.broadcast({ type: 'state', state: this.publicState() });
    }
  }

  private async refreshPot() {
    this.lastPotAt = Date.now();
    try {
      this.potMicro = await this.d.chain.poolEstimateUsdc();
    } catch (e) {
      this.log(`pot refresh failed: ${(e as Error).message}`);
    }
  }

  private potUsd() {
    return Number(this.potMicro) / MICRO;
  }

  private excluded() {
    return new Set([...this.d.cfg.blocklist, ...this.d.chain.ownWallets()]);
  }

  // ---------- admin ----------

  setMaxHp(usd: number) {
    this.maxHpUsd = usd;
    this.d.db.set('maxHpUsd', usd);
  }

  adminStatus() {
    return {
      round: this.round.id,
      phase: this.phase,
      hp: this.hp,
      nextMaxHp: this.maxHpUsd,
      trades: this.trades.length,
      buffered: this.buffer.length,
      potUsd: this.potUsd(),
      attention: this.d.db.roundsByStatus('attention').map((r) => ({ round: r.id, error: r.error, steps: this.d.db.roundSteps(r.id).map((s) => ({ key: s.key, status: s.status, sig: s.sig, attempts: s.attempts })) })),
    };
  }

  /** Dry-run only: how much a buy would need to be to finish the piñata right now. */
  hpLeft() {
    return this.hp.hp;
  }

  // ---------- public ----------

  publicState(): PublicState {
    const { cfg } = this.d;
    const ranked = this.phase === 'alive' || this.phase === 'cracking' ? rankCandidates(this.trades, { minBuyUsd: cfg.engine.minBuyUsd, excluded: this.excluded() }) : { others: [] };
    const leaderboard: LeaderEntry[] = ranked.others.slice(0, 5).map((c) => ({ wallet: c.wallet, usd: c.usd, sig: c.sig }));
    return {
      mode: cfg.mode,
      mint: cfg.mint ?? null,
      symbol: cfg.symbol,
      xUrl: cfg.xUrl ?? null,
      round: this.round.id,
      phase: this.phase,
      hp: this.displayHp(),
      maxHp: this.hp.maxHp,
      armored: this.hp.armored,
      potUsd: this.potUsd(),
      feeSymbol: cfg.quoteSymbol,
      startedAt: this.round.startedAt,
      nextRoundAt: this.nextRoundAt,
      split: cfg.split,
      weights: cfg.weights,
      minBuyUsd: cfg.engine.minBuyUsd,
      minPotUsd: cfg.engine.minPotUsd,
      leaderboard,
      feed: this.feed,
      lastRound: this.lastSummary,
      serverTime: Date.now(),
    };
  }
}

function toMsg(t: TradeRow): TradeMsg {
  return { sig: t.sig, wallet: t.wallet, side: t.side, usd: t.usd, ts: t.ts };
}
