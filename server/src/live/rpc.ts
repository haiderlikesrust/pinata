// Small helpers shared by the live adapters.

import fs from 'node:fs';
import bs58 from 'bs58';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type Signer,
  type TransactionInstruction,
} from '@solana/web3.js';
import type { Prepared, TxStatus } from '../payout/chain';

export const WSOL = 'So11111111111111111111111111111111111111112';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Reads the treasury key. It is never logged or returned anywhere else. */
export function loadKeypair(secret?: string, keyfile?: string): Keypair {
  let raw = secret;
  if (!raw && keyfile) raw = fs.readFileSync(keyfile, 'utf8').trim();
  if (!raw) throw new Error('no treasury key configured');
  const bytes = raw.trim().startsWith('[') ? Uint8Array.from(JSON.parse(raw) as number[]) : bs58.decode(raw.trim());
  return Keypair.fromSecretKey(bytes);
}

export const b64 = (tx: VersionedTransaction) => Buffer.from(tx.serialize()).toString('base64');
/** Decodes a transaction someone else built. web3.js 1.x can read version-1 transactions but cannot sign them. */
export const fromB64 = (raw: string) => {
  const tx = VersionedTransaction.deserialize(Buffer.from(raw, 'base64'));
  if (tx.version !== 0 && tx.version !== 'legacy') throw new Error(`transaction is version ${String(tx.version)}, which this server cannot sign yet; nothing was signed`);
  return tx;
};

export function txSignature(tx: VersionedTransaction): string {
  const sig = tx.signatures[0];
  if (!sig || sig.every((b) => b === 0)) throw new Error('transaction has no fee-payer signature yet');
  return bs58.encode(sig);
}

export function asPrepared(tx: VersionedTransaction, extra?: unknown): Prepared {
  return { sig: txSignature(tx), blockhash: tx.message.recentBlockhash, raw: b64(tx), extra };
}

/** Builds and signs a v0 transaction. Does not send it. */
export async function build(conn: Connection, payer: PublicKey, ixs: TransactionInstruction[], signers: Signer[], microLamports: number): Promise<VersionedTransaction> {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), ...ixs],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  return tx;
}

/**
 * landed  = confirmed or finalized without error
 * failed  = on chain with an error
 * expired = not on chain and its blockhash can no longer be used, so it never will be
 */
export async function txStatus(conn: Connection, sig: string, blockhash: string): Promise<TxStatus> {
  const read = async (): Promise<TxStatus | null> => {
    const st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
    if (!st) return null;
    if (st.err) return 'failed';
    return st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized' ? 'landed' : 'pending';
  };
  const first = await read();
  if (first) return first;
  const valid = (await conn.isBlockhashValid(blockhash, { commitment: 'finalized' })).value;
  if (valid) return 'pending';
  // The blockhash is dead as of a finalized slot. One last look, then it is certain.
  return (await read()) ?? 'expired';
}

/**
 * Simulates a transaction someone else built and refuses it if it would take
 * more SOL from `owner` than expected.
 */
export async function assertSpend(conn: Connection, tx: VersionedTransaction, owner: PublicKey, maxLamports: bigint, label: string) {
  const before = BigInt(await conn.getBalance(owner, 'confirmed'));
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [owner.toBase58()] } });
  if (sim.value.err) throw new Error(`${label}: simulation failed: ${JSON.stringify(sim.value.err)}`);
  const after = sim.value.accounts?.[0]?.lamports;
  if (after == null) throw new Error(`${label}: simulation returned no balance`);
  const spent = before - BigInt(after);
  if (spent > maxLamports) throw new Error(`${label}: would spend ${spent} lamports, more than the ${maxLamports} allowed`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const isOnCurve = (address: string) => {
  try {
    return PublicKey.isOnCurve(new PublicKey(address).toBytes());
  } catch {
    return false;
  }
};
