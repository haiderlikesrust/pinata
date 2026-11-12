// Jupiter Swap API v2 (order -> sign -> execute) and Price API v3.

import { WSOL } from './rpc';

const BASE = 'https://api.jup.ag';

export interface Order {
  transaction: string | null;
  requestId: string;
  /** Which of Jupiter's engines built this: "metis" (aggregator), "jupiterz" (market makers), ... */
  router?: string;
  /** True when someone else pays the network fee, and therefore signs first. */
  gasless?: boolean;
  signatureFeePayer?: string | null;
  outAmount?: string;
  priceImpactPct?: string | number;
  priceImpact?: string | number;
  errorMessage?: string;
  error?: string;
}

export class Jupiter {
  constructor(private readonly apiKey?: string) {}

  private headers(json = false): Record<string, string> {
    return { ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}), ...(json ? { 'content-type': 'application/json' } : {}) };
  }

  /** Quote + unsigned transaction. Without `taker` it is a quote only. */
  async order(p: { inputMint: string; outputMint: string; amount: bigint; taker?: string; slippageBps: number; excludeRouters?: string[] }): Promise<Order> {
    const q = new URLSearchParams({ inputMint: p.inputMint, outputMint: p.outputMint, amount: p.amount.toString(), slippageBps: String(p.slippageBps) });
    if (p.taker) q.set('taker', p.taker);
    if (p.excludeRouters?.length) q.set('excludeRouters', p.excludeRouters.join(','));
    const res = await fetch(`${BASE}/swap/v2/order?${q}`, { headers: this.headers() });
    const body = (await res.json().catch(() => ({}))) as Order;
    if (!res.ok) throw new Error(`Jupiter order ${res.status}: ${body.errorMessage ?? body.error ?? 'unknown error'}`);
    return body;
  }

  async execute(signedTransaction: string, requestId: string): Promise<{ status?: string; signature?: string; error?: string; code?: number }> {
    const res = await fetch(`${BASE}/swap/v2/execute`, { method: 'POST', headers: this.headers(true), body: JSON.stringify({ signedTransaction, requestId }) });
    const body = (await res.json().catch(() => ({}))) as { status?: string; signature?: string; error?: string; code?: number };
    if (!res.ok || body.status === 'Failed') throw new Error(`Jupiter execute: ${body.error ?? res.status} (code ${body.code ?? '?'})`);
    return body;
  }

  /** USD price of one whole token of `mint`. */
  async usdPrice(mint: string = WSOL): Promise<number> {
    const res = await fetch(`${BASE}/price/v3?ids=${mint}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Jupiter price ${res.status}`);
    const body = (await res.json()) as Record<string, { usdPrice?: number }>;
    const p = body[mint]?.usdPrice;
    if (!(typeof p === 'number' && p > 0)) throw new Error(`Jupiter price: no price for ${mint}`);
    return p;
  }
}

export class PriceFeed {
  private value = 0;
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private readonly jup: Jupiter,
    private readonly log: (m: string) => void,
    private readonly mint: string = WSOL,
  ) {}

  async start(everyMs = 15_000) {
    this.value = await this.jup.usdPrice(this.mint);
    this.timer = setInterval(() => {
      this.jup
        .usdPrice(this.mint)
        .then((v) => (this.value = v))
        .catch((e) => this.log(`price refresh failed, keeping $${this.value.toFixed(2)}: ${(e as Error).message}`));
    }, everyMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  usd = () => this.value;
}
