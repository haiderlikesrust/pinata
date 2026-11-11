import { describe, expect, it } from 'vitest';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { normalizeCard, validatePackPayment } from '../src/live/packs';
import { USDC } from '../src/live/rpc';

const usdc = new PublicKey(USDC);
const buyer = Keypair.generate();
const cc = Keypair.generate(); // stands in for Collector Crypt's payment wallet
const MEMO = 'cc-0b1e6f0a-7c2d-4e5f-8a9b-0c1d2e3f4a5b';
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

/** A payment shaped like the one Collector Crypt returns: pay USDC + a memo both parties sign. */
function payment(o: { amount?: bigint; memo?: string; extra?: TransactionInstruction[]; ccSigns?: boolean; to?: PublicKey } = {}) {
  const pay = createTransferCheckedInstruction(getAssociatedTokenAddressSync(usdc, buyer.publicKey), usdc, getAssociatedTokenAddressSync(usdc, o.to ?? cc.publicKey), buyer.publicKey, o.amount ?? 25_000_000n, 6);
  const memo = new TransactionInstruction({
    programId: MEMO_PROGRAM,
    keys: [
      { pubkey: buyer.publicKey, isSigner: true, isWritable: false },
      { pubkey: cc.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(`${o.memo ?? MEMO}:open`, 'utf8'),
  });
  const msg = new TransactionMessage({ payerKey: buyer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [pay, memo, ...(o.extra ?? [])] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  if (o.ccSigns !== false) tx.sign([cc]);
  return tx;
}
const check = (tx: VersionedTransaction, amount = 25_000_000n, memo = MEMO) => validatePackPayment(tx, buyer.publicKey, cc.publicKey, usdc, amount, memo);

describe('validatePackPayment', () => {
  it('accepts exactly "pay the pack price to Collector Crypt, with the order memo"', () => {
    expect(() => check(payment())).not.toThrow();
  });
  it('refuses a different amount', () => {
    expect(() => check(payment({ amount: 100_000_000n }))).toThrow(/amount mismatch/);
  });
  it('refuses a different destination', () => {
    expect(() => check(payment({ to: Keypair.generate().publicKey }))).toThrow(/recipient or amount mismatch/);
  });
  it('refuses a memo for another order', () => {
    expect(() => check(payment({ memo: 'cc-ffffffff-7c2d-4e5f-8a9b-0c1d2e3f4a5b' }))).toThrow(/memo/);
  });
  it('refuses any extra instruction, such as a SOL transfer', () => {
    const drain = SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: cc.publicKey, lamports: 1_000_000_000 });
    expect(() => check(payment({ extra: [drain] }))).toThrow(/unexpected instruction/);
  });
  it("refuses a payment Collector Crypt has not signed", () => {
    expect(() => check(payment({ ccSigns: false }))).toThrow(/signature is missing or invalid/);
  });
});

describe('normalizeCard', () => {
  const nft = Keypair.generate().publicKey.toBase58();
  it('reads name, image, rarity and insured value', () => {
    const card = normalizeCard(
      { nft_address: nft, rarity: 'Rare', nftWon: { content: { metadata: { name: 'Sample card PSA 9' }, links: { image: 'https://example.com/card.png' } } } },
      { send: { insured_value: 84 } },
    );
    expect(card).toEqual({ nft, name: 'Sample card PSA 9', image: 'https://example.com/card.png', insuredValue: 84, rarity: 'Rare' });
  });
  it('drops images that are not plain https and falls back to the attribute for value', () => {
    const card = normalizeCard(
      { nft_address: nft, nftWon: { content: { metadata: { name: 'X', attributes: [{ trait_type: 'Insured Value', value: '31.5' }] }, links: { image: 'javascript:alert(1)' } } } },
      {},
    );
    expect(card.image).toBeUndefined();
    expect(card.insuredValue).toBe(31.5);
  });
});
