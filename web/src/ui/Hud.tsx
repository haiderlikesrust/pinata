import { useEffect, useRef, useState } from 'react';
import { fmtUsd, shortWallet } from '@pinata/shared';
import { useStore } from '../store';
import { setMuted } from '../audio';
import { loadHistory } from '../socket';
import { IconBat, IconCoin, IconCopy, IconDollar, IconPack, IconShield, IconSound, IconX } from './icons';

/** Smoothly counts toward a value. */
export function useCount(target: number, ms = 600) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const e = 1 - Math.pow(1 - t, 3);
      const cur = a + (target - a) * e;
      from.current = cur;
      setV(cur);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

export function useCountdown(until: number | null) {
  const skew = useStore((s) => s.skew);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!until) return;
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [until]);
  if (!until) return null;
  const left = Math.max(0, Math.ceil((until - (Date.now() + skew)) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

function Logo() {
  return (
    <div className="logo" aria-label="Piñata">
      {'PIÑATA'.split('').map((ch, i) => (
        <span key={i} style={{ ['--i' as string]: i }}>
          {ch}
        </span>
      ))}
    </div>
  );
}

function HpBar() {
  const s = useStore((st) => st.s)!;
  const pct = s.phase === 'broken' ? 0 : Math.max(0, Math.min(100, (s.hp / s.maxHp) * 100));
  const [ghost, setGhost] = useState(pct);
  const [bump, setBump] = useState<'hit' | 'heal' | null>(null);
  const prev = useRef(pct);
  const countdown = useCountdown(s.nextRoundAt);

  useEffect(() => {
    const was = prev.current;
    prev.current = pct;
    if (pct === was) return;
    setBump(pct < was ? 'hit' : 'heal');
    const clear = setTimeout(() => setBump(null), 260);
    if (pct > was) {
      setGhost(pct);
      return () => clearTimeout(clear);
    }
    const lag = setTimeout(() => setGhost(pct), 420);
    return () => {
      clearTimeout(clear);
      clearTimeout(lag);
    };
  }, [pct]);

  const hp = useCount(s.phase === 'broken' ? 0 : s.hp, 350);
  let status: React.ReactNode;
  if (s.phase === 'broken') status = <>Smashed! Next piñata drops in <b>{countdown ?? '…'}</b></>;
  else if (s.phase === 'cracking') status = <>Cracking… confirming the final hit on-chain</>;
  else if (s.armored)
    status = (
      <>
        <IconShield width={14} height={14} /> Holding at 1 HP until the pot reaches {fmtUsd(s.minPotUsd)}
      </>
    );
  else status = <>Buys hit it. Sells patch it up. A buy of {fmtUsd(s.minBuyUsd)}+ lands the final blow.</>;

  return (
    <div className={`hp ${bump ?? ''} ${pct < 25 && s.phase === 'alive' ? 'danger' : ''} ${s.phase}`}>
      <div className="hp-row">
        <span className="hp-label">Piñata HP</span>
        <span className="hp-num">
          <b>{fmtUsd(Math.max(0, hp))}</b> / {fmtUsd(s.maxHp)}
        </span>
      </div>
      <div className="hp-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div className="hp-ghost" style={{ width: `${ghost}%` }} />
        <div className="hp-fill" style={{ width: `${pct}%` }} />
        <div className="hp-ticks" />
      </div>
      <div className="hp-status">{status}</div>
    </div>
  );
}

function Pot() {
  const s = useStore((st) => st.s)!;
  const usd = useCount(s.potUsd, 900);
  const total = s.split.packs + s.split.buyback + s.split.usdc || 1;
  const rows = [
    { key: 'packs', icon: <IconPack />, label: 'Card packs', pct: s.split.packs, cls: 'pink' },
    { key: 'buyback', icon: <IconCoin />, label: `$${s.symbol} buyback`, pct: s.split.buyback, cls: 'gold' },
    { key: 'usdc', icon: <IconDollar />, label: 'USDC', pct: s.split.usdc, cls: 'teal' },
  ];
  return (
    <section className="card pot">
      <h3>Inside the piñata</h3>
      <div className="pot-usd">{fmtUsd(usd)}</div>
      <div className="pot-sol">USDC prize pool · creator fees arrive in ${s.feeSymbol}</div>
      <div className="split-bar">
        {rows.map((r) => (
          <i key={r.key} className={r.cls} style={{ width: `${(r.pct / total) * 100}%` }} />
        ))}
      </div>
      <ul className="split">
        {rows.map((r) => (
          <li key={r.key} className={r.cls}>
            <span className="ico">{r.icon}</span>
            <span className="lbl">{r.label}</span>
            <span className="pct">{Math.round((r.pct / total) * 100)}%</span>
            <b>{fmtUsd((s.potUsd * r.pct) / total)}</b>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Leaderboard() {
  const s = useStore((st) => st.s)!;
  const wsum = s.weights.reduce((a, b) => a + b, 0) || 1;
  const share = (i: number) => `${Math.round(((s.weights[i] ?? 0) / wsum) * 100)}%`;
  const slots = Math.max(0, s.weights.length - 1);
  return (
    <section className="card board">
      <h3>In line for the drop</h3>
      <ol>
        <li className="breaker">
          <span className="rank">
            <IconBat width={15} height={15} />
          </span>
          <span className="who">Whoever lands the final hit</span>
          <span className="share">{share(0)}</span>
        </li>
        {Array.from({ length: slots }, (_, i) => {
          const e = s.leaderboard[i];
          return (
            <li key={i} className={e ? '' : 'empty'}>
              <span className="rank">{i + 1}</span>
              <span className="who">{e ? shortWallet(e.wallet) : 'Open slot'}</span>
              {e && <span className="amt">{fmtUsd(e.usd)}</span>}
              <span className="share">{share(i + 1)}</span>
            </li>
          );
        })}
      </ol>
      <p className="fine">Biggest single buys of {fmtUsd(s.minBuyUsd)}+ this round. Sell before it breaks and you lose your spot.</p>
    </section>
  );
}

function Feed() {
  const feed = useStore((st) => st.s!.feed);
  return (
    <section className="card feed">
      <h3>Live hits</h3>
      <ul>
        {feed.length === 0 && <li className="empty">Waiting for the first swing…</li>}
        {feed.map((t) => (
          <li key={t.sig} className={t.side}>
            <span className="tag-side">{t.side === 'buy' ? 'Buy' : 'Sell'}</span>
            <span className="who">{shortWallet(t.wallet)}</span>
            <span className="verb">{t.side === 'buy' ? 'hit it' : 'patched it'}</span>
            <b>
              {t.side === 'buy' ? '−' : '+'}
              {fmtUsd(t.usd)}
            </b>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Contract address, X link and last round, docked at the bottom of the stage. */
function Dock() {
  const s = useStore((st) => st.s)!;
  const summary = useStore((st) => st.summary);
  const set = useStore((st) => st.set);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!s.mint) return;
    void navigator.clipboard?.writeText(s.mint);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="dock">
      {s.mint ? (
        <button className={`ca ${copied ? 'copied' : ''}`} onClick={copy} title={`${s.mint} — click to copy`} aria-label={`Contract address ${s.mint}. Click to copy.`}>
          <span className="ca-label">CA</span>
          <code className="ca-full">{s.mint}</code>
          <code className="ca-short">
            {s.mint.slice(0, 6)}…{s.mint.slice(-6)}
          </code>
          <span className="ca-copy">
            <IconCopy width={13} height={13} />
            {copied ? 'Copied' : 'Copy'}
          </span>
        </button>
      ) : (
        <div className="ca soon" title="The contract address appears here at launch">
          <span className="ca-label">CA</span>
          <span className="ca-soon">drops at launch</span>
        </div>
      )}
      {s.xUrl ? (
        <a className="dock-x" href={s.xUrl} target="_blank" rel="noreferrer" aria-label="Follow us on X">
          <IconX width={14} height={14} />
          Follow
        </a>
      ) : (
        <span className="dock-x off" title="Our X account will be linked here soon" aria-label="X account coming soon">
          <IconX width={14} height={14} />
          Soon
        </span>
      )}
      {summary && (
        <button className="last-round" onClick={() => set({ showWinners: true })}>
          <span className={`pulse ${summary.status}`} />
          Round {summary.round} winners
          <b>{summary.status === 'paid' ? 'paid' : summary.status === 'paying' ? 'paying out…' : 'in progress'}</b>
        </button>
      )}
    </div>
  );
}

export function Hud() {
  const s = useStore((st) => st.s);
  const conn = useStore((st) => st.conn);
  const muted = useStore((st) => st.muted);
  const set = useStore((st) => st.set);

  if (!s) {
    return (
      <div className="hud">
        <div className="loading">
          <Logo />
          <p>{conn === 'closed' ? 'Can’t reach the server. Retrying…' : 'Hanging the piñata…'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="hud">
      <header className="top">
        <div className="brand">
          <Logo />
          <span className="chip">Round {s.round}</span>
          {s.mode === 'dry' && <span className="chip demo">Demo · simulated trades</span>}
        </div>
        <nav className="actions">
          {s.mint && (
            <a className="btn primary" href={`https://pump.fun/coin/${s.mint}`} target="_blank" rel="noreferrer">
              Take a swing
            </a>
          )}
          <button className="btn ghost" onClick={() => set({ showHow: true })}>
            How it works
          </button>
          <button
            className="btn ghost"
            onClick={() => {
              void loadHistory();
              set({ showHistory: true });
            }}
          >
            Past rounds
          </button>
          <button
            className="btn ghost icon"
            aria-label={muted ? 'Turn sound on' : 'Turn sound off'}
            onClick={() => {
              setMuted(!muted);
              set({ muted: !muted });
            }}
          >
            <IconSound off={muted} />
          </button>
        </nav>
      </header>

      <HpBar />

      <div className="panels">
        <aside className="col left">
          <Pot />
          <Leaderboard />
        </aside>
        <aside className="col right">
          <Feed />
        </aside>
      </div>

      <Dock />

      {conn !== 'open' && <div className="conn">Reconnecting…</div>}
    </div>
  );
}
