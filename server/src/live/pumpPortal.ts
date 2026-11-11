// Fast trade feed from PumpPortal's websocket. It only drives the instant
// animation on the site; the RPC ledger decides everything that matters.
// Docs: https://pumpportal.fun/data-api/real-time

import WebSocket from 'ws';
import type { IncomingTrade } from '../game';

export interface RawPortalTrade {
  signature?: string;
  mint?: string;
  traderPublicKey?: string;
  txType?: string;
  solAmount?: number;
  quoteAmount?: number;
  tokenAmount?: number;
  [k: string]: unknown;
}

/** Tolerant mapping: the event shape is not formally documented. */
export function mapPortalTrade(m: RawPortalTrade, mint: string): IncomingTrade | null {
  if (!m || m.mint !== mint || !m.signature || !m.traderPublicKey) return null;
  const side = m.txType === 'buy' ? 'buy' : m.txType === 'sell' ? 'sell' : null;
  // For a coin quoted in another token the size may arrive under a different name.
  const quote = Number(m.quoteAmount ?? m.solAmount ?? (m as { sol_amount?: number }).sol_amount);
  if (!side || !(quote > 0)) return null;
  return { sig: m.signature, slot: 0, wallet: m.traderPublicKey, side, quote, tokens: Number(m.tokenAmount ?? 0), ts: Date.now() };
}

export class PumpPortalFeed {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry = 0;
  private warned = false;

  constructor(
    private readonly apiKey: string,
    private readonly mint: string,
    private readonly onTrade: (t: IncomingTrade) => void,
    private readonly log: (m: string) => void,
    private readonly onRaw?: (raw: unknown) => void,
  ) {}

  start() {
    this.stopped = false;
    this.open();
  }
  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  private open() {
    // One connection only: PumpPortal bans clients that open many.
    const ws = new WebSocket(`wss://pumpportal.fun/api/data?api-key=${encodeURIComponent(this.apiKey)}`);
    this.ws = ws;
    ws.on('open', () => {
      this.retry = 0;
      ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [this.mint] }));
      this.log('PumpPortal feed connected');
    });
    ws.on('message', (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onRaw?.(msg);
      const trade = mapPortalTrade(msg as RawPortalTrade, this.mint);
      if (trade) this.onTrade(trade);
      else if (!this.warned && (msg as RawPortalTrade).signature) {
        this.warned = true;
        this.log(`PumpPortal sent a trade in a shape this build does not understand; animations will follow the RPC ledger instead: ${JSON.stringify(msg).slice(0, 300)}`);
      }
    });
    ws.on('close', () => {
      if (this.stopped) return;
      const wait = Math.min(30_000, 1000 * 2 ** this.retry++);
      this.log(`PumpPortal feed closed, reconnecting in ${Math.round(wait / 1000)}s`);
      setTimeout(() => this.open(), wait);
    });
    ws.on('error', (e) => this.log(`PumpPortal feed error: ${e.message}`));
  }
}
