// Checks the two trade feeds against any real pump.fun coin, without spending anything.
//
//   npm run probe -- <mint> [seconds]
//
// Needs RPC_URL in .env. With PUMPPORTAL_API_KEY set it also prints raw
// websocket messages, so you can confirm the event shape and that trades keep
// arriving after a coin has graduated to PumpSwap.

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';
import { parseTrade } from '../src/live/ledger';
import { mapPortalTrade, PumpPortalFeed, type RawPortalTrade } from '../src/live/pumpPortal';

loadEnv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });

const [mintArg, secondsArg] = process.argv.slice(2);
// Set QUOTE_MINT in .env to check a coin that trades against $PUMP instead of SOL.
const quoteMint = process.env.QUOTE_MINT?.trim() || undefined;
if (!mintArg || !process.env.RPC_URL) {
  console.error('usage: npm run probe -- <mint> [seconds]   (RPC_URL must be set in .env)');
  process.exit(1);
}
const mint = new PublicKey(mintArg);
const conn = new Connection(process.env.RPC_URL, 'confirmed');

console.log(`\n== RPC ledger: last 25 transactions touching ${mintArg} ==`);
const sigs = (await conn.getSignaturesForAddress(mint, { limit: 25 })).filter((s) => !s.err);
let parsed = 0;
for (const s of sigs.reverse()) {
  const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' });
  const t = tx && parseTrade(tx, s.signature, mintArg, quoteMint);
  if (t) {
    parsed++;
    console.log(`${t.side.padEnd(4)} ${t.quote.toFixed(4).padStart(12)} ${quoteMint ? 'quote' : 'SOL'}  ${t.tokens.toFixed(0).padStart(14)} tokens  ${t.wallet}  ${s.signature.slice(0, 12)}…`);
  } else console.log(`---- not a trade                                   ${s.signature.slice(0, 12)}…`);
}
console.log(`${parsed}/${sigs.length} read as trades. Compare a few against Solscan before going live.`);

const key = process.env.PUMPPORTAL_API_KEY;
if (!key) {
  console.log('\nNo PUMPPORTAL_API_KEY set, skipping the websocket check.');
  process.exit(0);
}
const seconds = Number(secondsArg ?? 60);
console.log(`\n== PumpPortal websocket: listening for ${seconds}s ==`);
let raw = 0;
let mapped = 0;
const feed = new PumpPortalFeed(
  key,
  mintArg,
  () => mapped++,
  (m) => console.log(m),
  (msg) => {
    raw++;
    if (raw <= 5) console.log('raw:', JSON.stringify(msg));
    else if (mapPortalTrade(msg as RawPortalTrade, mintArg) === null) console.log('unmapped:', JSON.stringify(msg).slice(0, 200));
  },
);
feed.start();
setTimeout(() => {
  feed.stop();
  console.log(`\n${raw} messages, ${mapped} understood as trades.`);
  process.exit(0);
}, seconds * 1000);
