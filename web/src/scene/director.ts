// One mutable object that owns the scene's motion. Trades arrive from the
// socket, the director turns them into swings, impacts and explosions, and the
// React Three Fiber components read it every frame. Nothing here re-renders React.

import * as THREE from 'three';
import { fmtUsd, shortWallet, type PublicState, type RoundSummary, type TradeMsg } from '@pinata/shared';
import { useStore } from '../store';
import { sfx } from '../audio';

export const PALETTE = ['#ff2e88', '#ffb800', '#00d1c7', '#8a3ffc', '#9be22d', '#ff6b35'];

export type ParticleKind = 'shard' | 'coin' | 'usdc' | 'pack' | 'candy' | 'spark';

export interface BurstOpts {
  origin: THREE.Vector3;
  count: number;
  /** Half-size of the box particles start in. */
  spread?: [number, number, number];
  /** Main direction; particles fan out around it. */
  dir?: [number, number, number];
  speed: [number, number];
  /** 0 = tight cone, 1 = every direction */
  cone?: number;
  up?: [number, number];
  size?: [number, number];
  life?: [number, number];
  colors?: string[];
}

export interface FxApi {
  burst(kind: ParticleKind, o: BurstOpts): void;
  clear(): void;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export const BAT_MS = 380;
const BAT_IMPACT_MS = 120;

class Director {
  // pendulum angles (radians) and angular velocities
  ax = 0;
  az = 0;
  vx = 0;
  vz = 0;
  spin = 0;
  vspin = 0;
  // squash-and-stretch spring
  squash = 0;
  vsquash = 0;
  // 0..1 visual pulses
  flash = 0;
  healPulse = 0;
  shake = 0;
  zoom = 0;
  glow = 0;
  screenFlash = 0;
  // damage shown on the model, 0 = pristine, 1 = about to pop
  damage = 0;
  damageShown = 0;
  visible = false;
  /** How far above its resting place the piñata is (used for the drop-in). */
  dropY = 9;
  vDrop = 0;
  cracking = false;
  timeScale = 1;
  private slowUntil = 0;
  bat = { start: -1e9, side: 1, scale: 1 };
  /** Bumped whenever a heal should stick a tape patch on the model. */
  patchSeq = 0;
  /** Bumped when all patches should be removed. */
  patchReset = 0;
  readonly pinataPos = new THREE.Vector3(0, 2.3, 0);
  camera: THREE.Camera | null = null;
  fx: FxApi | null = null;
  time = 0;

  private queue: { at: number; fn: () => void }[] = [];
  private pending: { amount: number; maxHp: number; trades: TradeMsg[] } | null = null;
  private exploding = false;

  later(ms: number, fn: () => void) {
    this.queue.push({ at: performance.now() + ms, fn });
  }

  /** Called once per rendered frame with real (unscaled) seconds. */
  update(realDt: number) {
    const now = performance.now();
    if (this.queue.length) {
      const due = this.queue.filter((q) => q.at <= now);
      if (due.length) {
        this.queue = this.queue.filter((q) => q.at > now);
        for (const q of due) q.fn();
      }
    }

    const target = now < this.slowUntil ? 0.12 : 1;
    this.timeScale += (target - this.timeScale) * Math.min(1, realDt * (target < this.timeScale ? 30 : 3.5));
    const dt = Math.min(realDt, 0.05) * this.timeScale;
    this.time += dt;

    // Pendulum with a little restless energy so it never hangs dead still.
    const K = 5.2;
    const C = 0.85;
    const wob = this.cracking ? 9 : 0.045 + this.damageShown * 0.12;
    this.vx += (-K * Math.sin(this.ax) - C * this.vx + Math.sin(this.time * 0.9) * wob + (this.cracking ? rand(-1, 1) * 14 : 0)) * dt;
    this.vz += (-K * Math.sin(this.az) - C * this.vz + Math.cos(this.time * 0.63) * wob * 0.6 + (this.cracking ? rand(-1, 1) * 9 : 0)) * dt;
    this.ax += this.vx * dt;
    this.az += this.vz * dt;
    this.ax = clamp(this.ax, -0.42, 0.42);
    this.az = clamp(this.az, -0.3, 0.3);
    this.vspin += (-5.5 * this.spin - 1.3 * this.vspin + (this.cracking ? rand(-1, 1) * 20 : 0)) * dt;
    this.spin += this.vspin * dt;

    this.vsquash += (-210 * this.squash - 13 * this.vsquash) * dt;
    this.squash += this.vsquash * dt;

    this.vDrop += (-38 * this.dropY - 6.5 * this.vDrop) * dt;
    this.dropY += this.vDrop * dt;

    const decay = (v: number, rate: number) => v * Math.exp(-rate * realDt);
    this.flash = decay(this.flash, 9);
    this.healPulse = decay(this.healPulse, 2.6);
    this.shake = decay(this.shake, 6.5);
    this.zoom = decay(this.zoom, 1.6);
    this.glow = decay(this.glow, 1.8);
    this.screenFlash = decay(this.screenFlash, 3.2);
    this.damageShown += (this.damage - this.damageShown) * Math.min(1, realDt * 5);
  }

  setHp(hp: number, maxHp: number) {
    this.damage = clamp(1 - hp / Math.max(1, maxHp), 0, 1);
  }

  /** Bring the scene in line with the server (page load, reconnect, phase change). */
  sync(s: PublicState, initial: boolean) {
    this.setHp(s.hp, s.maxHp);
    this.cracking = s.phase === 'cracking';
    if (this.cracking) sfx.crack();
    if (s.phase === 'broken') {
      if (!this.exploding) this.visible = false;
      return;
    }
    if (!this.visible) {
      this.visible = true;
      this.damageShown = this.damage;
      if (initial) this.dropIn();
    }
  }

  private dropIn() {
    this.dropY = 9;
    this.vDrop = 0;
    this.ax = rand(-0.08, 0.08);
    this.vx = rand(-0.35, 0.35);
    this.later(650, () => sfx.drop());
  }

  private project(offset: [number, number, number]) {
    if (!this.camera) return { x: 50, y: 45 };
    const v = this.pinataPos.clone().add(new THREE.Vector3(...offset)).project(this.camera);
    return { x: clamp((v.x * 0.5 + 0.5) * 100, 8, 92), y: clamp((-v.y * 0.5 + 0.5) * 100, 8, 90) };
  }

  hit(trade: TradeMsg, amount: number, maxHp: number) {
    if (!this.visible) return;
    if (this.pending) {
      this.pending.amount += amount;
      this.pending.trades.push(trade);
      return;
    }
    this.pending = { amount, maxHp, trades: [trade] };
    this.swing(clamp(0.75 + 2.2 * Math.sqrt(amount / Math.max(1, maxHp)), 0.8, 1.7));
    this.later(BAT_IMPACT_MS, () => this.impact());
  }

  private swing(scale: number) {
    this.bat = { start: performance.now(), side: Math.random() < 0.5 ? -1 : 1, scale };
    sfx.whoosh();
  }

  private impact() {
    const h = this.pending;
    this.pending = null;
    if (!h || !this.visible) return;
    const side = this.bat.side;
    const frac = clamp(h.amount / Math.max(1, h.maxHp), 0, 1);
    const k = clamp(0.3 + 3.4 * Math.sqrt(frac), 0.35, 2.5);

    this.vx += -side * k * 0.36;
    this.vz += rand(-0.5, 0.5) * k * 0.3;
    this.vspin += rand(-1, 1) * k * 1.6 - side * k * 0.5;
    this.vsquash += 7 + k * 5;
    this.flash = Math.min(1, 0.45 + k * 0.3);
    this.shake = Math.min(1, this.shake + 0.12 + k * 0.16);

    const origin = this.pinataPos.clone().add(new THREE.Vector3(side * 0.55, 0.05, 0.35));
    this.fx?.burst('shard', {
      origin,
      count: Math.round(12 + 70 * Math.sqrt(frac)),
      spread: [0.15, 0.3, 0.2],
      dir: [-side, 0.55, 0.5],
      cone: 0.75,
      speed: [1.5, 4 + k * 2.2],
      up: [0.5, 3],
      size: [0.05, 0.11],
      life: [2.2, 4.5],
      colors: PALETTE,
    });
    this.fx?.burst('spark', { origin, count: 8, spread: [0.1, 0.1, 0.1], speed: [1.5, 4.5], cone: 1, size: [0.08, 0.2], life: [0.25, 0.5], colors: ['#ffffff', '#ffe9a8'] });
    if (this.damage > 0.45 && Math.random() < 0.3 + this.damage * 0.5) {
      this.fx?.burst('candy', { origin: this.pinataPos.clone().add(new THREE.Vector3(0, -0.5, 0.1)), count: 1 + Math.round(k * 1.5), spread: [0.3, 0.1, 0.2], speed: [0.3, 1.6], cone: 1, up: [0, 1], size: [0.05, 0.08], life: [5, 8], colors: PALETTE });
    }
    sfx.hit(clamp(k / 2.5, 0, 1));

    const big = frac > 0.08;
    h.trades.slice(-3).forEach((t, i) => {
      const p = this.project([side * -0.2 + rand(-0.5, 0.5), 0.9 + i * 0.35, 0]);
      useStore.getState().addFloater({ ...p, text: `−${fmtUsd(t.usd)}`, sub: shortWallet(t.wallet), kind: big ? 'crit' : 'hit' });
    });
  }

  heal(trade: TradeMsg, amount: number, maxHp: number) {
    if (!this.visible) return;
    const frac = clamp(amount / Math.max(1, maxHp), 0, 1);
    this.healPulse = 1;
    this.vsquash -= 4 + 10 * Math.sqrt(frac);
    this.patchSeq++;
    const origin = this.pinataPos.clone();
    this.fx?.burst('spark', {
      origin,
      count: Math.round(14 + 50 * Math.sqrt(frac)),
      spread: [0.9, 0.8, 0.5],
      speed: [0.2, 1.1],
      cone: 1,
      up: [0.6, 1.8],
      size: [0.07, 0.17],
      life: [0.7, 1.5],
      colors: ['#6dffb0', '#b6ffd6', '#ffffff'],
    });
    sfx.heal();
    const p = this.project([rand(-0.6, 0.6), 1.0, 0]);
    useStore.getState().addFloater({ ...p, text: `+${fmtUsd(amount)}`, sub: `${shortWallet(trade.wallet)} sold`, kind: 'heal' });
  }

  breakNow(_summary: RoundSummary) {
    this.cracking = false;
    this.pending = null;
    if (!this.visible) {
      useStore.getState().set({ showWinners: true });
      return;
    }
    this.exploding = true;
    this.swing(2.1);
    this.later(BAT_IMPACT_MS, () => this.explode());
  }

  private explode() {
    const o = this.pinataPos.clone();
    this.visible = false;
    this.slowUntil = performance.now() + 950;
    this.timeScale = 0.12;
    this.flash = 1;
    this.screenFlash = 1;
    this.shake = 1;
    this.zoom = 1;
    this.glow = 1;
    sfx.explode();

    const fx = this.fx;
    if (fx) {
      fx.burst('shard', { origin: o, count: 520, spread: [0.85, 0.75, 0.4], speed: [2.5, 10], cone: 1, up: [1.5, 6], size: [0.06, 0.15], life: [4, 8], colors: PALETTE });
      fx.burst('spark', { origin: o, count: 140, spread: [0.4, 0.4, 0.3], speed: [3, 12], cone: 1, size: [0.12, 0.34], life: [0.5, 1.3], colors: ['#fff3c4', '#ffd35c', '#ffffff', '#ff9ecb'] });
      fx.burst('coin', { origin: o, count: 150, spread: [0.5, 0.4, 0.3], speed: [1.5, 6.5], cone: 1, up: [3, 9], size: [0.075, 0.1], life: [14, 22] });
      fx.burst('usdc', { origin: o, count: 70, spread: [0.5, 0.4, 0.3], speed: [1.5, 6], cone: 1, up: [3, 8.5], size: [0.08, 0.1], life: [14, 22] });
      fx.burst('pack', { origin: o, count: 26, spread: [0.5, 0.4, 0.3], speed: [1.2, 5], cone: 1, up: [3.5, 8], size: [0.2, 0.25], life: [14, 22] });
      fx.burst('candy', { origin: o, count: 130, spread: [0.6, 0.5, 0.3], speed: [1.5, 7], cone: 1, up: [2.5, 8], size: [0.05, 0.085], life: [14, 22], colors: PALETTE });
    }
    // Confetti cannons from both wings.
    for (let i = 0; i < 7; i++) {
      this.later(500 + i * 260, () => {
        for (const sx of [-1, 1]) {
          this.fx?.burst('shard', {
            origin: new THREE.Vector3(sx * 4.6, 0.3, 1.6),
            count: 46,
            spread: [0.15, 0.1, 0.15],
            dir: [-sx * 0.55, 1, -0.12],
            cone: 0.28,
            speed: [7, 12.5],
            size: [0.05, 0.12],
            life: [4, 7],
            colors: PALETTE,
          });
        }
      });
    }
    this.later(2500, () => {
      this.exploding = false;
      useStore.getState().set({ showWinners: true });
      sfx.fanfare();
    });
  }

  newRound(s: PublicState) {
    this.exploding = false;
    this.cracking = false;
    this.pending = null;
    this.fx?.clear();
    this.patchReset++;
    this.setHp(s.hp, s.maxHp);
    this.damageShown = this.damage;
    this.visible = true;
    this.dropIn();
  }
}

export const director = new Director();
