// Everything the game and the payout runner need from the outside world.
// MemChain (demo mode + tests) and LiveChain (mainnet) both implement this.
//
// Money model: the prize pool is the USDC in the prize wallet. Creator fees
// arrive in the coin's quote asset ($PUMP, or SOL) and are swapped into USDC
// before each payout. USDC sent to the wallet by anyone counts too.

export type StepKind = 'claim' | 'swapFees' | 'swapToken' | 'fundPack' | 'pack' | 'sweepPack' | 'sendUsdc' | 'sendToken';

export interface StepArgs {
  claim: Record<string, never>;
  /** Swaps every fee token in the wallet into USDC. The amount is read when the step runs. */
  swapFees: Record<string, never>;
  /** Buys back our coin with this much USDC (micro-USDC). */
  swapToken: { usdc: bigint };
  fundPack: { packWallet: string; usdc: bigint; lamports: bigint };
  pack: { packWallet: string; to: string; tier: number };
  sweepPack: { packWallet: string };
  sendUsdc: { to: string; amount: bigint };
  sendToken: { to: string; amount: bigint };
}

export interface StepResult {
  claim: { skipped?: boolean };
  swapFees: { out: bigint; skipped?: boolean };
  swapToken: { out: bigint };
  fundPack: Record<string, never>;
  /** spent=true means the pack was paid for but could not be opened. */
  pack: { ok: boolean; nft?: string; rarity?: string; name?: string; image?: string; insuredValue?: number; reason?: string; spent?: boolean };
  sweepPack: { usdc: bigint; skipped?: boolean };
  sendUsdc: Record<string, never>;
  sendToken: Record<string, never>;
}

/** A signed transaction that has not been sent yet. */
export interface Prepared {
  sig: string;
  blockhash: string;
  /** base64 signed transaction */
  raw: string;
  extra?: unknown;
}

export type TxStatus = 'landed' | 'failed' | 'pending' | 'expired';

export interface Chain {
  /** Builds and signs. Returns null when there is nothing to do. Must not send. */
  prepare<K extends StepKind>(kind: K, args: StepArgs[K], round: number): Promise<Prepared | null>;
  /** Sends a prepared transaction. Safe to call twice with the same one. */
  broadcast(kind: StepKind, p: Prepared): Promise<void>;
  status(sig: string, blockhash: string): Promise<TxStatus>;
  /** Reads what a landed transaction actually did. */
  outcome<K extends StepKind>(kind: K, sig: string, args: StepArgs[K], extra: unknown): Promise<StepResult[K]>;

  /** USDC in the prize wallet right now, in micro-USDC. This is the pot at payout time. */
  potUsdc(): Promise<bigint>;
  /**
   * The pot as shown on the site: USDC in the wallet plus the USDC value of fee
   * tokens held and creator fees not claimed yet. An estimate, in micro-USDC.
   */
  poolEstimateUsdc(): Promise<bigint>;
  holds(wallet: string, minTokens: number): Promise<boolean>;
  isOrdinaryWallet(wallet: string): Promise<boolean>;
  /** How many pieces a buyback of this much USDC should be split into to stay under the slippage cap. */
  buybackChunks(usdc: bigint): Promise<number>;
  /** Which of the wanted pack tiers can be bought right now. */
  packTiers(wanted: number[]): Promise<number[]>;
  /** Creates (or returns) this round's throwaway pack wallet address. */
  packWallet(round: number): Promise<string>;
  /** Resolves true once the transaction is finalized, false if it was dropped. */
  waitFinalized(sig: string): Promise<boolean>;
  /** Wallets whose trades must never count (treasury, pack wallets). */
  ownWallets(): string[];
  readonly tokenDecimals: number;
}

export const USDC_DECIMALS = 6;
export const MICRO = 1_000_000;
export const LAMPORTS = 1_000_000_000;
