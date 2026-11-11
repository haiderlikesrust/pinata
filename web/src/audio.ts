// All sound is synthesised, so there are no audio files to load.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
let noiseBuf: AudioBuffer | null = null;

function ac(): AudioContext | null {
  if (muted) return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') return null; // not unlocked by a click yet
  return ctx;
}

/** Browsers only allow sound after a click or tap; call this from one. */
export function unlockAudio() {
  if (muted) return;
  ac();
  void ctx?.resume();
}

export function setMuted(m: boolean) {
  muted = m;
  if (master) master.gain.value = m ? 0 : 0.5;
  if (!m) unlockAudio();
}

function tone(freq: number, to: number, dur: number, vol: number, type: OscillatorType = 'sine', at = 0) {
  const c = ac();
  if (!c || !master) return;
  const t = c.currentTime + at;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur: number, vol: number, freq: number, q = 0.8, type: BiquadFilterType = 'lowpass', at = 0, sweepTo?: number) {
  const c = ac();
  if (!c || !master || !noiseBuf) return;
  const t = c.currentTime + at;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.5, dur + 0.05);
}

export const sfx = {
  /** intensity 0..1 */
  hit(intensity: number) {
    const k = 0.35 + intensity * 0.65;
    noise(0.09 + k * 0.08, 0.5 * k, 1400 + 1600 * k, 0.7, 'lowpass', 0, 300);
    tone(150 + 60 * k, 48, 0.16 + 0.1 * k, 0.55 * k);
    noise(0.05, 0.18 * k, 5200, 1.5, 'bandpass'); // paper rip
  },
  whoosh() {
    noise(0.16, 0.12, 500, 1.2, 'bandpass', 0, 2400);
  },
  heal() {
    tone(660, 680, 0.14, 0.12, 'triangle');
    tone(880, 900, 0.18, 0.1, 'triangle', 0.07);
    tone(1320, 1340, 0.22, 0.05, 'sine', 0.14);
  },
  crack() {
    noise(0.5, 0.2, 2500, 3, 'bandpass', 0, 600);
  },
  explode() {
    noise(1.1, 0.9, 3800, 0.5, 'lowpass', 0, 120);
    tone(120, 30, 0.9, 0.9);
    tone(70, 28, 1.2, 0.6, 'triangle');
    const scale = [523, 659, 784, 1047, 1319, 1568, 2093];
    for (let i = 0; i < 26; i++) {
      const f = scale[Math.floor(Math.random() * scale.length)]!;
      tone(f, f * 1.01, 0.25, 0.06, 'triangle', 0.25 + Math.random() * 2.4);
    }
    for (let i = 0; i < 40; i++) tone(2600 + Math.random() * 2400, 2400, 0.06, 0.035, 'square', 0.5 + Math.random() * 2.6);
  },
  fanfare() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 0.32, 0.14, 'triangle', i * 0.11));
    tone(1319, 1319, 0.6, 0.12, 'triangle', 0.46);
  },
  coin() {
    tone(1568, 1570, 0.08, 0.07, 'square');
    tone(2093, 2095, 0.16, 0.06, 'square', 0.06);
  },
  drop() {
    tone(220, 330, 0.25, 0.12, 'sine');
    noise(0.2, 0.08, 900, 1, 'lowpass', 0.22);
  },
};
