// Collector Crypt gacha: buying a pack and getting the card out of it.
//
// The flow and the checks follow a client that is known to work in production:
//   1. generatePack            -> an unsigned payment, co-signed by Collector Crypt
//   2. validatePackPayment     -> refuse anything that is not exactly "pay N USDC + the order memo"
//   3. sign, simulate
//   4. submitTransaction       -> sent THROUGH Collector Crypt so their indexer registers it
//   5. wait for pack.status "confirmed" (nudging with openPack if they are slow)
//   6. openPack                -> the card
//   7. wait for send.status "confirmed" and check the card went where it should
// Docs: https://docs.collectorcrypt.com/gacha/api

import { createPublicKey, verify } from 'node:crypto';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { ComputeBudgetProgram, PublicKey, TransactionMessage, type VersionedTransaction } from '@solana/web3.js';
import { sleep } from './rpc';

export interface OpenResult {
  ok: boolean;
  nft?: string;
  rarity?: string;
  name?: string;
  image?: string;
  insuredValue?: number;
  reason?: string;
  /** The pack was paid for, so the money is not sitting in the pack wallet any more. */
  spent?: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail = '',
  ) {
    super(`Collector Crypt returned HTTP ${status}${detail ? `: ${detail}` : ''}`);
  }
}

/** Collector Crypt refusing to sell from a machine right now. Nothing is charged. */
export const machineUnavailable = (e: unknown) => e instanceof ApiError && /machine is (low|off|empty)|off balance/i.test(e.detail);

export class Gacha {
  readonly paymentWallet: PublicKey;

  constructor(
    private readonly base: string,
    private readonly log: (m: string) => void,
    paymentWallet: string,
    private readonly apiKey = '',
  ) {
    this.paymentWallet = new PublicKey(paymentWallet);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(path: string, body?: unknown, timeoutMs = 15_000): Promise<any> {
    const res = await fetch(`${this.base}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      // Keep their own reason ("Machine is low", ...): it tells a retry from a give-up.
      const b = (await res.json().catch(() => null)) as { error?: unknown; details?: unknown; message?: unknown } | null;
      throw new ApiError(res.status, [b?.error, b?.details, b?.message].filter((x) => typeof x === 'string' && x).join(' · ').slice(0, 160));
    }
    return res.json();
  }

  static packType = (tier: number) => `pokemon_${tier}`;

  /** Which of the wanted tiers are public single-card machines, open and in stock right now. */
  async availableTiers(wanted: number[]): Promise<number[]> {
    const [catalog, status] = await Promise.all([this.request('/machines'), this.request('/status')]);
    if (!Array.isArray(catalog.machines)) throw new Error('unexpected machine catalog');
    if (status.machineStatus !== 'running') return [];
    return wanted.filter((t) => {
      const m = catalog.machines.find((x: { code: string }) => x.code === Gacha.packType(t));
      const stock = Object.values(m?.stock ?? {}) as unknown[];
      return (
        !!m &&
        m.public === true &&
        m.price === t &&
        m.contains === 1 &&
        stock.length > 0 &&
        stock.every((n) => Number.isFinite(n) && (n as number) > 0) &&
        (status.gachas ?? []).some((g: { code: string; isOpen?: boolean }) => g.code === m.code && g.isOpen)
      );
    });
  }

  /**
   * Reserves a pack and returns the unsigned payment. `payer` pays and, unless a
   * `recipient` is given, receives the card.
   */
  async generate(p: { payer: string; recipient?: string; tier: number }): Promise<{ transaction: string; memo: string }> {
    new PublicKey(p.payer);
    const catalog = await this.request('/machines');
    const machine = (catalog.machines ?? []).find((m: { code: string; price: number; contains: number }) => m.code === Gacha.packType(p.tier) && m.price === p.tier && m.contains === 1);
    if (!machine) throw new Error(`pack ${Gacha.packType(p.tier)} is not in the public catalog at $${p.tier}`);
    const order = await this.request('/generatePack', {
      playerAddress: p.payer,
      packType: machine.code,
      turbo: false,
      ...(p.recipient && p.recipient !== p.payer ? { altPlayerAddress: p.recipient } : {}),
    });
    if (typeof order.memo !== 'string' || typeof order.transaction !== 'string') throw new Error('invalid pack order');
    return { transaction: order.transaction, memo: order.memo };
  }

  /**
   * Broadcasts the signed payment through Collector Crypt, so they register it.
   * A raw RPC send alone is how packs end up paid on chain but invisible to them.
   */
  async submit(signedTransaction: string): Promise<{ signature: string; confirmationStatus?: string }> {
    // Their handler waits for confirmation, often several seconds.
    const r = await this.request('/submitTransaction', { signedTransaction }, 45_000);
    if (!r.success || typeof r.signature !== 'string') throw new Error('Collector Crypt did not accept the signed transaction');
    return { signature: r.signature, confirmationStatus: typeof r.confirmationStatus === 'string' ? r.confirmationStatus : undefined };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  packStatus(memo: string): Promise<any> {
    return this.request(`/pack/status?${new URLSearchParams({ memo })}`);
  }

  /** Opens an already-paid pack, or returns its existing award. Never buys anything. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  openPack(memo: string): Promise<any> {
    return this.request('/openPack', { memo });
  }

  /**
   * After the payment has landed: waits for Collector Crypt to register it,
   * opens the pack, and waits for the card to be delivered to `recipient`.
   */
  async settle(p: { memo: string; sig: string; payer: string; recipient: string; tier: number; timeoutMs?: number }): Promise<OpenResult> {
    const started = Date.now();
    const until = started + (p.timeoutMs ?? 240_000);
    let nudgedAt = 0;
    let last = 'timed out';
    while (Date.now() < until) {
      try {
        const status = await this.packStatus(p.memo);
        if (status.pack?.refunded) return { ok: false, spent: false, reason: 'Collector Crypt refunded this pack' };
        if (status.pack?.status !== 'confirmed') {
          // They normally register a paid pack within seconds. If not after 30s, ask them to open it,
          // as their own site does right after paying. At most once a minute.
          if (Date.now() - started >= 30_000 && Date.now() - nudgedAt >= 60_000) {
            nudgedAt = Date.now();
            await this.openPack(p.memo).catch(() => null);
          }
          last = 'waiting for Collector Crypt to see the confirmed payment';
          await sleep(2000);
          continue;
        }
        if (status.pack.wallet !== p.payer || status.pack.pack_type !== Gacha.packType(p.tier) || status.pack.transaction_signature !== p.sig) {
          return { ok: false, spent: true, reason: 'Collector Crypt purchase record does not match the saved payment' };
        }

        const opened = await this.openPack(p.memo);
        if (['WAITING_FOR_WEBHOOK', 'SEND_PENDING'].includes(opened.code)) {
          last = 'card delivery pending';
          await sleep(1500);
          continue;
        }
        if (opened.code === 'TURBO_MODE_BUYBACK' || !opened.nft_address) return { ok: false, spent: true, reason: `unexpected pack result (${opened.code ?? 'no card'})` };

        const delivered = await this.packStatus(p.memo);
        if (delivered.send?.status !== 'confirmed') {
          last = 'waiting for confirmed card delivery';
          await sleep(1500);
          continue;
        }
        const card = normalizeCard(opened, delivered);
        if (delivered.send.nft_address !== opened.nft_address) return { ok: false, spent: true, reason: 'delivered card does not match the opened pack' };
        if (delivered.send.to_wallet !== p.recipient) {
          return { ok: false, spent: true, ...card, reason: `card ${opened.nft_address} was delivered to ${delivered.send.to_wallet}, not to the winner; it needs to be transferred by hand` };
        }
        return { ok: true, ...card };
      } catch (e) {
        last = (e as Error).message;
        if (!(e instanceof ApiError && [404, 429, 503].includes(e.status))) this.log(`pack ${p.memo}: ${last}`);
        await sleep(2000);
      }
    }
    return { ok: false, spent: true, reason: `pack ${p.memo} was paid but not opened in time (${last}); Collector Crypt refunds unopened packs after about two hours` };
  }
}

/** Pulls name, image, insured value and rarity out of an opened pack. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeCard(opened: any, status: any): { nft: string; name: string; image?: string; insuredValue?: number; rarity?: string } {
  const nft = opened.nftWon ?? {};
  const metadata = nft.content?.metadata ?? nft.metadata ?? {};
  const attributes: { trait_type?: string; value?: unknown }[] = Array.isArray(metadata.attributes) ? metadata.attributes : [];
  const rawValue = status.send?.insured_value ?? attributes.find((a) => /insured.?value/i.test(a.trait_type ?? ''))?.value;
  const value = rawValue == null || rawValue === '' ? NaN : Number(rawValue);
  const rawImage = nft.content?.links?.image ?? nft.content?.files?.[0]?.uri ?? metadata.image ?? nft.image;
  let image: string | undefined;
  try {
    const url = new URL(rawImage);
    if (url.protocol === 'https:' && !url.username && !url.password) image = url.href;
  } catch {
    /* no usable image */
  }
  return {
    nft: new PublicKey(opened.nft_address).toBase58(),
    name: metadata.name ?? nft.name ?? 'Collector Crypt card',
    image,
    insuredValue: Number.isFinite(value) && value >= 0 ? value : undefined,
    rarity: opened.rarity ?? undefined,
  };
}

const MEMO_PROGRAMS = new Set(['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo']);
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const verifyEd25519 = (message: Uint8Array, signature: Uint8Array, pubkey: Uint8Array) =>
  verify(null, message, createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(pubkey)]), format: 'der', type: 'spki' }), signature);

/**
 * Refuses to sign anything other than: one transfer of exactly `amount` USDC
 * from the buyer to Collector Crypt, the order's memo, and optionally a
 * compute budget and the creation of Collector Crypt's own USDC account.
 * It checks what the transaction says, not just what it would cost.
 */
export function validatePackPayment(tx: VersionedTransaction, buyer: PublicKey, recipient: PublicKey, mint: PublicKey, amount: bigint, memo: string) {
  const no = (why: string): never => {
    throw new Error(`pack payment refused: ${why}`);
  };
  if (amount <= 0n || amount > 5_000_000_000n || amount % 1_000_000n !== 0n || !/^[a-zA-Z0-9_-]{1,64}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(memo)) no('invalid purchase intent');
  if (tx.message.addressTableLookups.length) no('it uses address tables');
  const message = TransactionMessage.decompile(tx.message);
  const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
  const sponsored = message.payerKey.equals(recipient);
  const providerIndex = signers.findIndex((k) => k.equals(recipient));
  // Either we pay the fee or Collector Crypt does; they co-sign the memo either way. Nobody else may sign.
  if (
    (!sponsored && !message.payerKey.equals(buyer)) ||
    signers.length < 1 ||
    signers.length > 2 ||
    (sponsored && signers.length !== 2) ||
    !signers.some((k) => k.equals(buyer)) ||
    signers.some((k) => !k.equals(buyer) && !k.equals(recipient))
  ) {
    no(`unexpected signer or fee payer ${message.payerKey.toBase58()} (expected Collector Crypt at ${recipient.toBase58()}; check COLLECTOR_CRYPT_PAYMENT_WALLET)`);
  }
  if (providerIndex >= 0 && !verifyEd25519(tx.message.serialize(), tx.signatures[providerIndex]!, recipient.toBytes())) no("Collector Crypt's signature is missing or invalid");

  const source = getAssociatedTokenAddressSync(mint, buyer);
  const destination = getAssociatedTokenAddressSync(mint, recipient);
  let payments = 0;
  let memos = 0;
  let creates = 0;
  let units = 200_000;
  let microLamports = 0n;
  const budgets = new Set<number>();
  for (const ix of message.instructions) {
    if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      const checked = ix.data[0] === 12;
      const transfer = ix.data[0] === 3;
      const keyCount = checked ? 4 : 3;
      // Collector Crypt repeats the buyer in the optional signer list. Allow that exact duplicate only.
      if ((!checked && !transfer) || ix.data.length !== (checked ? 10 : 9) || ix.keys.length < keyCount || ix.keys.length > keyCount + 1 || ix.keys.slice(keyCount).some((k) => !k.pubkey.equals(buyer) || !k.isSigner)) no('unsupported token operation');
      const to = ix.keys[checked ? 2 : 1]!;
      const authority = ix.keys[checked ? 3 : 2]!;
      if (!ix.keys[0]!.pubkey.equals(source) || !to.pubkey.equals(destination) || !authority.pubkey.equals(buyer) || !authority.isSigner || ix.data.readBigUInt64LE(1) !== amount || (checked && (!ix.keys[1]!.pubkey.equals(mint) || ix.data[9] !== 6))) {
        no('payment asset, recipient or amount mismatch');
      }
      payments++;
    } else if (MEMO_PROGRAMS.has(ix.programId.toBase58())) {
      if (ix.data.toString('utf8') !== `${memo}:open` || ix.keys.some((k) => !k.pubkey.equals(buyer) && !k.pubkey.equals(recipient))) no('memo does not match the reserved purchase');
      memos++;
    } else if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      const op = ix.data[0]!;
      if (ix.keys.length || budgets.has(op)) no('invalid compute budget');
      budgets.add(op);
      if (op === 2 && ix.data.length === 5) units = ix.data.readUInt32LE(1);
      else if (op === 3 && ix.data.length === 9) microLamports = ix.data.readBigUInt64LE(1);
      else no('unsupported compute budget');
    } else if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      // Only an idempotent creation of Collector Crypt's own USDC account.
      const expected = [message.payerKey, destination, recipient, mint, PublicKey.default, TOKEN_PROGRAM_ID];
      if (ix.data.length !== 1 || ix.data[0] !== 1 || ix.keys.length !== 6 || ix.keys.some((k, i) => !k.pubkey.equals(expected[i]!))) no('unexpected token account creation');
      creates++;
    } else no(`unexpected instruction for program ${ix.programId.toBase58()}`);
  }
  if (payments !== 1 || memos !== 1 || creates > 1 || units < 1 || units > 400_000 || (BigInt(units) * microLamports) / 1_000_000n > 1_000_000n) no('payment shape or fee exceeds policy');
}
