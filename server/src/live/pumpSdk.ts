// pump.fun's SDKs ship an ESM build that imports CommonJS packages by named
// export, which Node refuses to load. Their CommonJS builds work, so load those.

import { createRequire } from 'node:module';
import type { PublicKey } from '@solana/web3.js';

const require = createRequire(import.meta.url);
const pump = require('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');
const swap = require('@pump-fun/pump-swap-sdk') as typeof import('@pump-fun/pump-swap-sdk');

export const OnlinePumpSdk = pump.OnlinePumpSdk;
export type OnlinePumpSdk = InstanceType<typeof pump.OnlinePumpSdk>;
export const PUMP_SDK = pump.PUMP_SDK;
export const bondingCurvePda = pump.bondingCurvePda;
export const PUMP_AMM_SDK = swap.PUMP_AMM_SDK;

/** The coin's PumpSwap pool. A coin quoted in something other than SOL has its pool keyed by that quote mint. */
export const canonicalPumpPoolPda = (mint: PublicKey, quoteMint?: PublicKey) => (quoteMint ? pump.canonicalPumpPoolPdaWithQuote(mint, quoteMint) : pump.canonicalPumpPoolPda(mint));
