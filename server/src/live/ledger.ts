// The source of truth for trades. Polls the RPC for new transactions touching
// the coin, and works out who bought or sold from balance changes alone, so it
// does not depend on pump.fun's instruction formats or on a websocket staying up.

import { PublicKey, type Connection, type ParsedTransactionWithMeta } from '@solana/web3.js';
import { bondingCurvePda, canonicalPumpPoolPda } from './pumpSdk';
import type { Db } from '../db';
import type { IncomingTrade } from '../game';
import { WSOL, isOnCurve, sleep } from './rpc';

type Bal = NonNullable<NonNullable<ParsedTransactionWithMeta['meta']>['postTokenBalances']>[number];
const ui = (b: Bal) => Number(b.uiTokenAmount.uiAmountString ?? b.uiTokenAmount.uiAmount ?? 0);

/**
 * Reads one transaction as a trade of `mint` against SOL, or returns null.
 *
 * The venue (bonding curve or pool) is the program-owned account whose token
 * balance moved the most; the trader is the ordinary wallet that moved the
 * other way. SOL size is what the venue gained or lost.
 */
export function parseTrade(tx: ParsedTransactionWithMeta, sig: string, mint: string, quoteMint: string = WSOL): IncomingTrade | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;

  const delta = new Map<string, number>();
  const quote = new Map<string, number>();
  const quoteIsSol = quoteMint === WSOL;
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const [list, sign] of [
    [meta.postTokenBalances ?? [], 1],
    [meta.preTokenBalances ?? [], -1],
  ] as const) {
    for (const b of list) {
      if (!b.owner) continue;
      if (b.mint === mint) add(delta, b.owner, sign * ui(b));
      else if (b.mint === quoteMint) add(quote, b.owner, sign * ui(b));
    }
  }

  let venue: string | null = null;
  let user: string | null = null;
  for (const [owner, d] of delta) {
    if (Math.abs(d) < 1e-9) continue;
    if (isOnCurve(owner)) {
      if (!user || Math.abs(d) > Math.abs(delta.get(user)!)) user = owner;
    } else if (!venue || Math.abs(d) > Math.abs(delta.get(venue)!)) venue = owner;
  }
  if (!venue || !user) return null; // a plain transfer, a migration, etc.
  const userDelta = delta.get(user)!;
  const venueDelta = delta.get(venue)!;
  if (Math.sign(userDelta) === Math.sign(venueDelta)) return null;

  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const lamports = (address: string) => {
    const i = keys.indexOf(address);
    return i < 0 ? 0 : ((meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0)) / 1e9;
  };
  // What the venue received (positive on a buy): its quote-token balance change, or for a
  // SOL coin on the bonding curve, the curve account's own lamports.
  let venueSol = quote.get(venue) ?? 0;
  if (Math.abs(venueSol) < 1e-9 && quoteIsSol) venueSol = lamports(venue);

  const side = userDelta > 0 ? 'buy' : 'sell';
  let sol: number;
  if (Math.abs(venueSol) > 1e-9) {
    // Tokens and SOL must move in opposite directions, otherwise it is liquidity being added or removed.
    if (Math.sign(venueSol) === Math.sign(venueDelta)) return null;
    sol = Math.abs(venueSol);
  } else if (quoteIsSol) {
    // Venue keeps its SOL somewhere we did not look: fall back to the trader's own balance change.
    sol = Math.abs(lamports(user));
    if (sol < 0.002) return null; // only network fees moved: not a SOL trade
  } else {
    // Traded against something other than our quote asset (another pool): size it by what the trader paid or got.
    sol = Math.abs(quote.get(user) ?? 0);
  }
  if (!(sol > 0)) return null;

  return { sig, slot: tx.slot, wallet: user, side, quote: sol, tokens: Math.abs(userDelta), ts: (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000 };
}

export class Ledger {
  private running = false;
  private readonly watch: PublicKey[];

  constructor(
    private readonly conn: Connection,
    private readonly mint: PublicKey,
    private readonly db: Db,
    private readonly onTrade: (t: IncomingTrade) => void,
    private readonly log: (m: string) => void,
    private readonly pollMs = 2500,
    /** What the coin trades against. Undefined means SOL. */
    private readonly quoteMint?: PublicKey,
  ) {
    // The mint is in every trade; the curve and pool are watched too in case an RPC
    // does not index transactions that reference the mint through a lookup table.
    this.watch = [mint, bondingCurvePda(mint), canonicalPumpPoolPda(mint, quoteMint)];
  }

  start() {
    this.running = true;
    void this.loop();
  }
  stop() {
    this.running = false;
  }

  private async loop() {
    while (this.running) {
      try {
        await this.poll();
      } catch (e) {
        this.log(`ledger poll failed: ${(e as Error).message}`);
      }
      await sleep(this.pollMs);
    }
  }

  /** New signatures for one address since its saved cursor, oldest first. */
  private async fresh(address: PublicKey): Promise<{ sig: string; slot: number; order: number }[]> {
    const key = `ledger:${address.toBase58()}`;
    const cursor = this.db.get<string>(key);
    if (cursor == null) {
      // First run: start from now rather than replaying the coin's whole history.
      const latest = await this.conn.getSignaturesForAddress(address, { limit: 1 }, 'confirmed');
      this.db.set(key, latest[0]?.signature ?? '');
      return [];
    }
    const out: { signature: string; slot: number; err: unknown }[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.conn.getSignaturesForAddress(address, { until: cursor || undefined, before, limit: 1000 }, 'confirmed');
      out.push(...page);
      if (page.length < 1000) break;
      before = page[page.length - 1]!.signature;
    }
    return out.reverse().filter((s) => !s.err).map((s, order) => ({ sig: s.signature, slot: s.slot, order }));
  }

  private async poll() {
    const lists = await Promise.all(this.watch.map((a) => this.fresh(a)));
    const seen = new Set<string>();
    const merged = lists
      .flat()
      .filter((s) => (seen.has(s.sig) ? false : (seen.add(s.sig), true)))
      .sort((a, b) => a.slot - b.slot || a.order - b.order);

    const mint = this.mint.toBase58();
    let stoppedAt: number | null = null;
    for (let i = 0; i < merged.length; i += 8) {
      const batch = merged.slice(i, i + 8);
      const txs = await Promise.all(batch.map((s) => (this.db.hasTrade(s.sig) ? null : this.conn.getParsedTransaction(s.sig, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }))));
      for (let j = 0; j < batch.length; j++) {
        const s = batch[j]!;
        if (this.db.hasTrade(s.sig)) continue;
        const tx = txs[j];
        if (!tx) {
          stoppedAt = s.slot; // not readable yet: try again next poll, keep the order intact
          break;
        }
        if (!this.running) return; // shutting down: leave the cursor where it is
        const trade = parseTrade(tx, s.sig, mint, this.quoteMint?.toBase58() ?? WSOL);
        if (trade) this.onTrade(trade);
      }
      if (stoppedAt !== null) break;
    }

    if (!this.running) return;
    // Advance each cursor to the newest signature we fully processed.
    this.watch.forEach((address, k) => {
      const done = lists[k]!.filter((s) => stoppedAt === null || s.slot < stoppedAt);
      const last = done[done.length - 1];
      if (last) this.db.set(`ledger:${address.toBase58()}`, last.sig);
    });
  }
}
