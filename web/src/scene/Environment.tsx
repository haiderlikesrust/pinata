// The fiesta: night sky, papel picado bunting, string lights and a stage floor.
// Everything is generated in code, so there is nothing extra to download.

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { ContactShadows, Environment as DreiEnv, Lightformer, Sparkles } from '@react-three/drei';
import * as THREE from 'three';
import { director, PALETTE } from './director';

function flagTexture(colorHex: string, seed: number) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 160;
  const g = c.getContext('2d')!;
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  g.fillStyle = colorHex;
  g.fillRect(0, 0, 128, 160);
  // scalloped bottom edge
  g.globalCompositeOperation = 'destination-out';
  for (let x = 0; x <= 128; x += 21.33) {
    g.beginPath();
    g.arc(x, 162, 11, 0, Math.PI * 2);
    g.fill();
  }
  // cut-out pattern
  const cx = 64;
  const cy = 74;
  const petals = 6 + Math.floor(rnd() * 3) * 2;
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * Math.PI * 2;
    g.save();
    g.translate(cx + Math.cos(a) * 30, cy + Math.sin(a) * 30);
    g.rotate(a);
    g.beginPath();
    g.ellipse(0, 0, 13, 5.5, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  g.beginPath();
  g.arc(cx, cy, 10, 0, Math.PI * 2);
  g.fill();
  for (let x = 16; x < 128; x += 24) {
    for (const y of [16, 136]) {
      g.beginPath();
      g.moveTo(x, y - 6);
      g.lineTo(x + 6, y);
      g.lineTo(x, y + 6);
      g.lineTo(x - 6, y);
      g.closePath();
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Points along a sagging string between two posts. */
function sag(a: THREE.Vector3, b: THREE.Vector3, drop: number, n: number) {
  return Array.from({ length: n }, (_, i) => {
    const t = (i + 0.5) / n;
    const p = a.clone().lerp(b, t);
    p.y -= drop * 4 * t * (1 - t);
    return p;
  });
}

function Bunting({ from, to, drop, count, phase, size }: { from: [number, number, number]; to: [number, number, number]; drop: number; count: number; phase: number; size: number }) {
  const group = useRef<THREE.Group>(null);
  const a = useMemo(() => new THREE.Vector3(...from), [from]);
  const b = useMemo(() => new THREE.Vector3(...to), [to]);
  const pts = useMemo(() => sag(a, b, drop, count), [a, b, drop, count]);
  const mats = useMemo(
    () => PALETTE.map((c, i) => new THREE.MeshBasicMaterial({ map: flagTexture(c, i + 1 + phase), transparent: true, alphaTest: 0.5, side: THREE.DoubleSide, toneMapped: true })),
    [phase],
  );
  const geo = useMemo(() => new THREE.PlaneGeometry(size, size * 1.25).translate(0, -size * 0.625, 0), [size]);
  const line = useMemo(() => {
    const curve = new THREE.CatmullRomCurve3([a, ...pts, b]);
    return new THREE.TubeGeometry(curve, 40, 0.008, 4);
  }, [a, b, pts]);

  useFrame(() => {
    const t = director.time;
    group.current?.children.forEach((c, i) => {
      c.rotation.x = Math.sin(t * 1.3 + i * 0.7 + phase) * 0.16 + Math.sin(t * 2.9 + i) * 0.04;
      c.rotation.z = Math.sin(t * 0.9 + i * 1.1 + phase) * 0.05;
    });
  });

  return (
    <>
      <mesh geometry={line}>
        <meshBasicMaterial color="#3a2a52" />
      </mesh>
      <group ref={group}>
        {pts.map((p, i) => (
          <mesh key={i} geometry={geo} material={mats[(i + phase) % mats.length]} position={p} />
        ))}
      </group>
    </>
  );
}

function StringLights({ from, to, drop, count }: { from: [number, number, number]; to: [number, number, number]; drop: number; count: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const pts = useMemo(() => sag(new THREE.Vector3(...from), new THREE.Vector3(...to), drop, count), [from, to, drop, count]);
  const colors = useMemo(() => ['#ffd27a', '#ff8fc0', '#7af0e6', '#ffe9a8'].map((c) => new THREE.Color(c)), []);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const col = useMemo(() => new THREE.Color(), []);

  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    const t = director.time;
    pts.forEach((p, i) => {
      tmp.position.copy(p);
      tmp.scale.setScalar(0.055);
      tmp.updateMatrix();
      m.setMatrixAt(i, tmp.matrix);
      const tw = 1.6 + Math.sin(t * 2.2 + i * 1.9) * 0.7 + director.glow * 3;
      m.setColorAt(i, col.copy(colors[i % colors.length]!).multiplyScalar(tw));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]} frustumCulled={false}>
      <sphereGeometry args={[1, 10, 8]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

function Backdrop() {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: { uGlow: { value: 0 } },
        vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          varying vec3 vDir; uniform float uGlow;
          void main(){
            float h = vDir.y;
            vec3 top = vec3(0.045, 0.02, 0.11);
            vec3 mid = vec3(0.16, 0.05, 0.27);
            vec3 hor = vec3(0.62, 0.12, 0.42);
            vec3 c = mix(mid, top, smoothstep(0.05, 0.75, h));
            c = mix(hor, c, smoothstep(-0.12, 0.3, h));
            // warm halo behind the piñata
            float halo = exp(-length(vec2(vDir.x, h - 0.12)) * 3.2);
            c += vec3(1.0, 0.45, 0.2) * halo * (0.28 + uGlow * 0.9);
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    [],
  );
  useFrame(() => {
    mat.uniforms.uGlow!.value = director.glow;
  });
  return (
    <mesh material={mat} renderOrder={-10}>
      <sphereGeometry args={[60, 32, 16]} />
    </mesh>
  );
}

export function Environment({ low }: { low: boolean }) {
  const burst = useRef<THREE.PointLight>(null);
  useFrame(() => {
    if (burst.current) {
      burst.current.intensity = director.glow * 160;
      burst.current.position.copy(director.pinataPos);
    }
  });

  return (
    <>
      <Backdrop />
      <fog attach="fog" args={['#2a0d3e', 16, 46]} />

      <ambientLight intensity={0.55} color="#c9b6ff" />
      <hemisphereLight args={['#ffd9f0', '#2a0d3e', 0.7]} />
      <directionalLight position={[3.5, 7, 6]} intensity={2.3} color="#fff1dc" />
      <directionalLight position={[-6, 4, -4]} intensity={1.6} color="#ff3d9a" />
      <directionalLight position={[6, 3, -5]} intensity={1.4} color="#21e6d6" />
      <pointLight ref={burst} color="#ffc56b" intensity={0} distance={18} decay={2} />

      {/* Reflections for the coins and foil packs, built from light panels. */}
      <DreiEnv resolution={128} frames={1}>
        <color attach="background" args={['#1a0b2e']} />
        <Lightformer form="rect" intensity={4} color="#fff1dc" position={[0, 6, 4]} scale={[10, 4, 1]} />
        <Lightformer form="rect" intensity={3} color="#ff2e88" position={[-7, 2, 0]} rotation-y={Math.PI / 2} scale={[8, 5, 1]} />
        <Lightformer form="rect" intensity={3} color="#00d1c7" position={[7, 2, 0]} rotation-y={-Math.PI / 2} scale={[8, 5, 1]} />
        <Lightformer form="ring" intensity={5} color="#ffb800" position={[0, 2, -8]} scale={5} />
      </DreiEnv>

      {/* stage floor */}
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.001, 0]}>
        <circleGeometry args={[30, 64]} />
        <meshStandardMaterial color="#231036" roughness={0.55} metalness={0.25} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.002, 0]}>
        <ringGeometry args={[3.3, 3.42, 96]} />
        <meshBasicMaterial color={[1.6, 0.35, 0.95]} toneMapped={false} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.002, 0]}>
        <ringGeometry args={[4.6, 4.64, 96]} />
        <meshBasicMaterial color={[0.1, 1.1, 1.05]} toneMapped={false} transparent opacity={0.7} />
      </mesh>
      {!low && <ContactShadows position={[0, 0.004, 0]} opacity={0.6} scale={12} blur={2.4} far={5} resolution={512} color="#0c0418" />}

      <Bunting from={[-9.5, 6.4, -3.5]} to={[9.5, 6.6, -3.5]} drop={1.3} count={17} phase={0} size={0.95} />
      <Bunting from={[-8, 5.5, -1.2]} to={[8, 5.3, -1.2]} drop={0.9} count={13} phase={2} size={0.8} />
      <Bunting from={[-11, 7.6, -7]} to={[11, 7.4, -7]} drop={1.6} count={19} phase={4} size={1.15} />
      <StringLights from={[-9, 5.9, -2.3]} to={[9, 6.1, -2.3]} drop={1.5} count={22} />
      <StringLights from={[-10, 7, -5.5]} to={[10, 6.8, -5.5]} drop={1.9} count={24} />

      <Sparkles count={low ? 40 : 110} scale={[16, 7, 8]} position={[0, 3.6, -1]} size={3.2} speed={0.35} opacity={0.75} color="#ffd9a0" />
    </>
  );
}
