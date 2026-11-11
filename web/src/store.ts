import { create } from 'zustand';
import type { PublicState, RoundSummary, TradeMsg } from '@pinata/shared';

export interface Floater {
  id: number;
  x: number;
  y: number;
  text: string;
  sub: string;
  kind: 'hit' | 'heal' | 'crit';
}

interface Store {
  conn: 'connecting' | 'open' | 'closed';
  s: PublicState | null;
  summary: RoundSummary | null;
  history: RoundSummary[];
  showWinners: boolean;
  showHow: boolean;
  showHistory: boolean;
  muted: boolean;
  floaters: Floater[];
  /** Server clock minus local clock, so countdowns are right. */
  skew: number;
  set: (p: Partial<Store>) => void;
  setState: (s: PublicState) => void;
  patchHp: (hp: number, maxHp: number, armored: boolean) => void;
  addFeed: (t: TradeMsg) => void;
  setSummary: (r: RoundSummary) => void;
  addFloater: (f: Omit<Floater, 'id'>) => void;
  dropFloater: (id: number) => void;
}

let floaterId = 0;

export const useStore = create<Store>((set, get) => ({
  conn: 'connecting',
  s: null,
  summary: null,
  history: [],
  showWinners: false,
  showHow: false,
  showHistory: false,
  muted: false,
  floaters: [],
  skew: 0,
  set: (p) => set(p),
  setState: (s) => {
    const cur = get().summary;
    const summary = s.lastRound && (!cur || s.lastRound.round >= cur.round) ? s.lastRound : cur;
    set({ s, summary, skew: s.serverTime - Date.now() });
  },
  patchHp: (hp, maxHp, armored) => {
    const s = get().s;
    if (s) set({ s: { ...s, hp, maxHp, armored } });
  },
  addFeed: (t) => {
    const s = get().s;
    if (!s || s.feed.some((f) => f.sig === t.sig)) return;
    set({ s: { ...s, feed: [t, ...s.feed].slice(0, 40) } });
  },
  setSummary: (r) => {
    const cur = get().summary;
    if (!cur || r.round >= cur.round) set({ summary: r });
    const h = get().history;
    if (h.some((x) => x.round === r.round)) set({ history: h.map((x) => (x.round === r.round ? r : x)) });
  },
  addFloater: (f) => set({ floaters: [...get().floaters.slice(-11), { ...f, id: ++floaterId }] }),
  dropFloater: (id) => set({ floaters: get().floaters.filter((f) => f.id !== id) }),
}));
