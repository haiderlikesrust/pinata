import type { ReactNode } from 'react';
import { fmtUsd, shortWallet, type PackResult, type RoundSummary, type WinnerPublic } from '@pinata/shared';
import { useStore } from '../store';
import { useCountdown } from './Hud';
import { IconClose, IconCoin, IconDollar, IconLink, IconPack } from './icons';

const tx = (sig: string) => `https://solscan.io/tx/${sig}`;
const acct = (a: string) => `https://solscan.io/account/${a}`;
const compact = (n: number) => n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const rarityClass = (r?: string) => (r ?? 'common').split(' ')[0]!.toLowerCase();

/** What a delivered pack is worth: the card's insured value when known, otherwise what the pack cost. */
const packValue = (p: PackResult) => (p.status === 'delivered' ? (p.insuredValue ?? p.tier) : 0);
/** Older rounds were saved before totals existed, so work one out from what is there. */
const totalOf = (w: WinnerPublic) => w.totalUsd ?? w.packs.reduce((a, p) => a + packValue(p), 0) + (w.usdc ?? 0) + (w.tokensUsd ?? 0);

/** Link to the transaction that sent a reward. Demo mode has no real transaction to open. */
function Proof({ sig, live }: { sig?: string; live: boolean }) {
  if (!sig) return <span className="proof none" />;
  if (!live)
    return (
      <span className="proof demo" title="Demo mode: this transfer is simulated, so there is no transaction to open">
        tx
      </span>
    );
  return (
    <a className="proof" href={tx(sig)} target="_blank" rel="noreferrer" title="Open the transaction on Solscan" aria-label="Open the transaction on Solscan">
      tx
      <IconLink width={10} height={10} />
    </a>
  );
}

function Row({ icon, label, sub, value, proof, tone, children, focusable }: { icon: ReactNode; label: string; sub?: string; value: ReactNode; proof: ReactNode; tone: string; children?: ReactNode; focusable?: boolean }) {
  return (
    <li className={`row ${tone}`} tabIndex={focusable ? 0 : undefined}>
      <span className="ico">{icon}</span>
      <span className="lbl">
        {label}
        {sub && <small>{sub}</small>}
      </span>
      <span className="val">{value}</span>
      {proof}
      {children}
    </li>
  );
}

function PackRow({ p, live }: { p: PackResult; live: boolean }) {
  const delivered = p.status === 'delivered';
  const sub = delivered ? (p.rarity ?? 'Delivered') : p.status === 'paid_usdc' ? 'paid as USDC' : p.status === 'failed' ? 'being resolved' : 'opening…';
  const value = delivered ? fmtUsd(packValue(p)) : p.status === 'paid_usdc' ? <span className="muted">in USDC</span> : <span className="muted">…</span>;
  return (
    <Row icon={<IconPack width={15} height={15} />} label={`$${p.tier} pack`} sub={sub} value={value} proof={<Proof sig={delivered ? p.sig : undefined} live={live} />} tone={`pink pack ${p.status} r-${rarityClass(p.rarity)}`} focusable={delivered}>
      {delivered && (
        <span className="pack-pop" role="tooltip">
          {p.image ? (
            <img src={p.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
          ) : (
            <span className={`card-art ${rarityClass(p.rarity)}`} aria-hidden>
              <i>★</i>
            </span>
          )}
          <span className="pop-body">
            {p.rarity && <span className={`rarity ${rarityClass(p.rarity)}`}>{p.rarity}</span>}
            <strong>{p.name ?? 'Card delivered'}</strong>
            <span className="pop-value">
              <b>{fmtUsd(packValue(p))}</b>
              <small>{p.insuredValue != null ? 'insured value' : 'pack price'}</small>
            </span>
            <span className="pop-note">
              from a {fmtUsd(p.tier)} pack
              {live && p.nft && (
                <a href={acct(p.nft)} target="_blank" rel="noreferrer">
                  View card <IconLink width={10} height={10} />
                </a>
              )}
            </span>
          </span>
        </span>
      )}
    </Row>
  );
}

function WinnerCard({ w, i, r, live, symbol }: { w: WinnerPublic; i: number; r: RoundSummary; live: boolean; symbol: string }) {
  const paying = r.status === 'paying';
  const place = w.role === 'breaker' ? 'Final hit' : `#${r.winners[0]?.role === 'breaker' ? w.rank - 1 : w.rank} biggest buy`;
  return (
    <li className={`winner is-${w.role}`} style={{ ['--i' as string]: i }}>
      <div className="w-head">
        <span className="w-badge">{place}</span>
        <span className="w-share">{Math.round(w.weight * 100)}%</span>
      </div>
      <div className="w-id">
        {live ? (
          <a className="w-wallet" href={acct(w.wallet)} target="_blank" rel="noreferrer">
            {shortWallet(w.wallet)}
          </a>
        ) : (
          <span className="w-wallet">{shortWallet(w.wallet)}</span>
        )}
        <span className="w-buy">bought {fmtUsd(w.buyUsd)}</span>
      </div>

      <div className="w-total">
        <b>{fmtUsd(totalOf(w), 2)}</b>
        <span>{paying ? 'received so far' : 'total received'}</span>
      </div>

      <ul className="w-rewards">
        {w.packs.length ? (
          w.packs.map((p, k) => <PackRow key={k} p={p} live={live} />)
        ) : (
          <Row icon={<IconPack width={15} height={15} />} label="Card pack" value={<span className="muted">{paying ? '…' : 'none'}</span>} proof={<Proof live={live} />} tone="pink off" />
        )}
        <Row
          icon={<IconDollar width={15} height={15} />}
          label="USDC"
          value={w.usdc != null ? fmtUsd(w.usdc, 2) : <span className="muted">{paying ? '…' : '—'}</span>}
          proof={<Proof sig={w.usdcSig} live={live} />}
          tone="teal"
        />
        <Row
          icon={<IconCoin width={15} height={15} />}
          label={`$${symbol}`}
          sub={w.tokens != null ? `${compact(w.tokens)} tokens` : undefined}
          value={w.tokens != null ? (w.tokensUsd != null ? fmtUsd(w.tokensUsd, 2) : compact(w.tokens)) : <span className="muted">{paying ? '…' : '—'}</span>}
          proof={<Proof sig={w.tokenSig} live={live} />}
          tone="gold"
        />
      </ul>
    </li>
  );
}

export function RoundCard({ r, live, symbol }: { r: RoundSummary; live: boolean; symbol: string }) {
  return (
    <ol className="winners">
      {r.winners.map((w, i) => (
        <WinnerCard key={w.wallet} w={w} i={i} r={r} live={live} symbol={symbol} />
      ))}
    </ol>
  );
}

export function WinnersModal() {
  const show = useStore((s) => s.showWinners);
  const r = useStore((s) => s.summary);
  const st = useStore((s) => s.s);
  const set = useStore((s) => s.set);
  const countdown = useCountdown(st?.nextRoundAt ?? null);
  if (!show || !r || !st) return null;
  const live = st.mode === 'live';
  const paidOut = r.winners.reduce((a, w) => a + totalOf(w), 0);

  const statusLine =
    r.status === 'paid'
      ? `All rewards sent, worth ${fmtUsd(paidOut, 2)} in total.`
      : r.status === 'paying'
        ? r.provisional
          ? 'Confirming who still holds, then paying out…'
          : 'Paying out now. This updates live.'
        : 'Most rewards are out. A few transfers are being retried.';

  return (
    <div className="modal-wrap" onClick={() => set({ showWinners: false })}>
      <div className="modal winners-modal" role="dialog" aria-modal="true" aria-label={`Round ${r.round} winners`} onClick={(e) => e.stopPropagation()}>
        <button className="x" aria-label="Close" onClick={() => set({ showWinners: false })}>
          <IconClose />
        </button>
        <div className="burst" aria-hidden />
        <p className="eyebrow">Round {r.round}</p>
        <h2>Smashed!</h2>
        <p className="potline">
          {r.potUsd != null ? (
            <>
              <b>{fmtUsd(r.potUsd, 2)}</b> <span>USDC prize pool</span> rained down on {r.winners.length} {r.winners.length === 1 ? 'buyer' : 'buyers'}
            </>
          ) : (
            'Counting the pot…'
          )}
        </p>
        {r.winners.length ? <RoundCard r={r} live={live} symbol={st.symbol} /> : <p className="muted center">Nobody qualified this round, so the pot rolls into the next piñata.</p>}
        <footer>
          <span className={`pulse ${r.status}`} />
          <span>{statusLine}</span>
          {!live && <span className="chip demo">Demo payouts</span>}
          {countdown && st.phase === 'broken' && <span className="next">Next piñata in {countdown}</span>}
        </footer>
        <p className="fine center">Hover or tap a pack to see the card that came out. Packs count at the card's insured value, tokens at what the buyback cost.</p>
      </div>
    </div>
  );
}
