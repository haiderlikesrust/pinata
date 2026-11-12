import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
loadEnv({ path: path.join(root, '.env') });

const num = (def: number) => z.coerce.number().default(def);
const list = (def: string) =>
  z
    .string()
    .default(def)
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));
const opt = z
  .string()
  .optional()
  .transform((s) => (s && s.trim() ? s.trim() : undefined));

const schema = z.object({
  MODE: z.enum(['dry', 'live']).default('dry'),
  PORT: num(8787),
  ADMIN_TOKEN: opt,
  DB_PATH: z.string().default(path.join(root, 'data', 'pinata.sqlite')),

  MINT: opt,
  TOKEN_SYMBOL: z.string().default('PINATA'),
  X_URL: opt,
  // The asset the coin trades against on pump.fun, which is also what creator fees arrive in.
  // Leave QUOTE_MINT empty for a normal SOL coin.
  QUOTE_MINT: opt,
  QUOTE_SYMBOL: opt,
  STATIC_DIR: z.string().default(path.join(root, 'web', 'dist')),
  RPC_URL: opt,
  PUMPPORTAL_API_KEY: opt,
  JUPITER_API_KEY: opt,
  TREASURY_SECRET_KEY: opt,
  TREASURY_KEYFILE: opt,

  MAX_HP_USD: num(3000),
  SELL_HEAL_FACTOR: num(0.5),
  MIN_BUY_USD: num(10),
  MIN_POT_USD: num(150),
  DECAY_AFTER_HOURS: num(6),
  DECAY_PCT_PER_HOUR: num(10),
  NEXT_ROUND_DELAY_SEC: num(30),
  HOLD_WINDOW_MIN: num(0),
  BLOCKLIST: list(''),

  SPLIT_PACKS: num(25),
  SPLIT_BUYBACK: num(25),
  SPLIT_USDC: num(50),
  WEIGHTS: list('30,25,20,15,10'),
  PACK_TIERS: list('25,50,100'),
  MAX_PACKS_PER_WINNER: num(3),
  GAS_FLOAT_SOL: num(0.05),
  SLIPPAGE_BPS: num(200),
  GACHA_URL: z.string().default('https://gacha.collectorcrypt.com'),
  COLLECTOR_CRYPT_API_KEY: opt,
  COLLECTOR_CRYPT_PAYMENT_WALLET: z.string().default('GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3'),
  PRIORITY_MICROLAMPORTS: num(100000),
  LEDGER_POLL_MS: num(2500),
  MIN_CLAIM_USD: num(0.5),

  SIM_QUOTE_USD: num(0.0034),
  SIM_START_POT_USD: num(400),
  SIM_FEE_RATE: num(0.01),
  SIM_TRADES_PER_MIN: num(45),
});

/** Accepts a handle (@name or name) or a full x.com / twitter.com link. */
function normaliseX(v?: string): string | undefined {
  if (!v) return undefined;
  if (/^https:\/\/(www\.)?(x|twitter)\.com\//i.test(v)) return v;
  const handle = v.replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? `https://x.com/${handle}` : undefined;
}

export type Config = ReturnType<typeof parseConfig>;

export function parseConfig(env: Record<string, string | undefined> = process.env) {
  const e = schema.parse(env);
  const cfg = {
    root,
    mode: e.MODE,
    port: e.PORT,
    // Empty counts as not set, so a blank value can never unlock the admin API.
    adminToken: e.ADMIN_TOKEN ?? 'change-me',
    dbPath: e.DB_PATH,
    mint: e.MINT,
    symbol: e.TOKEN_SYMBOL,
    xUrl: normaliseX(e.X_URL),
    quoteMint: e.QUOTE_MINT,
    quoteSymbol: e.QUOTE_SYMBOL ?? (e.QUOTE_MINT ? 'PUMP' : e.MODE === 'dry' ? 'PUMP' : 'SOL'),
    staticDir: e.STATIC_DIR,
    rpcUrl: e.RPC_URL,
    pumpPortalKey: e.PUMPPORTAL_API_KEY,
    jupiterKey: e.JUPITER_API_KEY,
    treasurySecret: e.TREASURY_SECRET_KEY,
    treasuryKeyfile: e.TREASURY_KEYFILE,
    maxHpUsd: e.MAX_HP_USD,
    engine: {
      sellHealFactor: e.SELL_HEAL_FACTOR,
      minBuyUsd: e.MIN_BUY_USD,
      minPotUsd: e.MIN_POT_USD,
      decayAfterMs: e.DECAY_AFTER_HOURS * 3_600_000,
      decayPctPerHour: e.DECAY_PCT_PER_HOUR,
    },
    nextRoundDelayMs: e.NEXT_ROUND_DELAY_SEC * 1000,
    holdWindowMs: e.HOLD_WINDOW_MIN * 60_000,
    blocklist: e.BLOCKLIST,
    split: { packs: e.SPLIT_PACKS, buyback: e.SPLIT_BUYBACK, usdc: e.SPLIT_USDC },
    weights: e.WEIGHTS.map(Number).filter((n) => Number.isFinite(n) && n > 0),
    packTiers: e.PACK_TIERS.map(Number).filter((n) => Number.isFinite(n) && n > 0),
    maxPacksPerWinner: e.MAX_PACKS_PER_WINNER,
    gasFloatLamports: BigInt(Math.round(e.GAS_FLOAT_SOL * 1e9)),
    slippageBps: e.SLIPPAGE_BPS,
    gachaUrl: e.GACHA_URL.replace(/\/$/, ''),
    gachaApiKey: e.COLLECTOR_CRYPT_API_KEY,
    gachaPaymentWallet: e.COLLECTOR_CRYPT_PAYMENT_WALLET,
    priorityMicroLamports: e.PRIORITY_MICROLAMPORTS,
    ledgerPollMs: e.LEDGER_POLL_MS,
    minClaimUsd: e.MIN_CLAIM_USD,
    sim: { quoteUsd: e.SIM_QUOTE_USD, startPotUsd: e.SIM_START_POT_USD, feeRate: e.SIM_FEE_RATE, tradesPerMin: e.SIM_TRADES_PER_MIN },
  };

  if (cfg.mode === 'live') {
    const missing = [
      !cfg.mint && 'MINT',
      !cfg.rpcUrl && 'RPC_URL',
      !cfg.jupiterKey && 'JUPITER_API_KEY',
      !cfg.treasurySecret && !cfg.treasuryKeyfile && 'TREASURY_SECRET_KEY or TREASURY_KEYFILE',
      cfg.adminToken === 'change-me' && 'ADMIN_TOKEN (still the default)',
    ].filter(Boolean);
    if (missing.length) throw new Error(`MODE=live needs: ${missing.join(', ')}`);
  }
  if (cfg.weights.length === 0) throw new Error('WEIGHTS is empty');
  return cfg;
}
