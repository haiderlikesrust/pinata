import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import { bondingCurvePda } from '../src/live/pumpSdk';
import { parseTrade } from '../src/live/ledger';
import { mapPortalTrade } from '../src/live/pumpPortal';
import { WSOL } from '../src/live/rpc';

const MINT = Keypair.generate().publicKey;
const mint = MINT.toBase58();
const user = Keypair.generate().publicKey.toBase58();
const other = Keypair.generate().publicKey.toBase58();
const feePayerBot = Keypair.generate().publicKey.toBase58();
// A real program-derived (off-curve) address stands in for the bonding curve / pool.
const venue = bondingCurvePda(MINT).toBase58();

const bal = (owner: string, m: string, amount: number) => ({ accountIndex: 0, mint: m, owner, uiTokenAmount: { amount: String(Math.round(amount * 1e6)), decimals: 6, uiAmount: amount, uiAmountString: String(amount) } });

function tx(p: { keys: string[]; preSol: number[]; postSol: number[]; pre: ReturnType<typeof bal>[]; post: ReturnType<typeof bal>[]; err?: unknown }): ParsedTransactionWithMeta {
  return {
    slot: 123,
    blockTime: 1_700_000_000,
    transaction: { signatures: ['sig'], message: { accountKeys: p.keys.map((k) => ({ pubkey: { toBase58: () => k } })) } },
    meta: { err: p.err ?? null, preBalances: p.preSol.map((s) => s * 1e9), postBalances: p.postSol.map((s) => s * 1e9), preTokenBalances: p.pre, postTokenBalances: p.post },
  } as unknown as ParsedTransactionWithMeta;
}

describe('parseTrade', () => {
  it('reads a bonding-curve buy', () => {
    const t = parseTrade(
      tx({ keys: [user, venue], preSol: [5, 10], postSol: [3.97, 12], pre: [bal(venue, mint, 1000)], post: [bal(venue, mint, 400), bal(user, mint, 600)] }),
      'sig',
      mint,
    );
    expect(t).toMatchObject({ wallet: user, side: 'buy', tokens: 600, slot: 123, ts: 1_700_000_000_000 });
    expect(t!.quote).toBeCloseTo(2);
  });

  it('reads a bonding-curve sell', () => {
    const t = parseTrade(tx({ keys: [user, venue], preSol: [1, 12], postSol: [1.99, 11], pre: [bal(venue, mint, 400), bal(user, mint, 600)], post: [bal(venue, mint, 700), bal(user, mint, 300)] }), 'sig', mint);
    expect(t).toMatchObject({ wallet: user, side: 'sell', tokens: 300 });
    expect(t!.quote).toBeCloseTo(1);
  });

  it('reads a pool (wSOL) buy and credits the token receiver, not the fee payer', () => {
    const t = parseTrade(
      tx({
        keys: [feePayerBot, user, venue],
        preSol: [9, 4, 0.002],
        postSol: [8.999, 2.5, 0.002],
        pre: [bal(venue, mint, 5000), bal(venue, WSOL, 100)],
        post: [bal(venue, mint, 4000), bal(venue, WSOL, 101.5), bal(user, mint, 1000)],
      }),
      'sig',
      mint,
    );
    expect(t).toMatchObject({ wallet: user, side: 'buy', tokens: 1000 });
    expect(t!.quote).toBeCloseTo(1.5);
  });

  it('reads a buy on a coin quoted in another token ($PUMP)', () => {
    const PUMP_TOKEN = Keypair.generate().publicKey.toBase58();
    const t = parseTrade(
      tx({
        keys: [user, venue],
        preSol: [1, 0.002],
        postSol: [0.999, 0.002],
        pre: [bal(venue, mint, 5000), bal(venue, PUMP_TOKEN, 1000), bal(user, PUMP_TOKEN, 400)],
        post: [bal(venue, mint, 4000), bal(venue, PUMP_TOKEN, 1250), bal(user, PUMP_TOKEN, 150), bal(user, mint, 1000)],
      }),
      'sig',
      mint,
      PUMP_TOKEN,
    );
    expect(t).toMatchObject({ wallet: user, side: 'buy', tokens: 1000 });
    expect(t!.quote).toBeCloseTo(250);
    // The same transaction read as a SOL coin is not a trade worth counting: only fees moved.
    expect(parseTrade(tx({ keys: [user, venue], preSol: [1, 0.002], postSol: [0.999, 0.002], pre: [bal(venue, mint, 5000)], post: [bal(venue, mint, 4000), bal(user, mint, 1000)] }), 'sig', mint)).toBeNull();
  });

  it('ignores wallet-to-wallet transfers', () => {
    expect(parseTrade(tx({ keys: [user, other], preSol: [1, 1], postSol: [0.99, 1], pre: [bal(user, mint, 500)], post: [bal(user, mint, 100), bal(other, mint, 400)] }), 'sig', mint)).toBeNull();
  });

  it('ignores liquidity being added (tokens and SOL both flow into the pool)', () => {
    const t = parseTrade(
      tx({ keys: [user, venue], preSol: [5, 0], postSol: [3, 0], pre: [bal(user, mint, 900), bal(venue, mint, 0), bal(venue, WSOL, 0)], post: [bal(user, mint, 100), bal(venue, mint, 800), bal(venue, WSOL, 2)] }),
      'sig',
      mint,
    );
    expect(t).toBeNull();
  });

  it('ignores failed transactions and other coins', () => {
    const buy = { keys: [user, venue], preSol: [5, 10], postSol: [3, 12], pre: [bal(venue, mint, 1000)], post: [bal(venue, mint, 400), bal(user, mint, 600)] };
    expect(parseTrade(tx({ ...buy, err: { InstructionError: [0, 'Custom'] } }), 'sig', mint)).toBeNull();
    expect(parseTrade(tx(buy), 'sig', Keypair.generate().publicKey.toBase58())).toBeNull();
  });
});

describe('mapPortalTrade', () => {
  it('maps the commonly reported shape', () => {
    const t = mapPortalTrade({ signature: 's', mint, traderPublicKey: user, txType: 'buy', solAmount: 0.5, tokenAmount: 1234 }, mint);
    expect(t).toMatchObject({ sig: 's', wallet: user, side: 'buy', quote: 0.5, tokens: 1234 });
  });
  it('rejects other mints and incomplete messages', () => {
    expect(mapPortalTrade({ signature: 's', mint: 'x', traderPublicKey: user, txType: 'buy', solAmount: 1 }, mint)).toBeNull();
    expect(mapPortalTrade({ signature: 's', mint, traderPublicKey: user, txType: 'buy' }, mint)).toBeNull();
    expect(mapPortalTrade({ message: 'Successfully subscribed' } as never, mint)).toBeNull();
  });
});

describe('Ledger live stream', () => {
  it('reads a trade within a second of the websocket notification, not on the next timer tick', async () => {
    const { Ledger } = await import('../src/live/ledger');
    const { Db } = await import('../src/db');
    const listeners: ((l: { err: unknown; signature: string }) => void)[] = [];
    let sigs: { signature: string; slot: number; err: null }[] = [{ signature: 'old', slot: 1, err: null }];
    const buy = tx({ keys: [user, venue], preSol: [5, 10], postSol: [3.97, 12], pre: [bal(venue, mint, 1000)], post: [bal(venue, mint, 400), bal(user, mint, 600)] });
    const conn = {
      onLogs: (_a: unknown, cb: (l: { err: unknown; signature: string }) => void) => listeners.push(cb),
      removeOnLogsListener: async () => {},
      // newest first, stopping at the cursor, like the real RPC
      getSignaturesForAddress: async (_a: unknown, o: { until?: string; limit?: number }) => {
        const i = o.until ? sigs.findIndex((s) => s.signature === o.until) : -1;
        return (i < 0 ? sigs : sigs.slice(0, i)).slice(0, o.limit ?? 1000);
      },
      getParsedTransaction: async () => buy,
    };
    const seen: { sig: string; at: number }[] = [];
    const ledger = new Ledger(conn as never, MINT, new Db(':memory:'), (t) => seen.push({ sig: t.sig, at: Date.now() }), () => {}, 60_000);
    ledger.start();
    await new Promise((r) => setTimeout(r, 80)); // first pass only records where "now" is
    expect(seen).toEqual([]);
    expect(listeners.length).toBe(3); // the mint, its bonding curve and its pool

    sigs = [{ signature: 'new-trade', slot: 2, err: null }, ...sigs];
    const notified = Date.now();
    listeners[0]!({ err: null, signature: 'new-trade' });
    await new Promise((r) => setTimeout(r, 900));
    ledger.stop();

    expect(seen.map((s) => s.sig)).toEqual(['new-trade']); // once, even though three addresses report it
    expect(seen[0]!.at - notified).toBeLessThan(700);
  });
});
