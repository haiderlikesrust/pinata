// The piñata: a GLB hung from a rope on a real pendulum, with a shader that
// tears holes in it as it takes damage and closes them again when it heals.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { director } from './director';

const MODEL_URL = '/models/pinata.glb';
/** World height of the model. */
const HEIGHT = 2.5;
/** Height of the rope's fixed end. */
export const ANCHOR_Y = 6.3;
/** Height of the piñata's centre when hanging still. */
export const REST_Y = 2.45;
/** Turn the model so it shows a three-quarter view to the camera. */
const FACING = -Math.PI / 2 + 0.5;
const MAX_PATCHES = 7;

const NOISE = /* glsl */ `
  float h31(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float vnoise(vec3 x){
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p){ return 0.6 * vnoise(p) + 0.3 * vnoise(p * 2.1 + 7.3) + 0.1 * vnoise(p * 4.3 + 1.7); }
`;

function tapeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.translate(64, 64);
  for (const rot of [Math.PI / 4, -Math.PI / 4]) {
    g.save();
    g.rotate(rot);
    g.fillStyle = '#f3e3b8';
    g.fillRect(-58, -15, 116, 30);
    g.fillStyle = 'rgba(120,90,40,0.25)';
    for (let x = -54; x < 58; x += 9) g.fillRect(x, -15, 2, 30);
    g.strokeStyle = 'rgba(90,60,20,0.5)';
    g.lineWidth = 2;
    g.strokeRect(-58, -15, 116, 30);
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function Pinata() {
  const { scene } = useGLTF(MODEL_URL);
  const camera = useThree((s) => s.camera);

  const swing = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const squash = useRef<THREE.Group>(null);
  const patches = useRef<THREE.Group>(null);
  const core = useRef<THREE.Mesh>(null);
  const light = useRef<THREE.PointLight>(null);
  const seen = useRef({ patch: 0, reset: 0 });

  const model = useMemo(() => {
    const root = scene.clone(true);
    let mesh: THREE.Mesh | null = null;
    root.traverse((o) => {
      if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
    });
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = HEIGHT / size.y;

    const uniforms = {
      uDamage: { value: 0 },
      uFlash: { value: 0 },
      uHeal: { value: 0 },
      uTime: { value: 0 },
      uNoise: { value: 1 },
    };
    if (mesh) {
      const m = mesh as THREE.Mesh;
      m.geometry.computeBoundingBox();
      const gh = m.geometry.boundingBox!.getSize(new THREE.Vector3()).y || 1;
      uniforms.uNoise.value = 5.5 / gh;
      const mat = (m.material as THREE.MeshStandardMaterial).clone();
      mat.side = THREE.DoubleSide;
      mat.roughness = 0.82;
      mat.metalness = 0;
      mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\nuniform float uTime;\nuniform float uNoise;\nvarying vec3 vObj;`)
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
             vObj = position * uNoise;
             // crepe-paper fringe flutter
             float fl = sin(uTime * 3.1 + vObj.y * 9.0 + vObj.x * 5.0) * cos(uTime * 2.3 + vObj.z * 7.0);
             transformed += normal * fl * 0.0035 / uNoise * 5.5;`,
          );
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\nuniform float uDamage;\nuniform float uFlash;\nuniform float uHeal;\nvarying vec3 vObj;\n${NOISE}`)
          .replace(
            '#include <map_fragment>',
            `#include <map_fragment>
             float pn = fbm(vObj);
             float th = pow(uDamage, 0.8) * 0.52 - 0.02;
             if (pn < th) discard;
             float burn = smoothstep(th + 0.07, th, pn) * step(0.02, uDamage);
             float cn = abs(fbm(vObj * 2.4 + 11.0) - 0.5);
             float crack = (1.0 - smoothstep(0.0, 0.014 + 0.03 * uDamage, cn)) * smoothstep(0.03, 0.35, uDamage);
             diffuseColor.rgb *= 1.0 - 0.85 * crack;
             diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.07, 0.03), burn * 0.9);
             if (!gl_FrontFacing) diffuseColor.rgb = vec3(0.34, 0.22, 0.12);
             diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.45, 1.0, 0.62), uHeal * 0.3);
             diffuseColor.rgb += uFlash * 0.3;`,
          )
          .replace(
            '#include <emissivemap_fragment>',
            `#include <emissivemap_fragment>
             totalEmissiveRadiance += vec3(1.0, 0.45, 0.06) * burn * burn * 1.25 + vec3(0.25, 1.0, 0.5) * uHeal * 0.35 + vec3(uFlash * 0.1);`,
          );
      };
      mat.customProgramCacheKey = () => 'pinata-damage-v4';
      m.material = mat;
      m.frustumCulled = false;
    }
    return { root, mesh: mesh as THREE.Mesh | null, scale, center, uniforms };
  }, [scene]);

  const tape = useMemo(() => {
    const geo = new THREE.PlaneGeometry(0.34, 0.34);
    const mat = new THREE.MeshStandardMaterial({ map: tapeTexture(), transparent: true, alphaTest: 0.3, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -4, side: THREE.DoubleSide });
    return { geo, mat };
  }, []);

  useEffect(() => () => void (tape.geo.dispose(), tape.mat.dispose()), [tape]);

  const ray = useMemo(() => new THREE.Raycaster(), []);

  function addPatch() {
    const g = patches.current;
    if (!g || !model.mesh) return;
    // Aim somewhere on the visible side of the body.
    const aim = director.pinataPos.clone().add(new THREE.Vector3(THREE.MathUtils.randFloatSpread(1.1), THREE.MathUtils.randFloatSpread(0.9), 0));
    ray.set(camera.position, aim.sub(camera.position).normalize());
    const hit = ray.intersectObject(model.mesh, false)[0];
    if (!hit || !hit.face) return;
    const normalWorld = hit.face.normal.clone().transformDirection(model.mesh.matrixWorld);
    if (normalWorld.dot(ray.ray.direction) > 0) normalWorld.negate();
    const m = new THREE.Mesh(tape.geo, tape.mat);
    const posWorld = hit.point.clone().addScaledVector(normalWorld, 0.012);
    g.updateWorldMatrix(true, false);
    m.position.copy(g.worldToLocal(posWorld.clone()));
    const target = g.worldToLocal(posWorld.clone().add(normalWorld));
    m.lookAt(target);
    m.rotateZ(Math.random() * Math.PI);
    m.scale.setScalar(0.001);
    m.userData.born = performance.now();
    g.add(m);
    while (g.children.length > MAX_PATCHES) g.remove(g.children[0]!);
  }

  useFrame(() => {
    const d = director;
    const sw = swing.current;
    const b = body.current;
    const sq = squash.current;
    if (!sw || !b || !sq) return;

    sw.position.y = ANCHOR_Y + d.dropY;
    sw.rotation.set(d.az, 0, d.ax);
    sw.visible = d.visible;
    b.rotation.y = FACING + d.spin;
    const s = d.squash;
    sq.scale.set(1 + s * 0.22, 1 - s * 0.26, 1 + s * 0.22);

    b.getWorldPosition(d.pinataPos);

    const u = model.uniforms;
    u.uDamage.value = d.damageShown;
    u.uFlash.value = d.flash;
    u.uHeal.value = d.healPulse;
    u.uTime.value = d.time;

    // The loot glowing through the holes.
    const glow = Math.max(0, d.damageShown - 0.15) * 1.2 + (d.cracking ? 0.6 + Math.sin(d.time * 40) * 0.3 : 0);
    if (core.current) {
      core.current.visible = glow > 0.02;
      core.current.scale.setScalar(0.85 + glow * 0.25 + Math.sin(d.time * 5) * 0.02);
    }
    if (light.current) light.current.intensity = glow * 7;

    // Tape patches
    if (seen.current.reset !== d.patchReset) {
      seen.current.reset = d.patchReset;
      patches.current?.clear();
    }
    if (seen.current.patch !== d.patchSeq) {
      seen.current.patch = d.patchSeq;
      if (d.visible && d.damageShown > 0.04) addPatch();
    }
    const now = performance.now();
    patches.current?.children.forEach((c) => {
      const t = Math.min(1, (now - (c.userData.born as number)) / 260);
      // overshoot pop
      const e = 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2);
      c.scale.setScalar(Math.max(0.001, e));
    });
  });

  const ropeLen = ANCHOR_Y - REST_Y;

  return (
    <group ref={swing} position={[0, ANCHOR_Y, 0]}>
      {/* rope */}
      <mesh position={[0, -(ropeLen - 0.45) / 2 + 6, 0]}>
        <cylinderGeometry args={[0.016, 0.016, ropeLen - 0.45 + 12, 6]} />
        <meshStandardMaterial color="#d8c39a" roughness={1} />
      </mesh>
      <group ref={body} position={[0, -ropeLen, 0]}>
        <group ref={squash}>
          <group scale={model.scale} position={[-model.center.x * model.scale, -model.center.y * model.scale, -model.center.z * model.scale]}>
            <primitive object={model.root} />
          </group>
          <mesh ref={core} position={[0, -0.22, 0]} visible={false}>
            <sphereGeometry args={[0.26, 20, 14]} />
            <meshBasicMaterial color={[2.1, 1.25, 0.3]} toneMapped={false} />
          </mesh>
          <pointLight ref={light} position={[0, -0.1, 0]} color="#ffb347" intensity={0} distance={5} decay={2} />
          <group ref={patches} />
        </group>
      </group>
    </group>
  );
}

useGLTF.preload(MODEL_URL);
