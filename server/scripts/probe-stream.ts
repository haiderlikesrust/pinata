// Checks that your RPC's websocket reports activity on a coin, which is what
// makes hits appear within about a second. It spends nothing.
//
//   npm run probe:stream -w server -- <mint> [seconds]
//
// Needs RPC_URL in .env (or in the environment).

import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';

loadEnv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });

const [mintArg, secondsArg] = process.argv.slice(2);
if (!mintArg || !process.env.RPC_URL) {
  console.error('usage: npm run probe:stream -w server -- <mint> [seconds]   (RPC_URL must be set)');
  process.exit(1);
}
const seconds = Number(secondsArg ?? 20);
const conn = new Connection(process.env.RPC_URL, 'confirmed');
const started = Date.now();
let count = 0;
let failed = 0;

const id = conn.onLogs(
  new PublicKey(mintArg),
  (logs) => {
    if (logs.err) return void failed++;
    count++;
    if (count <= 8) console.log(`+${((Date.now() - started) / 1000).toFixed(1)}s  ${logs.signature.slice(0, 16)}…`);
  },
  'confirmed',
);
console.log(`listening for ${seconds}s for transactions that touch ${mintArg} …`);

setTimeout(() => {
  void conn.removeOnLogsListener(id).catch(() => {});
  console.log(`\n${count} successful and ${failed} failed transactions reported in ${seconds}s.`);
  console.log(count > 0 ? 'The websocket works: the site will show hits within about a second.' : 'Nothing arrived. Either the coin was quiet, or this RPC does not offer websocket subscriptions.');
  process.exit(0);
}, seconds * 1000);
