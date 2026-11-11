// Dry-run trade source: random buys and sells so the whole thing can be
// watched end to end without a coin or a wallet.

import type { Game, IncomingTrade } from '../game';
import { fakeBase58, type MemChain } from '../payout/memChain';

export interface SimOpts {
  /** USD price of the quote asset trades are made in. */
  quoteUsd: number;
  feeRate: number;
  tradesPerMin: number;
  tokenUsd?: number;
}

const gauss = () => {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

export class Simulator {
  private readonly wallets = Array.from({ length: 70 }, () => fakeBase58(44));
  private slot = 300_000_000;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly game: Game,
    private readonly chain: MemChain,
    private readonly opts: SimOpts,
  ) {}

  start() {
    const loop = () => {
      const mean = 60_000 / this.opts.tradesPerMin;
      this.timer = setTimeout(() => {
        this.emit();
        loop();
      }, Math.max(120, -Math.log(1 - Math.random()) * mean));
    };
    loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  private wallet() {
    return this.wallets[Math.floor(Math.random() * this.wallets.length)]!;
  }

  make(side: 'buy' | 'sell', usd: number, wallet = this.wallet()): IncomingTrade {
    const quote = usd / this.opts.quoteUsd;
    return { sig: fakeBase58(88), slot: ++this.slot, wallet, side, quote, tokens: usd / (this.opts.tokenUsd ?? 0.00004), ts: Date.now() };
  }

  emit(side: 'buy' | 'sell' = Math.random() < 0.66 ? 'buy' : 'sell', usd = Math.min(2500, Math.max(2, Math.exp(3.2 + 1.1 * gauss())))) {
    const t = this.make(side, usd);
    this.chain.accrue(t.quote * this.opts.feeRate);
    this.game.ingest(t);
    return t;
  }
}
