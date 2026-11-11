// Instanced particle pools with a tiny hand-rolled physics step: gravity, drag,
// paper flutter, floor bounces and settling. Cheap enough for ~2,000 live pieces.

import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { director, type BurstOpts, type ParticleKind } from './director';

interface PoolOpts {
  n: number;
  gravity: number;
  drag: number;
  flutter?: number;
  bounce?: number;
  friction?: number;
  /** Height of the piece's centre when it rests on the floor, as a multiple of its size. */
  rest?: number;
  /** Rotation it settles into when lying on the floor. */
  flatX?: number;
  billboard?: boolean;
  ground?: boolean;
  fade?: number;
}

const FLOOR = 0;
const dummy = new THREE.Object3D();
const color = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const rand = (a: number, b: number) => a + Math.random() * (b - a);

class Pool {
  readonly mesh: THREE.InstancedMesh;
  private cursor = 0;
  private live = 0;
  private readonly p: Float32Array;
  private readonly v: Float32Array;
  private readonly r: Float32Array;
  private readonly w: Float32Array;
  private readonly life: Float32Array;
  private readonly age: Float32Array;
  private readonly size: Float32Array;
  private readonly seed: Float32Array;
  private readonly state: Uint8Array; // 0 dead, 1 flying, 2 resting

  constructor(
    geo: THREE.BufferGeometry,
    mat: THREE.Material | THREE.Material[],
    private readonly o: PoolOpts,
  ) {
    const n = o.n;
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < n; i++) {
      this.mesh.setMatrixAt(i, ZERO);
      this.mesh.setColorAt(i, color.set('#ffffff'));
    }
    this.p = new Float32Array(n * 3);
    this.v = new Float32Array(n * 3);
    this.r = new Float32Array(n * 3);
    this.w = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.age = new Float32Array(n);
    this.size = new Float32Array(n);
    this.seed = new Float32Array(n);
    this.state = new Uint8Array(n);
  }

  burst(b: BurstOpts) {
    const sp = b.spread ?? [0, 0, 0];
    const dir = new THREE.Vector3(...(b.dir ?? [0, 1, 0])).normalize();
    const cone = b.cone ?? 1;
    const tmp = new THREE.Vector3();
    for (let c = 0; c < b.count; c++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.o.n;
      if (this.state[i] === 0) this.live++;
      const j = i * 3;
      this.p[j] = b.origin.x + rand(-sp[0], sp[0]);
      this.p[j + 1] = Math.max(FLOOR + 0.02, b.origin.y + rand(-sp[1], sp[1]));
      this.p[j + 2] = b.origin.z + rand(-sp[2], sp[2]);
      // random direction blended toward the main direction
      tmp.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(cone).addScaledVector(dir, 1 - cone * 0.85).normalize();
      const s = rand(b.speed[0], b.speed[1]);
      this.v[j] = tmp.x * s;
      this.v[j + 1] = tmp.y * s + (b.up ? rand(b.up[0], b.up[1]) : 0);
      this.v[j + 2] = tmp.z * s * 0.8;
      this.r[j] = rand(0, 6.28);
      this.r[j + 1] = rand(0, 6.28);
      this.r[j + 2] = rand(0, 6.28);
      this.w[j] = rand(-9, 9);
      this.w[j + 1] = rand(-9, 9);
      this.w[j + 2] = rand(-9, 9);
      this.life[i] = b.life ? rand(b.life[0], b.life[1]) : 3;
      this.age[i] = 0;
      this.size[i] = b.size ? rand(b.size[0], b.size[1]) : 0.1;
      this.seed[i] = Math.random() * 100;
      this.state[i] = 1;
      if (b.colors?.length) this.mesh.setColorAt(i, color.set(b.colors[Math.floor(Math.random() * b.colors.length)]!));
    }
    if (b.colors?.length && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Makes everything on the floor shrink away quickly. */
  clear() {
    for (let i = 0; i < this.o.n; i++) if (this.state[i] !== 0) this.life[i] = Math.min(this.life[i]!, rand(0.2, 0.7));
  }

  update(dt: number, cam: THREE.Quaternion) {
    if (this.live === 0) return;
    const { gravity, drag, flutter = 0, bounce = 0.3, friction = 0.7, rest = 0.5, flatX, billboard, ground = true, fade = 0.5 } = this.o;
    const damp = Math.exp(-drag * dt);
    const { p, v, r, w } = this;
    for (let i = 0; i < this.o.n; i++) {
      const st = this.state[i]!;
      if (st === 0) continue;
      const j = i * 3;
      this.life[i]! -= dt;
      this.age[i]! += dt;
      if (this.life[i]! <= 0) {
        this.state[i] = 0;
        this.live--;
        this.mesh.setMatrixAt(i, ZERO);
        continue;
      }
      const size = this.size[i]!;
      if (st === 1) {
        v[j + 1]! -= gravity * dt;
        v[j]! *= damp;
        v[j + 1]! *= damp;
        v[j + 2]! *= damp;
        if (flutter) {
          const ph = this.seed[i]! + this.age[i]! * 6;
          v[j]! += Math.sin(ph) * flutter * dt;
          v[j + 2]! += Math.cos(ph * 0.8) * flutter * dt;
        }
        p[j]! += v[j]! * dt;
        p[j + 1]! += v[j + 1]! * dt;
        p[j + 2]! += v[j + 2]! * dt;
        r[j]! += w[j]! * dt;
        r[j + 1]! += w[j + 1]! * dt;
        r[j + 2]! += w[j + 2]! * dt;
        const floor = FLOOR + size * rest;
        if (ground && p[j + 1]! < floor) {
          p[j + 1] = floor;
          if (v[j + 1]! < 0) {
            v[j + 1] = -v[j + 1]! * bounce;
            v[j]! *= friction;
            v[j + 2]! *= friction;
            w[j]! *= 0.55;
            w[j + 1]! *= 0.55;
            w[j + 2]! *= 0.55;
            if (v[j + 1]! < 0.55) {
              v[j + 1] = 0;
              if (Math.abs(v[j]!) + Math.abs(v[j + 2]!) < 0.25) this.state[i] = 2;
            }
          }
        }
      } else if (flatX !== undefined) {
        // ease into lying flat
        const k = Math.min(1, dt * 10);
        r[j]! += (nearest(r[j]!, flatX) - r[j]!) * k;
        r[j + 2]! += (nearest(r[j + 2]!, 0) - r[j + 2]!) * k;
      }
      const s = size * Math.min(1, this.life[i]! / fade) * Math.min(1, this.age[i]! / 0.06);
      dummy.position.set(p[j]!, p[j + 1]!, p[j + 2]!);
      if (billboard) dummy.quaternion.copy(cam);
      else dummy.rotation.set(r[j]!, r[j + 1]!, r[j + 2]!);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      this.mesh.setMatrixAt(i, dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** The angle equal to `target` (mod π) closest to `a`, so pieces settle the short way round. */
function nearest(a: number, target: number) {
  return target + Math.round((a - target) / Math.PI) * Math.PI;
}

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function coinFace(bg: string, ring: string, glyph: string, fg: string) {
  return canvasTexture(128, (g, s) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, s, s);
    g.strokeStyle = ring;
    g.lineWidth = 9;
    g.beginPath();
    g.arc(s / 2, s / 2, s * 0.39, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = fg;
    g.font = `900 ${s * 0.56}px "DM Sans", Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(glyph, s / 2, s / 2 + s * 0.03);
  });
}

function packFace() {
  return canvasTexture(256, (g, s) => {
    const grad = g.createLinearGradient(0, 0, s, s);
    ['#ff5fa2', '#ffd34d', '#5ef2e0', '#8f6bff', '#ff5fa2'].forEach((c, i, a) => grad.addColorStop(i / (a.length - 1), c));
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    // foil streaks
    g.globalAlpha = 0.22;
    g.fillStyle = '#ffffff';
    for (let i = -4; i < 10; i++) {
      g.save();
      g.translate(i * 40, 0);
      g.rotate(0.5);
      g.fillRect(0, -s, 12, s * 3);
      g.restore();
    }
    g.globalAlpha = 1;
    // crimped top and bottom
    g.fillStyle = 'rgba(20,8,40,0.55)';
    g.fillRect(0, 0, s, s * 0.09);
    g.fillRect(0, s * 0.91, s, s * 0.09);
    // burst emblem
    g.translate(s / 2, s / 2);
    g.fillStyle = '#1a0b2e';
    g.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const rr = i % 2 ? s * 0.17 : s * 0.3;
      g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    g.closePath();
    g.fill();
    g.fillStyle = '#fff6e5';
    g.font = `900 ${s * 0.2}px "DM Sans", Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('★', 0, 4);
  });
}

function glowTexture() {
  return canvasTexture(64, (g, s) => {
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.75)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });
}

export function Fx({ low }: { low: boolean }) {
  const pools = useMemo(() => {
    const scale = low ? 0.5 : 1;
    const n = (x: number) => Math.round(x * scale);
    const coinGeo = new THREE.CylinderGeometry(1, 1, 0.18, 22);
    const gold = new THREE.MeshStandardMaterial({ color: '#ffc531', metalness: 1, roughness: 0.25, emissive: '#6b3d00', emissiveIntensity: 0.35 });
    const goldFace = new THREE.MeshStandardMaterial({ map: coinFace('#ffc531', '#b97a00', '★', '#b97a00'), metalness: 0.9, roughness: 0.3, emissive: '#6b3d00', emissiveIntensity: 0.3 });
    const blue = new THREE.MeshStandardMaterial({ color: '#2775ca', metalness: 0.7, roughness: 0.3, emissive: '#0a2a5c', emissiveIntensity: 0.4 });
    const blueFace = new THREE.MeshStandardMaterial({ map: coinFace('#2775ca', '#ffffff', '$', '#ffffff'), metalness: 0.5, roughness: 0.35, emissive: '#0a2a5c', emissiveIntensity: 0.4 });
    const packTex = packFace();
    const packSide = new THREE.MeshStandardMaterial({ color: '#d9d4e8', metalness: 0.9, roughness: 0.3 });
    const packFront = new THREE.MeshStandardMaterial({ map: packTex, metalness: 0.75, roughness: 0.28, emissive: '#ffffff', emissiveMap: packTex, emissiveIntensity: 0.18 });

    const map: Record<ParticleKind, Pool> = {
      shard: new Pool(new THREE.PlaneGeometry(1, 1.5), new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.85, emissive: '#ffffff', emissiveIntensity: 0.06 }), {
        n: n(1400),
        gravity: 5.5,
        drag: 1.9,
        flutter: 2.4,
        bounce: 0.05,
        friction: 0.4,
        rest: 0.08,
        flatX: Math.PI / 2,
        fade: 0.6,
      }),
      coin: new Pool(coinGeo, [gold, goldFace, goldFace], { n: n(220), gravity: 12, drag: 0.12, bounce: 0.42, friction: 0.72, rest: 0.1, flatX: 0 }),
      usdc: new Pool(coinGeo, [blue, blueFace, blueFace], { n: n(110), gravity: 12, drag: 0.12, bounce: 0.42, friction: 0.72, rest: 0.1, flatX: 0 }),
      pack: new Pool(new THREE.BoxGeometry(1, 1.4, 0.07), [packSide, packSide, packSide, packSide, packFront, packFront], {
        n: n(40),
        gravity: 10,
        drag: 0.55,
        bounce: 0.22,
        friction: 0.6,
        rest: 0.05,
        flatX: Math.PI / 2,
      }),
      candy: new Pool(new THREE.SphereGeometry(1, 14, 10), new THREE.MeshStandardMaterial({ roughness: 0.18, metalness: 0.1 }), { n: n(260), gravity: 12, drag: 0.1, bounce: 0.55, friction: 0.8, rest: 1 }),
      spark: new Pool(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
        { n: n(420), gravity: -0.5, drag: 2.6, ground: false, billboard: true, fade: 0.35 },
      ),
    };
    return map;
  }, [low]);

  useEffect(() => {
    director.fx = {
      burst: (kind, o) => pools[kind].burst(low && o.count > 20 ? { ...o, count: Math.round(o.count * 0.5) } : o),
      clear: () => Object.values(pools).forEach((p) => p.clear()),
    };
    return () => {
      director.fx = null;
    };
  }, [pools, low]);

  useFrame(({ camera }, delta) => {
    const dt = Math.min(delta, 0.05) * director.timeScale;
    for (const k in pools) pools[k as ParticleKind].update(dt, camera.quaternion);
  });

  return (
    <>
      {Object.entries(pools).map(([k, p]) => (
        <primitive key={k} object={p.mesh} />
      ))}
    </>
  );
}
