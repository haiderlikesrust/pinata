// SQLite persistence (Node's built-in driver, no native build step).

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import type { RoundSummary, Side } from '@pinata/shared';
import type { Hp } from './engine/pinata';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

export interface TradeRow {
  sig: string;
  round: number;
  seq: number;
  slot: number;
  wallet: string;
  side: Side;
  quote: number;
  tokens: number;
  usd: number;
  ts: number;
}

export interface RoundRow {
  id: number;
  startedAt: number;
  endedAt: number | null;
  maxHp: number;
  hp: Hp;
  status: 'active' | 'paying' | 'paid' | 'attention';
  breakerSig: string | null;
  armoredBreak: boolean;
  summary: RoundSummary | null;
  error: string | null;
}

export type StepStatus = 'sent' | 'done' | 'void';

export interface StepRow {
  key: string;
  round: number;
  kind: string;
  args: unknown;
  sig: string | null;
  blockhash: string | null;
  raw: string | null;
  extra: unknown;
  status: StepStatus;
  result: unknown;
  attempts: number;
}

const J = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
const P = <T>(s: string | null): T | null =>
  s == null ? null : (JSON.parse(s, (_k, x) => (typeof x === 'string' && /^-?\d+n$/.test(x) ? BigInt(x.slice(0, -1)) : x)) as T);

export class Db {
  readonly sql: DatabaseSyncT;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.sql = new DatabaseSync(file);
    this.sql.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rounds (
        id INTEGER PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        max_hp REAL NOT NULL,
        hp TEXT NOT NULL,
        status TEXT NOT NULL,
        breaker_sig TEXT,
        armored_break INTEGER NOT NULL DEFAULT 0,
        summary TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS trades (
        sig TEXT PRIMARY KEY,
        round INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        slot INTEGER NOT NULL,
        wallet TEXT NOT NULL,
        side TEXT NOT NULL,
        quote REAL NOT NULL,
        tokens REAL NOT NULL,
        usd REAL NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trades_round ON trades(round, seq);
      CREATE TABLE IF NOT EXISTS steps (
        key TEXT PRIMARY KEY,
        round INTEGER NOT NULL,
        kind TEXT NOT NULL,
        args TEXT,
        sig TEXT,
        blockhash TEXT,
        raw TEXT,
        extra TEXT,
        status TEXT NOT NULL,
        result TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    // Databases created before the pot moved to USDC called this column "sol".
    const cols = this.sql.prepare('PRAGMA table_info(trades)').all() as { name: string }[];
    if (cols.some((c) => c.name === 'sol')) this.sql.exec('ALTER TABLE trades RENAME COLUMN sol TO quote');
  }

  close() {
    this.sql.close();
  }

  tx<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.sql.exec('COMMIT');
      return out;
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- kv ----
  get<T>(key: string): T | null {
    const row = this.sql.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? P<T>(row.value) : null;
  }
  set(key: string, value: unknown) {
    this.sql.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, J(value));
  }

  // ---- rounds ----
  private toRound(r: any): RoundRow {
    return {
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      maxHp: r.max_hp,
      hp: P<Hp>(r.hp)!,
      status: r.status,
      breakerSig: r.breaker_sig,
      armoredBreak: !!r.armored_break,
      summary: P<RoundSummary>(r.summary),
      error: r.error,
    };
  }
  createRound(hp: Hp): RoundRow {
    const info = this.sql
      .prepare('INSERT INTO rounds(started_at, max_hp, hp, status) VALUES(?, ?, ?, ?)')
      .run(hp.startedAt, hp.maxHp, J(hp), 'active');
    return this.round(Number(info.lastInsertRowid))!;
  }
  round(id: number): RoundRow | null {
    const r = this.sql.prepare('SELECT * FROM rounds WHERE id = ?').get(id);
    return r ? this.toRound(r) : null;
  }
  activeRound(): RoundRow | null {
    const r = this.sql.prepare("SELECT * FROM rounds WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
    return r ? this.toRound(r) : null;
  }
  latestRound(): RoundRow | null {
    const r = this.sql.prepare('SELECT * FROM rounds ORDER BY id DESC LIMIT 1').get();
    return r ? this.toRound(r) : null;
  }
  roundsByStatus(status: RoundRow['status']): RoundRow[] {
    return (this.sql.prepare('SELECT * FROM rounds WHERE status = ? ORDER BY id').all(status) as any[]).map((r) => this.toRound(r));
  }
  history(limit = 20): RoundSummary[] {
    const rows = this.sql.prepare('SELECT summary FROM rounds WHERE summary IS NOT NULL ORDER BY id DESC LIMIT ?').all(limit) as {
      summary: string;
    }[];
    return rows.map((r) => P<RoundSummary>(r.summary)!);
  }
  saveHp(id: number, hp: Hp) {
    this.sql.prepare('UPDATE rounds SET hp = ? WHERE id = ?').run(J(hp), id);
  }
  setMaxHp(id: number, hp: Hp) {
    this.sql.prepare('UPDATE rounds SET hp = ?, max_hp = ? WHERE id = ?').run(J(hp), hp.maxHp, id);
  }
  endRound(id: number, at: number, breakerSig: string | null, armoredBreak: boolean, summary: RoundSummary) {
    this.sql
      .prepare("UPDATE rounds SET ended_at = ?, breaker_sig = ?, armored_break = ?, summary = ?, status = 'paying' WHERE id = ?")
      .run(at, breakerSig, armoredBreak ? 1 : 0, J(summary), id);
  }
  saveSummary(id: number, summary: RoundSummary, error: string | null = null) {
    this.sql.prepare('UPDATE rounds SET summary = ?, status = ?, error = ? WHERE id = ?').run(J(summary), summary.status, error, id);
  }

  // ---- trades ----
  hasTrade(sig: string): boolean {
    return !!this.sql.prepare('SELECT 1 FROM trades WHERE sig = ?').get(sig);
  }
  insertTrade(t: TradeRow) {
    this.sql
      .prepare('INSERT INTO trades(sig, round, seq, slot, wallet, side, quote, tokens, usd, ts) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(t.sig, t.round, t.seq, t.slot, t.wallet, t.side, t.quote, t.tokens, t.usd, t.ts);
  }
  deleteTrade(sig: string) {
    this.sql.prepare('DELETE FROM trades WHERE sig = ?').run(sig);
  }
  roundTrades(round: number): TradeRow[] {
    return this.sql.prepare('SELECT * FROM trades WHERE round = ? ORDER BY seq').all(round) as unknown as TradeRow[];
  }
  nextSeq(): number {
    const r = this.sql.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM trades').get() as { n: number };
    return r.n;
  }

  // ---- payout steps ----
  step(key: string): StepRow | null {
    const r = this.sql.prepare('SELECT * FROM steps WHERE key = ?').get(key) as any;
    if (!r) return null;
    return {
      key: r.key,
      round: r.round,
      kind: r.kind,
      args: P(r.args),
      sig: r.sig,
      blockhash: r.blockhash,
      raw: r.raw,
      extra: P(r.extra),
      status: r.status,
      result: P(r.result),
      attempts: r.attempts,
    };
  }
  putStep(s: StepRow) {
    this.sql
      .prepare(
        `INSERT INTO steps(key, round, kind, args, sig, blockhash, raw, extra, status, result, attempts, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET sig=excluded.sig, blockhash=excluded.blockhash, raw=excluded.raw, extra=excluded.extra,
           status=excluded.status, result=excluded.result, attempts=excluded.attempts, updated_at=excluded.updated_at`,
      )
      .run(s.key, s.round, s.kind, J(s.args ?? null), s.sig, s.blockhash, s.raw, J(s.extra ?? null), s.status, J(s.result ?? null), s.attempts, Date.now());
  }
  roundSteps(round: number): StepRow[] {
    const rows = this.sql.prepare('SELECT key FROM steps WHERE round = ? ORDER BY updated_at').all(round) as { key: string }[];
    return rows.map((r) => this.step(r.key)!);
  }
}
