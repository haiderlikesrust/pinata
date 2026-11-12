// Wires the game to mainnet.

import { Connection, PublicKey, type Keypair } from '@solana/web3.js';
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

export interface LivePre {
  conn: Connection;
  mint: PublicKey;
  quoteMint?: PublicKey;
  treasury: Keypair;
  jupiter: Jupiter;
  price: PriceFeed;
}

/** A settings problem, worded for the person who has to fix it. Never contains a secret. */
export class SettingsError extends Error {}

/**
 * Checks every live setting BEFORE this server reports itself healthy. During
 * an update that matters: a server with a bad key or a dead RPC fails here, the
 * health check never passes, and Swarm keeps the previous version running
 * instead of handing the site over to something that cannot work.
 */
export async function preflightLive(cfg: Config, log: (m: string) => void): Promise<LivePre> {
  const address = (name: string, value: string) => {
    try {
      return new PublicKey(value);
    } catch {
      throw new SettingsError(`${name} is not a valid Solana address`);
    }
  };
  const mint = address('MINT', cfg.mint!);
  const quoteMint = cfg.quoteMint ? address('QUOTE_MINT', cfg.quoteMint) : undefined;

  let treasury: Keypair;
  try {
    treasury = loadKeypair(cfg.treasurySecret, cfg.treasuryKeyfile);
  } catch {
    // The underlying error can quote part of the key, so it is deliberately not shown.
    throw new SettingsError('TREASURY_SECRET_KEY could not be read. It must be the wallet secret key as base58, or a JSON array of 64 numbers, with no quotes or spaces around it');
  }

  if (!/^https:\/\//.test(cfg.rpcUrl!)) throw new SettingsError('RPC_URL must start with https://');
  const conn = new Connection(cfg.rpcUrl!, { commitment: 'confirmed' });
  try {
    await conn.getLatestBlockhash('confirmed');
  } catch {
    throw new SettingsError('RPC_URL does not answer. For QuickNode it is the Base URL, a slash, the Auth token, and a closing slash');
  }
  const exists = async (name: string, key: PublicKey) => {
    const info = await conn.getAccountInfo(key, 'confirmed').catch(() => undefined);
    if (info === undefined) throw new SettingsError(`RPC_URL failed while looking up ${name}`);
    if (info === null) throw new SettingsError(`${name} ${key.toBase58()} does not exist on mainnet`);
  };
  await exists('MINT', mint);
  if (quoteMint) await exists('QUOTE_MINT', quoteMint);

  const jupiter = new Jupiter(cfg.jupiterKey);
  // Trades are sized in the quote asset, so that is the price the game needs.
  const price = new PriceFeed(jupiter, log, cfg.quoteMint);
  try {
    await price.start();
  } catch {
    throw new SettingsError('Jupiter did not return a price. Check JUPITER_API_KEY');
  }

  log(`live settings check passed · prize wallet ${treasury.publicKey.toBase58()}`);
  return { conn, mint, quoteMint, treasury, jupiter, price };
}

export async function startLive(o: { cfg: Config; db: Db; pre: LivePre; broadcast: (e: ServerEvent) => void; log: (m: string) => void }): Promise<{ game: Game; stop: () => void }> {
  const { cfg, db, broadcast, log } = o;
  const { conn, mint, quoteMint, treasury, jupiter, price } = o.pre;

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
    minClaimUsdc: BigInt(Math.round(cfg.minClaimUsd * 1_000_000)),
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
