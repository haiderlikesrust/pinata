import { Suspense, useEffect, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import { director } from './director';
import { Pinata, REST_Y } from './Pinata';
import { Bat } from './Bat';
import { Fx } from './Fx';
import { Environment } from './Environment';

const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Drives the director and the camera (framing, parallax, shake, punch-in). */
function Rig({ flash }: { flash: React.RefObject<HTMLDivElement | null> }) {
  const { camera, size, pointer } = useThree();
  const look = useRef(new THREE.Vector3(0, REST_Y + 0.25, 0));

  useEffect(() => {
    director.camera = camera;
    return () => {
      director.camera = null;
    };
  }, [camera]);

  useFrame((_s, delta) => {
    director.update(delta);
    const aspect = size.width / Math.max(1, size.height);
    // Pull back on narrow screens so the swing still fits.
    const dist = 8.6 * THREE.MathUtils.clamp(1.05 / aspect, 1, 1.75);
    const sh = reduceMotion ? 0 : director.shake;
    const t = performance.now() / 1000;
    const zoom = director.zoom * 1.3;
    const tx = pointer.x * 0.35 + Math.sin(t * 47) * sh * 0.16;
    const ty = REST_Y + 0.35 + pointer.y * 0.18 + Math.cos(t * 53) * sh * 0.14;
    camera.position.x += (tx - camera.position.x) * 0.12;
    camera.position.y += (ty - camera.position.y) * 0.12;
    camera.position.z += (dist - zoom - camera.position.z) * 0.14;
    camera.lookAt(look.current);
    camera.rotation.z += Math.sin(t * 41) * sh * 0.012;
    if (flash.current) flash.current.style.opacity = String(Math.min(1, director.screenFlash * (reduceMotion ? 0.35 : 0.9)));
  });
  return null;
}

export function Stage({ low }: { low: boolean }) {
  const flash = useRef<HTMLDivElement>(null);
  return (
    <div className="stage">
      <Canvas
        dpr={low ? [1, 1.25] : [1, 2]}
        gl={{ antialias: !low, powerPreference: 'high-performance', toneMapping: THREE.ACESFilmicToneMapping }}
        camera={{ fov: 36, near: 0.1, far: 120, position: [0, REST_Y + 0.35, 9] }}
      >
        <Rig flash={flash} />
        <Environment low={low} />
        <Suspense fallback={null}>
          <Pinata />
        </Suspense>
        <Bat />
        <Fx low={low} />
        {!low && (
          <EffectComposer multisampling={0}>
            <Bloom mipmapBlur intensity={0.85} luminanceThreshold={0.92} luminanceSmoothing={0.2} radius={0.72} />
            <Vignette eskil={false} offset={0.22} darkness={0.72} />
          </EffectComposer>
        )}
      </Canvas>
      <div ref={flash} className="screen-flash" />
    </div>
  );
}
