// Mainnet implementation of the Chain interface: creator-fee claims, Jupiter
// swaps, token transfers and Collector Crypt packs.
//
// Money model: creator fees arrive in the coin's quote asset ($PUMP, or SOL for
// a plain SOL coin). Before each payout they are claimed and swapped into USDC.
// The prize pool is simply the USDC in the treasury, so USDC anyone sends there
// counts. SOL in the treasury is only ever used for network fees.
//
// The treasury key is used only inside this file, and only to sign:
//   - the pump.fun fee claim,
//   - swaps whose simulated SOL cost matches what was asked for,
//   - transfers to wallets recorded as winners of the round being paid.

import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram, type Connection, type TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { Db } from '../db';
import type { Chain, Prepared, StepArgs, StepKind, StepResult, TxStatus } from '../payout/chain';
import { MICRO } from '../payout/chain';
import type { Winner } from '../engine/winners';
import type { Jupiter } from './jupiter';
import { validatePackPayment, type Gacha } from './packs';
import { OnlinePumpSdk, PUMP_AMM_SDK, PUMP_SDK, canonicalPumpPoolPda } from './pumpSdk';
import { USDC, WSOL, asPrepared, assertSpend, build, fromB64, isOnCurve, sleep, txStatus } from './rpc';

export interface LiveOpts {
  conn: Connection;
  db: Db;
  treasury: Keypair;
  mint: PublicKey;
  /** What the coin trades against and creator fees arrive in. Undefined or wSOL means SOL. */
  quoteMint?: PublicKey;
  /** USD price of one whole unit of the quote asset. */
  quoteUsd: () => number;
  jupiter: Jupiter;
  gacha: Gacha;
  /** SOL always left in the treasury for network fees. */
  gasFloatLamports: bigint;
  slippageBps: number;
  priorityMicroLamports: number;
  log: (m: string) => void;
}

const USDC_MINT = new PublicKey(USDC);
const WSOL_MINT = new PublicKey(WSOL);
const SYSTEM = SystemProgram.programId.toBase58();
const MAX_SWAP_FEES = 20_000_000n; // 0.02 SOL: the most a swap may cost in SOL beyond what it sells
const bn = (v: { toString(): string } | null | undefined) => (v ? BigInt(v.toString()) : 0n);

export class LiveChain implements Chain {
  tokenDecimals = 6;
  private tokenProgram: PublicKey = TOKEN_PROGRAM_ID;
  private quoteDecimals = 9;
  private quoteProgram: PublicKey = TOKEN_PROGRAM_ID;
  private readonly quoteIsSol: boolean;
  private readonly quote: PublicKey;
  private readonly pump: OnlinePumpSdk;
  private estimateCache = { at: 0, value: 0n };

  constructor(private readonly o: LiveOpts) {
    this.pump = new OnlinePumpSdk(o.conn);
    this.quoteIsSol = !o.quoteMint || o.quoteMint.equals(WSOL_MINT);
    this.quote = this.quoteIsSol ? WSOL_MINT : o.quoteMint!;
  }

  private get me() {
    return this.o.treasury.publicKey;
  }

  /** The coin's PumpSwap pool address (only exists once the coin has graduated). */
  private get pool() {
    return canonicalPumpPoolPda(this.o.mint, this.quoteIsSol ? undefined : this.quote);
  }

  private async mintInfo(mint: PublicKey) {
    const info = await this.o.conn.getParsedAccountInfo(mint, 'confirmed');
    if (!info.value) throw new Error(`mint ${mint.toBase58()} not found on chain`);
    const program = info.value.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const decimals = (info.value.data as { parsed?: { info?: { decimals?: number } } }).parsed?.info?.decimals;
    if (typeof decimals !== 'number') throw new Error(`${mint.toBase58()} is not a token mint`);
    return { program, decimals };
  }

  /** Reads the coin and quote token details and checks the treasury really is the coin's creator. */
  async init() {
    const { mint, log } = this.o;
    const coin = await this.mintInfo(mint);
    this.tokenProgram = coin.program;
    this.tokenDecimals = coin.decimals;
    if (!this.quoteIsSol) {
      const q = await this.mintInfo(this.quote);
      this.quoteProgram = q.program;
      this.quoteDecimals = q.decimals;
    }
    const curve = await this.pump.fetchBondingCurve(mint).catch(() => null);
    if (curve) {
      if (!curve.creator.equals(this.me)) log(`WARNING: the coin's creator is ${curve.creator.toBase58()}, not the treasury ${this.me.toBase58()}. Creator fees will NOT reach this wallet.`);
      const curveQuoteIsSol = curve.quoteMint.equals(PublicKey.default) || curve.quoteMint.equals(WSOL_MINT);
      if (curveQuoteIsSol !== this.quoteIsSol || (!curveQuoteIsSol && !curve.quoteMint.equals(this.quote))) {
        log(`WARNING: the coin is quoted in ${curveQuoteIsSol ? 'SOL' : curve.quoteMint.toBase58()} on chain, but QUOTE_MINT says ${this.quoteIsSol ? 'SOL' : this.quote.toBase58()}. Fix QUOTE_MINT or fees will not be found.`);
      }
    }
    const sol = await this.o.conn.getBalance(this.me, 'confirmed');
    if (BigInt(sol) < this.o.gasFloatLamports) log(`WARNING: the treasury holds only ${(sol / 1e9).toFixed(4)} SOL. It needs SOL for network fees; payouts will stall without it.`);
    log(`treasury ${this.me.toBase58()} · fees arrive in ${this.quoteIsSol ? 'SOL' : this.quote.toBase58()} · pool is USDC`);
  }

  ownWallets() {
    return [this.me.toBase58()];
  }

  // ---------- reads ----------

  private async tokenBalance(mint: PublicKey, program: PublicKey, owner = this.me): Promise<bigint> {
    const bal = await this.o.conn.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, owner, true, program), 'confirmed').catch(() => null);
    return BigInt(bal?.value.amount ?? '0');
  }

  /** The prize pool: USDC in the treasury, whoever sent it. */
  potUsdc(): Promise<bigint> {
    return this.tokenBalance(USDC_MINT, TOKEN_PROGRAM_ID);
  }

  /** Fee tokens already in the wallet and free to swap (for SOL, everything above the gas float). */
  private async feesHeld(): Promise<bigint> {
    if (!this.quoteIsSol) return this.tokenBalance(this.quote, this.quoteProgram);
    const bal = BigInt(await this.o.conn.getBalance(this.me, 'confirmed'));
    return bal > this.o.gasFloatLamports ? bal - this.o.gasFloatLamports : 0n;
  }

  /** Creator fees still in the vaults, plus fees not swept out of the curve / pool yet. In quote base units. */
  private async unclaimed(): Promise<bigint> {
    const { conn, mint } = this.o;
    let total = 0n;
    if (this.quoteIsSol) total += bn(await this.pump.getCreatorVaultBalanceBothPrograms(this.me));
    else {
      const balances = await this.pump.getCreatorVaultQuoteBalances(this.me, [this.quote]);
      total += bn(balances.find((b) => b.mint.equals(this.quote))?.total);
    }
    const curve = await this.pump.fetchBondingCurve(mint).catch(() => null);
    if (curve) total += bn(curve.creatorFee);
    const poolInfo = await conn.getAccountInfo(this.pool, 'confirmed');
    if (poolInfo) {
      const pool = PUMP_AMM_SDK.decodePoolNullable(poolInfo) as { creatorFees?: { toString(): string }; quoteMint?: PublicKey } | null;
      if (pool?.quoteMint?.equals(this.quote)) total += bn(pool.creatorFees);
    }
    return total;
  }

  private quoteToUsdc(units: bigint): bigint {
    return BigInt(Math.floor((Number(units) / 10 ** this.quoteDecimals) * this.o.quoteUsd() * MICRO));
  }

  async poolEstimateUsdc(): Promise<bigint> {
    if (Date.now() - this.estimateCache.at < 15_000) return this.estimateCache.value;
    const [usdc, held, unclaimed] = await Promise.all([this.potUsdc(), this.feesHeld(), this.unclaimed()]);
    const value = usdc + this.quoteToUsdc(held + unclaimed);
    this.estimateCache = { at: Date.now(), value };
    return value;
  }

  async holds(wallet: string, minTokens: number): Promise<boolean> {
    const res = await this.o.conn.getParsedTokenAccountsByOwner(new PublicKey(wallet), { mint: this.o.mint }, 'confirmed');
    const total = res.value.reduce((a, acc) => a + Number((acc.account.data as { parsed: { info: { tokenAmount: { uiAmountString?: string } } } }).parsed.info.tokenAmount.uiAmountString ?? 0), 0);
    return total >= minTokens;
  }

  async isOrdinaryWallet(wallet: string): Promise<boolean> {
    if (!isOnCurve(wallet)) return false;
    const info = await this.o.conn.getAccountInfo(new PublicKey(wallet), 'confirmed');
    return !info || (info.owner.toBase58() === SYSTEM && !info.executable);
  }

  async buybackChunks(usdc: bigint): Promise<number> {
    try {
      const q = await this.o.jupiter.order({ inputMint: USDC, outputMint: this.o.mint.toBase58(), amount: usdc, slippageBps: this.o.slippageBps });
      const raw = Number(q.priceImpactPct ?? q.priceImpact ?? 0);
      const impactPct = Math.abs(raw) < 1 ? Math.abs(raw) * 100 : Math.abs(raw); // fraction or percent, depending on the API version
      return Math.max(1, Math.ceil(impactPct / (this.o.slippageBps / 100)));
    } catch (e) {
      this.o.log(`could not quote the buyback, sending it in one piece: ${(e as Error).message}`);
      return 1;
    }
  }

  packTiers(wanted: number[]) {
    return this.o.gacha.availableTiers(wanted);
  }

  private packKeypair(address: string): Keypair {
    const secret = this.o.db.get<string>(`packWalletSecret:${address}`);
    if (!secret) throw new Error(`unknown pack wallet ${address}`);
    return Keypair.fromSecretKey(bs58.decode(secret));
  }

  async packWallet(round: number): Promise<string> {
    const { db } = this.o;
    const existing = db.get<string>(`packWallet:${round}`);
    if (existing) return existing;
    const kp = Keypair.generate();
    const address = kp.publicKey.toBase58();
    db.tx(() => {
      db.set(`packWalletSecret:${address}`, bs58.encode(kp.secretKey));
      db.set(`packWallet:${round}`, address);
    });
    return address;
  }

  async waitFinalized(sig: string): Promise<boolean> {
    const started = Date.now();
    for (;;) {
      const st = (await this.o.conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
      if (st?.err) return false;
      if (st?.confirmationStatus === 'finalized') return true;
      const waited = Date.now() - started;
      if (!st && waited > 60_000) return false; // gone: the fork it was on lost
      if (waited > 150_000) return !!st;
      await sleep(1500);
    }
  }

  // ---------- transactions ----------

  /** Transfers and packs may only go to wallets recorded as winners of that round. */
  private assertWinner(round: number, to: string) {
    const winners = (this.o.db.step(`r${round}:winners`)?.result as Winner[] | undefined) ?? [];
    if (!winners.some((w) => w.wallet === to)) throw new Error(`${to} is not a recorded winner of round ${round}; refusing to sign`);
  }

  private transferIxs(mint: PublicKey, program: PublicKey, decimals: number, from: PublicKey, to: PublicKey, amount: bigint, payer: PublicKey): TransactionInstruction[] {
    const src = getAssociatedTokenAddressSync(mint, from, true, program);
    const dst = getAssociatedTokenAddressSync(mint, to, true, program);
    return [createAssociatedTokenAccountIdempotentInstruction(payer, dst, to, mint, program), createTransferCheckedInstruction(src, mint, dst, from, amount, decimals, [], program)];
  }

  /** A Jupiter swap from the treasury. `solSold` is how much SOL the swap itself is allowed to take. */
  private async swap(inputMint: string, outputMint: string, amount: bigint, solSold: bigint, label: string): Promise<Prepared> {
    const { jupiter, conn, treasury, slippageBps } = this.o;
    const order = await jupiter.order({ inputMint, outputMint, amount, taker: this.me.toBase58(), slippageBps });
    if (!order.transaction) throw new Error(`Jupiter returned no route for the ${label}: ${order.errorMessage ?? order.error ?? 'no transaction'}`);
    const tx = fromB64(order.transaction);
    tx.sign([treasury]);
    await assertSpend(conn, tx, this.me, solSold + MAX_SWAP_FEES, label);
    return asPrepared(tx, { via: 'jupiter', requestId: order.requestId, amount });
  }

  async prepare<K extends StepKind>(kind: K, args: StepArgs[K], round: number): Promise<Prepared | null> {
    const { conn, treasury, mint, priorityMicroLamports: fee, gacha } = this.o;
    const a = args as any;
    switch (kind) {
      case 'claim': {
        const unclaimed = await this.unclaimed();
        if (this.quoteToUsdc(unclaimed) < 500_000n) return null; // under about $0.50: not worth a transaction
        const ixs: TransactionInstruction[] = [];
        const curve = await this.pump.fetchBondingCurve(mint).catch(() => null);
        // Fees first have to be swept out of the curve and the pool into the creator vaults.
        if (curve) ixs.push(await PUMP_SDK.sweepCreatorFeeInstruction({ payer: this.me, mint, creator: curve.creator, quoteMint: curve.quoteMint }));
        const poolInfo = await conn.getAccountInfo(this.pool, 'confirmed');
        if (poolInfo) {
          const pool = PUMP_AMM_SDK.decodePool(poolInfo);
          ixs.push(await PUMP_SDK.sweepPoolCreatorFeeInstruction({ payer: this.me, mint, coinCreator: pool.coinCreator, quoteMint: pool.quoteMint }));
        }
        ixs.push(
          ...(this.quoteIsSol
            ? await this.pump.collectCoinCreatorFeeInstructions(this.me, this.me)
            : await this.pump.collectCoinCreatorFeeV2Instructions(this.me, this.quote, this.quoteProgram, this.me)),
        );
        this.estimateCache.at = 0;
        return asPrepared(await build(conn, this.me, ixs, [treasury], fee));
      }
      case 'swapFees': {
        const held = await this.feesHeld();
        if (this.quoteToUsdc(held) < 500_000n) return null; // dust
        this.estimateCache.at = 0;
        return this.swap(this.quote.toBase58(), USDC, held, this.quoteIsSol ? held : 0n, 'fee swap to USDC');
      }
      case 'swapToken':
        return this.swap(USDC, mint.toBase58(), a.usdc, 0n, 'buyback');
      case 'fundPack': {
        const pack = new PublicKey(a.packWallet);
        const ixs = [...this.transferIxs(USDC_MINT, TOKEN_PROGRAM_ID, 6, this.me, pack, a.usdc, this.me), SystemProgram.transfer({ fromPubkey: this.me, toPubkey: pack, lamports: a.lamports })];
        return asPrepared(await build(conn, this.me, ixs, [treasury], fee));
      }
      case 'pack': {
        this.assertWinner(round, a.to);
        const kp = this.packKeypair(a.packWallet);
        const { transaction, memo } = await gacha.generate({ payer: a.packWallet, recipient: a.to, tier: a.tier });
        const tx = fromB64(transaction);
        // Sign only if it is exactly "pay this many USDC to Collector Crypt, with this order's memo".
        validatePackPayment(tx, kp.publicKey, gacha.paymentWallet, USDC_MINT, BigInt(a.tier) * 1_000_000n, memo);
        if (!(await conn.isBlockhashValid(tx.message.recentBlockhash, { commitment: 'confirmed' })).value) throw new Error('pack order expired before it could be signed');
        tx.sign([kp]);
        const sim = await conn.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
        if (sim.value.err) throw new Error(`pack payment simulation failed: ${JSON.stringify(sim.value.err)}`);
        return asPrepared(tx, { memo });
      }
      case 'sweepPack': {
        const kp = this.packKeypair(a.packWallet);
        const ata = getAssociatedTokenAddressSync(USDC_MINT, kp.publicKey, true);
        const bal = await conn.getTokenAccountBalance(ata, 'confirmed').catch(() => null);
        const usdc = BigInt(bal?.value.amount ?? '0');
        const lamports = BigInt(await conn.getBalance(kp.publicKey, 'confirmed'));
        if (usdc === 0n && lamports === 0n) return null;
        const ixs: TransactionInstruction[] = [];
        if (usdc > 0n) ixs.push(...this.transferIxs(USDC_MINT, TOKEN_PROGRAM_ID, 6, kp.publicKey, this.me, usdc, this.me));
        if (bal) ixs.push(createCloseAccountInstruction(ata, this.me, kp.publicKey));
        if (lamports > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: this.me, lamports }));
        return asPrepared(await build(conn, this.me, ixs, [treasury, kp], fee), { usdc });
      }
      case 'sendUsdc': {
        this.assertWinner(round, a.to);
        return asPrepared(await build(conn, this.me, this.transferIxs(USDC_MINT, TOKEN_PROGRAM_ID, 6, this.me, new PublicKey(a.to), a.amount, this.me), [treasury], fee));
      }
      case 'sendToken': {
        this.assertWinner(round, a.to);
        return asPrepared(await build(conn, this.me, this.transferIxs(mint, this.tokenProgram, this.tokenDecimals, this.me, new PublicKey(a.to), a.amount, this.me), [treasury], fee));
      }
    }
    throw new Error(`unknown step ${kind}`);
  }

  async broadcast(kind: StepKind, p: Prepared): Promise<void> {
    const extra = (p.extra ?? {}) as { via?: string; requestId?: string; memo?: string };
    if (kind === 'pack') {
      // Through Collector Crypt first, so their indexer registers the payment; plain RPC as a fallback.
      try {
        await this.o.gacha.submit(p.raw);
      } catch (e) {
        this.o.log(`Collector Crypt submit failed (${(e as Error).message}), sending through the RPC instead`);
        await this.o.conn.sendRawTransaction(Buffer.from(p.raw, 'base64'), { skipPreflight: false, maxRetries: 2 });
      }
      return;
    }
    if (extra.via === 'jupiter' && extra.requestId) {
      await this.o.jupiter.execute(p.raw, extra.requestId);
      return;
    }
    await this.o.conn.sendRawTransaction(Buffer.from(p.raw, 'base64'), { skipPreflight: false, maxRetries: 5, preflightCommitment: 'confirmed' });
  }

  status(sig: string, blockhash: string): Promise<TxStatus> {
    return txStatus(this.o.conn, sig, blockhash);
  }

  /** How much of `mint` the owner gained in a landed transaction. */
  private async received(sig: string, owner: string, mint: string): Promise<bigint> {
    for (let i = 0; i < 20; i++) {
      const tx = await this.o.conn.getTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' });
      if (tx?.meta) {
        const sum = (list: typeof tx.meta.postTokenBalances) => (list ?? []).filter((b) => b.mint === mint && b.owner === owner).reduce((acc, b) => acc + BigInt(b.uiTokenAmount.amount), 0n);
        const got = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
        return got > 0n ? got : 0n;
      }
      await sleep(1000);
    }
    throw new Error(`could not load transaction ${sig} to read the swap result`);
  }

  async outcome<K extends StepKind>(kind: K, sig: string, args: StepArgs[K], extra: unknown): Promise<StepResult[K]> {
    const x = (extra ?? {}) as { memo?: string; usdc?: bigint };
    let result: unknown = {};
    if (kind === 'swapFees') result = { out: await this.received(sig, this.me.toBase58(), USDC) };
    else if (kind === 'swapToken') result = { out: await this.received(sig, this.me.toBase58(), this.o.mint.toBase58()) };
    else if (kind === 'sweepPack') result = { usdc: BigInt(x.usdc ?? 0n) };
    else if (kind === 'pack') {
      const a = args as StepArgs['pack'];
      result = await this.o.gacha.settle({ memo: x.memo ?? '', sig, payer: a.packWallet, recipient: a.to, tier: a.tier });
    }
    this.estimateCache.at = 0;
    return result as StepResult[K];
  }
}
