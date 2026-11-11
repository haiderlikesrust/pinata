// The bat that swings in on every buy.

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { BAT_MS, director } from './director';

const LENGTH = 1.55;

export function Bat() {
  const pivot = useRef<THREE.Group>(null);
  const swoosh = useRef<THREE.Mesh>(null);

  const geo = useMemo(() => {
    // Profile of a wooden bat, handle at the origin.
    const pts = [
      [0.0, 0.0],
      [0.055, 0.0],
      [0.06, 0.03],
      [0.032, 0.06],
      [0.03, 0.5],
      [0.045, 0.8],
      [0.085, 1.15],
      [0.095, 1.42],
      [0.075, 1.53],
      [0.0, 1.55],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    return new THREE.LatheGeometry(pts, 18);
  }, []);

  const swooshGeo = useMemo(() => new THREE.RingGeometry(LENGTH * 0.55, LENGTH * 1.02, 40, 1, 0, Math.PI * 0.95), []);

  useFrame(() => {
    const g = pivot.current;
    if (!g) return;
    const { start, side, scale } = director.bat;
    const t = (performance.now() - start) / BAT_MS;
    if (t < 0 || t > 1) {
      g.visible = false;
      return;
    }
    g.visible = true;
    // Fast through the impact, then a follow-through.
    const e = 1 - Math.pow(1 - t, 3);
    const angle = -1.35 + 3.3 * e;
    const y = director.pinataPos.y - 0.55;
    g.position.set(side * (1.55 + 0.6 * scale), y, 0.55);
    g.rotation.set(0.25, 0, side * angle);
    const pop = Math.min(1, t / 0.08) * Math.min(1, (1 - t) / 0.3);
    g.scale.setScalar(scale * (0.4 + 0.6 * pop));
    g.scale.x *= side; // mirror so the swoosh trails correctly

    if (swoosh.current) {
      const mat = swoosh.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.55 * Math.sin(Math.min(1, t * 1.6) * Math.PI);
    }
  });

  return (
    <group ref={pivot} visible={false}>
      <mesh geometry={geo}>
        <meshStandardMaterial color="#c98a4b" roughness={0.55} metalness={0.05} />
      </mesh>
      {/* grip tape */}
      <mesh position={[0, 0.26, 0]}>
        <cylinderGeometry args={[0.034, 0.034, 0.4, 14]} />
        <meshStandardMaterial color="#ff2e88" roughness={0.7} />
      </mesh>
      <mesh position={[0, 1.2, 0]}>
        <cylinderGeometry args={[0.092, 0.088, 0.07, 18]} />
        <meshStandardMaterial color="#00d1c7" roughness={0.6} />
      </mesh>
      {/* motion trail, lagging just behind the bat */}
      <mesh ref={swoosh} geometry={swooshGeo} rotation={[0, 0, Math.PI / 2 - Math.PI * 0.95]}>
        <meshBasicMaterial color="#fff2c9" transparent opacity={0} side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </mesh>
    </group>
  );
}
