import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { ServerEvent } from '@pinata/shared';
import type { WebSocket } from 'ws';
import { parseConfig } from './config';
import { Db } from './db';
import { Game } from './game';
import { Leader } from './leader';
import { Simulator } from './feed/simulator';
import { MemChain } from './payout/memChain';

const cfg = parseConfig();
const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The server answers HTTP straight away, but only runs the game once it owns
// the lock. That is what lets an update start the new version before the old
// one stops: the newcomer waits as a "standby" and takes over on hand-over.
let state: 'standby' | 'active' | 'stopping' = 'standby';
let game: Game | null = null;
let db: Db | null = null;
let sim: Simulator | null = null;
let stopLive: (() => void) | null = null;

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });
await app.register(websocket);

const clients = new Set<WebSocket>();
const broadcast = (e: ServerEvent) => {
  const data = JSON.stringify(e);
  for (const c of clients) if (c.readyState === 1) c.send(data);
};

// ---------- public ----------

app.get('/api/health', async () => ({ ok: true, state, mode: cfg.mode, round: game?.publicState().round ?? null }));
app.get('/api/state', async (_req, reply) => (game ? game.publicState() : reply.code(503).header('retry-after', '1').send({ error: 'starting' })));
app.get('/api/rounds', async () => db?.history(25) ?? []);

app.get('/ws', { websocket: true }, (socket) => {
  clients.add(socket);
  // A standby has nothing to say yet; the client gets the state the moment this server takes over.
  if (game) socket.send(JSON.stringify({ type: 'state', state: game.publicState() } satisfies ServerEvent));
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

// ---------- admin ----------

app.register(async (admin) => {
  admin.addHook('onRequest', async (req, reply) => {
    // On a public server the admin API stays locked until a real ADMIN_TOKEN is set.
    if (process.env.NODE_ENV === 'production' && cfg.adminToken === 'change-me') return reply.code(401).send({ error: 'set ADMIN_TOKEN to use the admin API' });
    if (req.headers['x-admin-token'] !== cfg.adminToken) return reply.code(401).send({ error: 'unauthorized' });
    if (!game) return reply.code(503).send({ error: 'starting' });
  });

  admin.get('/admin/status', async () => game!.adminStatus());

  admin.post<{ Body: { usd?: number } }>('/admin/max-hp', async (req, reply) => {
    const usd = Number(req.body?.usd);
    if (!(usd >= 100)) return reply.code(400).send({ error: 'usd must be at least 100' });
    game!.setMaxHp(usd);
    return { ok: true, appliesFrom: 'next round', usd };
  });

  admin.post<{ Params: { round: string } }>('/admin/retry/:round', async (req) => {
    void game!.queuePayout(Number(req.params.round));
    return { ok: true };
  });

  // Demo-mode helpers for testing the site.
  admin.post<{ Body: { side?: 'buy' | 'sell'; usd?: number } }>('/admin/sim/trade', async (req, reply) => {
    if (!sim) return reply.code(400).send({ error: 'demo mode only' });
    const t = sim.emit(req.body?.side ?? 'buy', Number(req.body?.usd ?? 100));
    return { ok: true, sig: t.sig };
  });
  admin.post('/admin/sim/break', async (_req, reply) => {
    if (!sim) return reply.code(400).send({ error: 'demo mode only' });
    sim.emit('buy', game!.hpLeft() + 50);
    return { ok: true };
  });
});

// ---------- the site itself (after `npm run build`) ----------

if (fs.existsSync(path.join(cfg.staticDir, 'index.html'))) {
  await app.register(fastifyStatic, {
    root: cfg.staticDir,
    setHeaders: (res, file) => {
      // Hashed files never change; the page itself must always be fresh so an update shows up.
      res.header('cache-control', /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/admin') && !req.url.startsWith('/ws')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'not found' });
  });
  log(`serving the site from ${cfg.staticDir}`);
}

await app.listen({ port: cfg.port, host: '0.0.0.0' });
log(`listening on port ${cfg.port} (standby)`);

// ---------- take over ----------

const dbFile = cfg.mode === 'dry' ? cfg.dbPath.replace(/\.sqlite$/, '.dry.sqlite') : cfg.dbPath;
const leader = new Leader(path.join(path.dirname(dbFile), 'leader.lock'));

async function shutdown(why: string, code = 0) {
  if (state === 'stopping') return;
  const wasActive = state === 'active';
  state = 'stopping';
  log(`stopping (${why})`);
  // Stop everything that could start new work, in one go, before anything is awaited.
  stopLive?.();
  sim?.stop();
  game?.stop();
  if (wasActive && game) {
    // Let the payout step in flight finish; it is saved, so anything later resumes on the next server.
    await Promise.race([game.idle(), sleep(6000)]);
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
  leader.release(); // from here on this process must not touch the data
  for (const c of clients) c.close(1012, 'restarting');
  await Promise.race([app.close(), sleep(1500)]);
  process.exit(code);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

const got = await leader.acquire(
  () => log('standby: waiting for the running server to hand over'),
  () => state === 'stopping',
);
if (got && state === 'standby') {
  leader.keep(() => void shutdown('another server took over', 1));
  try {
    db = new Db(dbFile);
    if (cfg.mode === 'dry') {
      const quoteUsd = () => cfg.sim.quoteUsd;
      const chain = new MemChain(quoteUsd);
      chain.hooks.delayMs = 350; // so payouts visibly tick through on the site
      chain.hooks.holds = () => Math.random() < 0.9;
      // The simulated pot lives in memory, so give a resumed round its starting pot back after a restart.
      if (db.activeRound()) chain.accrueUsd(cfg.sim.startPotUsd);
      const g = new Game({ cfg, db, chain, quoteUsd, broadcast, log, onRoundStart: () => chain.accrueUsd(cfg.sim.startPotUsd) });
      await g.init();
      sim = new Simulator(g, chain, cfg.sim);
      sim.start();
      game = g;
      log('active · DEMO MODE: simulated trades, nothing touches the chain');
    } else {
      const { startLive } = await import('./live/index');
      const live = await startLive({ cfg, db, broadcast, log });
      stopLive = live.stop;
      game = live.game;
      log(`active · LIVE: watching ${cfg.mint}`);
    }
    state = 'active';
    broadcast({ type: 'state', state: game.publicState() });
  } catch (e) {
    console.error(e);
    await shutdown(`failed to start: ${(e as Error).message}`, 1);
  }
}
