// Wires the game to mainnet.

import { Connection, PublicKey } from '@solana/web3.js';
import type { ServerEvent } from '@pinata/shared';
import type { Config } from '../config';
import type { Db } from '../db';
import { Game } from '../game';
import { LiveChain } from './chain';
import { Jupiter, PriceFeed } from './jupiter';
import { Ledger } from './ledger';
import { Gacha } from './packs';
import { PumpPortalFeed } from './pumpPortal';
import { loadKeypair } from './rpc';

export async function startLive(o: { cfg: Config; db: Db; broadcast: (e: ServerEvent) => void; log: (m: string) => void }): Promise<{ game: Game; stop: () => void }> {
  const { cfg, db, broadcast, log } = o;
  const conn = new Connection(cfg.rpcUrl!, { commitment: 'confirmed' });
  const mint = new PublicKey(cfg.mint!);
  const treasury = loadKeypair(cfg.treasurySecret, cfg.treasuryKeyfile);

  const jupiter = new Jupiter(cfg.jupiterKey);
  const quoteMint = cfg.quoteMint ? new PublicKey(cfg.quoteMint) : undefined;
  // Trades are sized in the quote asset, so that is the price the game needs.
  const price = new PriceFeed(jupiter, log, cfg.quoteMint);
  await price.start();

  const chain = new LiveChain({
    conn,
    db,
    treasury,
    mint,
    quoteMint,
    quoteUsd: price.usd,
    jupiter,
    gacha: new Gacha(cfg.gachaUrl, log, cfg.gachaPaymentWallet, cfg.gachaApiKey),
    gasFloatLamports: cfg.gasFloatLamports,
    slippageBps: cfg.slippageBps,
    priorityMicroLamports: cfg.priorityMicroLamports,
    log,
  });
  await chain.init();

  const game = new Game({ cfg, db, chain, quoteUsd: price.usd, broadcast, log });
  await game.init();

  const ledger = new Ledger(conn, mint, db, (t) => game.ingest(t), log, cfg.ledgerPollMs, quoteMint);
  ledger.start();
  const feed = cfg.pumpPortalKey ? new PumpPortalFeed(cfg.pumpPortalKey, cfg.mint!, (t) => game.ingestProvisional(t), log) : null;
  if (feed) feed.start();
  else log('No PUMPPORTAL_API_KEY: hits will appear a few seconds late, straight from the RPC ledger');

  return {
    game,
    stop: () => {
      ledger.stop();
      feed?.stop();
      price.stop();
    },
  };
}
