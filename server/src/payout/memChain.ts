// In-memory chain used by demo mode and by the tests. It keeps real balances
// so "nothing paid twice, nothing lost" can be checked.
//
// Same money model as mainnet: creator fees accrue in a fee token, are claimed,
// swapped into USDC, and the USDC in the wallet is the prize pool.

import { randomBytes } from 'node:crypto';
import type { Chain, Prepared, StepArgs, StepKind, StepResult, TxStatus } from './chain';
import { MICRO } from './chain';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const fakeBase58 = (len: number) => Array.from(randomBytes(len), (b) => B58[b % 58]).join('');

/** Base units per fee token (6 decimals, like $PUMP). */
export const FEE_UNIT = 1_000_000;

type Tx = { kind: StepKind; args: any; extra?: any; state: 'prepared' | 'landed' | 'failed'; out?: any };

export interface MemHooks {
  /** Return 'drop' to lose the tx silently, 'fail' to land it as failed. */
  onBroadcast?: (kind: StepKind, args: any, n: number) => 'drop' | 'fail' | void;
  onPrepare?: (kind: StepKind, args: any) => void;
  packResult?: (args: StepArgs['pack']) => StepResult['pack'] | void;
  holds?: (wallet: string) => boolean;
  delayMs?: number;
}

export class MemChain implements Chain {
  readonly tokenDecimals = 6;
  /** Creator fees not claimed yet, in fee-token base units. */
  unclaimed = 0n;
  /** Fee tokens sitting in the wallet, waiting to be swapped. */
  fees = 0n;
  /** The prize pool, in micro-USDC. */
  usdc = 0n;
  tokens = 0n;
  readonly packWallets = new Map<string, { usdc: bigint; lamports: bigint }>();
  readonly paid = { usdc: new Map<string, bigint>(), tokens: new Map<string, bigint>(), packs: [] as { to: string; tier: number; nft: string }[] };
  readonly txs = new Map<string, Tx>();
  broadcasts = 0;
  hooks: MemHooks = {};

  constructor(
    /** USD price of one fee token. */
    private readonly feeUsd: () => number,
    private readonly tokenUsd = 0.00004,
  ) {}

  /** Adds creator fees, given in fee tokens. */
  accrue(feeTokens: number) {
    this.unclaimed += BigInt(Math.floor(feeTokens * FEE_UNIT));
  }
  /** Adds creator fees worth this many dollars. */
  accrueUsd(usd: number) {
    this.accrue(usd / this.feeUsd());
  }

  private feesToUsdc(units: bigint) {
    return BigInt(Math.floor((Number(units) / FEE_UNIT) * this.feeUsd() * MICRO));
  }

  private async nap() {
    if (this.hooks.delayMs) await new Promise((r) => setTimeout(r, this.hooks.delayMs));
  }

  async prepare<K extends StepKind>(kind: K, args: StepArgs[K], _round: number): Promise<Prepared | null> {
    await this.nap();
    this.hooks.onPrepare?.(kind, args);
    const a = args as any;
    let extra: any;
    switch (kind) {
      case 'claim':
        if (this.unclaimed === 0n) return null;
        break;
      case 'swapFees':
        if (this.fees === 0n) return null;
        extra = { amount: this.fees };
        break;
      case 'swapToken':
        if (a.usdc > this.usdc) throw new Error('insufficient USDC');
        break;
      case 'fundPack':
        if (a.usdc > this.usdc) throw new Error('insufficient USDC');
        break;
      case 'pack': {
        const w = this.packWallets.get(a.packWallet);
        if (!w || w.usdc < BigInt(a.tier) * 1_000_000n) throw new Error('pack wallet short of USDC');
        break;
      }
      case 'sweepPack': {
        const w = this.packWallets.get(a.packWallet);
        if (!w || w.usdc === 0n) return null;
        extra = { usdc: w.usdc };
        break;
      }
      case 'sendUsdc':
        if (a.amount > this.usdc) throw new Error('insufficient USDC');
        break;
      case 'sendToken':
        if (a.amount > this.tokens) throw new Error('insufficient tokens');
        break;
    }
    const sig = fakeBase58(88);
    this.txs.set(sig, { kind, args, extra, state: 'prepared' });
    return { sig, blockhash: 'mem', raw: sig, extra };
  }

  async broadcast(kind: StepKind, p: Prepared): Promise<void> {
    await this.nap();
    const tx = this.txs.get(p.sig);
    if (!tx || tx.state !== 'prepared') return; // already landed: idempotent
    const verdict = this.hooks.onBroadcast?.(kind, tx.args, ++this.broadcasts);
    if (verdict === 'drop') return;
    if (verdict === 'fail') {
      tx.state = 'failed';
      return;
    }
    this.apply(tx);
    tx.state = 'landed';
  }

  private apply(tx: Tx) {
    const a = tx.args;
    switch (tx.kind) {
      case 'claim':
        this.fees += this.unclaimed;
        this.unclaimed = 0n;
        break;
      case 'swapFees': {
        // Swaps whatever is in the wallet when it lands, minus a 0.3% swap cost.
        const out = (this.feesToUsdc(this.fees) * 997n) / 1000n;
        this.fees = 0n;
        this.usdc += out;
        tx.out = { out };
        break;
      }
      case 'swapToken': {
        const out = BigInt(Math.floor(((Number(a.usdc) / MICRO) * 0.99) / this.tokenUsd) * 10 ** this.tokenDecimals);
        this.usdc -= a.usdc;
        this.tokens += out;
        tx.out = { out };
        break;
      }
      case 'fundPack': {
        const w = this.packWallets.get(a.packWallet) ?? { usdc: 0n, lamports: 0n };
        this.usdc -= a.usdc;
        w.usdc += a.usdc;
        w.lamports += a.lamports;
        this.packWallets.set(a.packWallet, w);
        break;
      }
      case 'pack': {
        const forced = this.hooks.packResult?.(a);
        const w = this.packWallets.get(a.packWallet)!;
        if (forced && !forced.ok && !forced.spent) {
          tx.out = forced;
          break;
        }
        w.usdc -= BigInt(a.tier) * 1_000_000n;
        if (forced) {
          tx.out = forced;
          break;
        }
        const nft = fakeBase58(44);
        const rarity = ['Common', 'Common', 'Common', 'Uncommon', 'Uncommon', 'Rare', 'Epic'][Math.floor(Math.random() * 7)]!;
        // Made-up card details so the demo shows what a real pull looks like.
        const [lo, hi] = ({ Common: [0.35, 0.9], Uncommon: [0.9, 1.7], Rare: [1.7, 4], Epic: [4, 12] } as Record<string, [number, number]>)[rarity]!;
        const insuredValue = Math.round(a.tier * (lo + Math.random() * (hi - lo)));
        const grade = ['PSA 8', 'PSA 9', 'PSA 10', 'CGC 9.5', 'BGS 9'][Math.floor(Math.random() * 5)]!;
        this.paid.packs.push({ to: a.to, tier: a.tier, nft });
        tx.out = { ok: true, nft, rarity, name: `Demo card #${1000 + Math.floor(Math.random() * 9000)} · ${grade}`, insuredValue };
        break;
      }
      case 'sweepPack': {
        const w = this.packWallets.get(a.packWallet)!;
        tx.out = { usdc: w.usdc };
        this.usdc += w.usdc;
        w.usdc = 0n;
        break;
      }
      case 'sendUsdc':
        this.usdc -= a.amount;
        this.paid.usdc.set(a.to, (this.paid.usdc.get(a.to) ?? 0n) + a.amount);
        break;
      case 'sendToken':
        this.tokens -= a.amount;
        this.paid.tokens.set(a.to, (this.paid.tokens.get(a.to) ?? 0n) + a.amount);
        break;
    }
  }

  async status(sig: string): Promise<TxStatus> {
    await this.nap();
    const tx = this.txs.get(sig);
    if (!tx) return 'expired';
    return tx.state === 'landed' ? 'landed' : tx.state === 'failed' ? 'failed' : 'expired';
  }

  async outcome<K extends StepKind>(_kind: K, sig: string): Promise<StepResult[K]> {
    return (this.txs.get(sig)?.out ?? {}) as StepResult[K];
  }

  async potUsdc() {
    return this.usdc;
  }
  async poolEstimateUsdc() {
    return this.usdc + this.feesToUsdc(this.fees + this.unclaimed);
  }
  async holds(wallet: string) {
    return this.hooks.holds ? this.hooks.holds(wallet) : true;
  }
  async isOrdinaryWallet() {
    return true;
  }
  async buybackChunks(usdc: bigint) {
    return Number(usdc) / MICRO > 500 ? 2 : 1;
  }
  async packTiers(wanted: number[]) {
    return wanted;
  }
  private readonly roundWallets = new Map<number, string>();
  async packWallet(round: number) {
    let w = this.roundWallets.get(round);
    if (!w) this.roundWallets.set(round, (w = fakeBase58(44)));
    return w;
  }
  async waitFinalized() {
    await this.nap();
    return true;
  }
  ownWallets() {
    return ['TREASURY'];
  }
}
