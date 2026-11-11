// Types shared by the server and the site.

export type Side = 'buy' | 'sell';
export type Mode = 'dry' | 'live';
export type Phase = 'alive' | 'cracking' | 'broken';

/** A trade as shown on the site. */
export interface TradeMsg {
  sig: string;
  wallet: string;
  side: Side;
  usd: number;
  ts: number;
}

export interface LeaderEntry {
  wallet: string;
  usd: number;
  sig: string;
}

export type PackStatus = 'pending' | 'delivered' | 'paid_usdc' | 'failed';

export interface PackResult {
  tier: number;
  status: PackStatus;
  sig?: string;
  nft?: string;
  rarity?: string;
  /** The card that came out of the pack. */
  name?: string;
  image?: string;
  /** Collector Crypt's insured value of the card, in USD. */
  insuredValue?: number;
}

export interface WinnerPublic {
  wallet: string;
  role: 'breaker' | 'top';
  rank: number;
  /** Share of each reward bucket, 0..1 */
  weight: number;
  buyUsd: number;
  buySig: string;
  packs: PackResult[];
  /** USDC paid, null until known */
  usdc: number | null;
  usdcSig?: string;
  /** Tokens of our coin paid, null until known */
  tokens: number | null;
  tokenSig?: string;
  /** What the airdropped tokens cost to buy back, in USD. */
  tokensUsd?: number | null;
  /** Everything this winner has received so far, in USD. */
  totalUsd?: number;
}

export type RoundStatus = 'paying' | 'paid' | 'attention';

export interface RoundSummary {
  round: number;
  startedAt: number;
  endedAt: number;
  maxHp: number;
  /** The USDC prize pool that was paid out. */
  potUsd: number | null;
  breaker: string | null;
  status: RoundStatus;
  /** True while winners can still change (hold window not over yet). */
  provisional: boolean;
  winners: WinnerPublic[];
  claimSig?: string;
}

export interface Split {
  packs: number;
  buyback: number;
  usdc: number;
}

export interface PublicState {
  mode: Mode;
  mint: string | null;
  symbol: string;
  /** Link to the project's X account, if one is configured. */
  xUrl: string | null;
  round: number;
  phase: Phase;
  hp: number;
  maxHp: number;
  armored: boolean;
  /** The prize pool in USD: USDC in the prize wallet plus creator fees not converted yet. */
  potUsd: number;
  /** What creator fees arrive in before they are swapped to USDC, e.g. CARDS. */
  feeSymbol: string;
  startedAt: number;
  nextRoundAt: number | null;
  split: Split;
  weights: number[];
  minBuyUsd: number;
  minPotUsd: number;
  leaderboard: LeaderEntry[];
  feed: TradeMsg[];
  lastRound: RoundSummary | null;
  serverTime: number;
}

export type ServerEvent =
  | { type: 'state'; state: PublicState }
  | { type: 'trade'; trade: TradeMsg; amount: number; hp: number; maxHp: number; armored: boolean; confirmed: boolean }
  | { type: 'break'; summary: RoundSummary; state: PublicState }
  | { type: 'payout'; summary: RoundSummary }
  | { type: 'round'; state: PublicState };

export const shortWallet = (w: string) => (w.length > 9 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w);

export const fmtUsd = (n: number, digits = 0) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits, minimumFractionDigits: digits });
