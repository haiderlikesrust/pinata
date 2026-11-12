// Runs the real trade ledger against a coin for a short while and reports how
// long after its block each trade was picked up. It spends nothing and stores nothing.
//
//   npm run probe:latency -w server -- <mint> [seconds]
//
// Needs RPC_URL in .env (or in the environment). Set QUOTE_MINT for a coin quoted in $CARDS.

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';
import { Db } from '../src/db';
import { Ledger } from '../src/live/ledger';

loadEnv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });

const [mintArg, secondsArg] = process.argv.slice(2);
if (!mintArg || !process.env.RPC_URL) {
  console.error('usage: npm run probe:latency -w server -- <mint> [seconds]   (RPC_URL must be set)');
  process.exit(1);
}
const seconds = Number(secondsArg ?? 30);
const quote = process.env.QUOTE_MINT?.trim();
const conn = new Connection(process.env.RPC_URL, 'confirmed');
const lags: number[] = [];

const ledger = new Ledger(
  conn,
  new PublicKey(mintArg),
  new Db(':memory:'),
  (t) => {
    // Block times are whole seconds, so this is accurate to about a second.
    const lag = (Date.now() - t.ts) / 1000;
    lags.push(lag);
    if (lags.length <= 12) console.log(`${t.side.padEnd(4)} ${t.quote.toFixed(4).padStart(12)}  picked up ~${lag.toFixed(1)}s after its block`);
  },
  (m) => console.log(`[ledger] ${m}`),
  2500,
  quote ? new PublicKey(quote) : undefined,
);
ledger.start();
console.log(`watching ${mintArg} for ${seconds}s …`);

setTimeout(() => {
  ledger.stop();
  if (lags.length === 0) console.log('\nNo trades were seen. The coin may have been quiet.');
  else {
    const sorted = [...lags].sort((a, b) => a - b);
    console.log(`\n${lags.length} trades. Median pick-up ~${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)}s after the block, slowest ~${sorted[sorted.length - 1]!.toFixed(1)}s.`);
  }
  process.exit(0);
}, seconds * 1000);
