import type { ServerEvent } from '@pinata/shared';
import { useStore } from './store';
import { director } from './scene/director';

const base = (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/$/, '') ?? '';
export const apiUrl = (path: string) => `${base}${path}`;
const wsUrl = () => {
  if (base) return base.replace(/^http/, 'ws') + '/ws';
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
};

const seen = new Set<string>();
const remember = (sig: string) => {
  seen.add(sig);
  if (seen.size > 600) seen.delete(seen.values().next().value!);
};

let first = true;

function handle(e: ServerEvent) {
  const st = useStore.getState();
  switch (e.type) {
    case 'state': {
      const prev = st.s;
      st.setState(e.state);
      for (const f of e.state.feed) remember(f.sig);
      if (first || !prev || prev.round !== e.state.round || prev.phase !== e.state.phase) director.sync(e.state, first);
      else director.setHp(e.state.hp, e.state.maxHp);
      first = false;
      break;
    }
    case 'trade': {
      st.patchHp(e.hp, e.maxHp, e.armored);
      director.setHp(e.hp, e.maxHp);
      if (seen.has(e.trade.sig)) break; // already animated from the fast feed
      remember(e.trade.sig);
      st.addFeed(e.trade);
      if (e.trade.side === 'buy') director.hit(e.trade, e.amount, e.maxHp);
      else director.heal(e.trade, e.amount, e.maxHp);
      break;
    }
    case 'break': {
      st.setState(e.state);
      st.setSummary(e.summary);
      director.breakNow(e.summary);
      break;
    }
    case 'payout':
      st.setSummary(e.summary);
      break;
    case 'round': {
      st.setState(e.state);
      director.newRound(e.state);
      break;
    }
  }
}

export function connect() {
  let ws: WebSocket | null = null;
  let retry = 0;
  let closed = false;

  const open = () => {
    useStore.getState().set({ conn: 'connecting' });
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      retry = 0;
      useStore.getState().set({ conn: 'open' });
    };
    ws.onmessage = (m) => {
      try {
        handle(JSON.parse(m.data as string) as ServerEvent);
      } catch (err) {
        console.error('bad message', err);
      }
    };
    ws.onclose = () => {
      if (closed) return;
      useStore.getState().set({ conn: 'closed' });
      first = true;
      setTimeout(open, Math.min(8000, 600 * 2 ** retry++));
    };
    ws.onerror = () => ws?.close();
  };
  open();

  fetch(apiUrl('/api/rounds'))
    .then((r) => r.json())
    .then((history) => useStore.getState().set({ history }))
    .catch(() => {});

  return () => {
    closed = true;
    ws?.close();
  };
}

export async function loadHistory() {
  try {
    const history = await (await fetch(apiUrl('/api/rounds'))).json();
    useStore.getState().set({ history });
  } catch {
    /* offline */
  }
}
