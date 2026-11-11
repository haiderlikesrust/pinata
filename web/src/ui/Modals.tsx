import { fmtUsd } from '@pinata/shared';
import { useStore } from '../store';
import { RoundCard } from './WinnersModal';
import { IconClose } from './icons';

export function HowModal() {
  const show = useStore((s) => s.showHow);
  const st = useStore((s) => s.s);
  const set = useStore((s) => s.set);
  if (!show || !st) return null;
  const total = st.split.packs + st.split.buyback + st.split.usdc || 1;
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`;
  const wsum = st.weights.reduce((a, b) => a + b, 0) || 1;
  const breaker = Math.round(((st.weights[0] ?? 0) / wsum) * 100);
  return (
    <div className="modal-wrap" onClick={() => set({ showHow: false })}>
      <div className="modal how" role="dialog" aria-modal="true" aria-label="How it works" onClick={(e) => e.stopPropagation()}>
        <button className="x" aria-label="Close" onClick={() => set({ showHow: false })}>
          <IconClose />
        </button>
        <h2>How it works</h2>
        <ol className="steps">
          <li>
            <b>Every buy is a swing.</b>
            <span>A buy of ${st.symbol} knocks its dollar value off the piñata's HP.</span>
          </li>
          <li>
            <b>Every sell is a patch.</b>
            <span>Sells tape it back up at half strength, so it always breaks in the end.</span>
          </li>
          <li>
            <b>The pot is a USDC prize pool.</b>
            <span>
              Every trade pays a creator fee in ${st.feeSymbol}, which is swapped into USDC. USDC sent to the prize wallet counts too. When the piñata breaks, the whole pool comes out.
            </span>
          </li>
          <li>
            <b>Five buyers get paid.</b>
            <span>
              The wallet that lands the final hit takes {breaker}%. The four biggest single buys of the round share the rest. Buys must be {fmtUsd(st.minBuyUsd)} or more, and you must still be holding.
            </span>
          </li>
          <li>
            <b>Three kinds of loot.</b>
            <span>
              {pct(st.split.packs)} buys Collector Crypt card packs opened straight into winners' wallets, {pct(st.split.buyback)} buys back ${st.symbol} and airdrops it, and {pct(st.split.usdc)} is paid in USDC.
            </span>
          </li>
        </ol>
        <p className="fine">
          The piñata holds at 1 HP until the pot reaches {fmtUsd(st.minPotUsd)}. Card packs are a third-party product from Collector Crypt. Nothing here is financial advice; only spend what you can afford to lose.
        </p>
      </div>
    </div>
  );
}

export function HistoryModal() {
  const show = useStore((s) => s.showHistory);
  const history = useStore((s) => s.history);
  const st = useStore((s) => s.s);
  const set = useStore((s) => s.set);
  if (!show || !st) return null;
  return (
    <div className="modal-wrap" onClick={() => set({ showHistory: false })}>
      <div className="modal history" role="dialog" aria-modal="true" aria-label="Past rounds" onClick={(e) => e.stopPropagation()}>
        <button className="x" aria-label="Close" onClick={() => set({ showHistory: false })}>
          <IconClose />
        </button>
        <h2>Past rounds</h2>
        {history.length === 0 && <p className="muted center">No piñata has been broken yet. Be the first.</p>}
        {history.map((r) => (
          <section key={r.round} className="past">
            <header>
              <b>Round {r.round}</b>
              <span>{r.potUsd != null ? fmtUsd(r.potUsd) : '…'} pot</span>
              <span>{new Date(r.endedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              <span className={`tag ${r.status}`}>{r.status === 'paid' ? 'Paid' : r.status === 'paying' ? 'Paying' : 'In progress'}</span>
            </header>
            <RoundCard r={r} live={st.mode === 'live'} symbol={st.symbol} />
          </section>
        ))}
      </div>
    </div>
  );
}
