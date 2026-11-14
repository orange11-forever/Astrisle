import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useSceneActivity } from './render-budget';

const colors = ['#e4b665', '#dc8b7c', '#83b9a8', '#a0ace2', '#eee8cf'];
/** One bounded instanced burst; completion state and replay are owned by the App. */
export function Confetti({ burst }: { burst: number }) {
  const mesh = useRef<THREE.InstancedMesh>(null),
    age = useRef(0),
    active = useSceneActivity();
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const particles = useMemo(
    () =>
      Array.from({ length: 160 }, (_, i) => {
        const seed = Math.sin(i * 127.1 + burst * 91.7) * 43758.5453,
          random = seed - Math.floor(seed);
        const side = i % 2 ? 1 : -1;
        return {
          x: side * 4.8,
          z: 4.5,
          vx: -side * (1.2 + random * 3.0),
          vy: 5.4 + random * 3.1,
          vz: -1.5 + (i % 11) * 0.24,
          spin: 2 + random * 5,
          phase: i * 2.4,
        };
      }),
    [burst],
  );
  useLayoutEffect(() => {
    age.current = 0;
    particles.forEach((p, i) => {
      mesh.current!.setColorAt(i, new THREE.Color(colors[i % colors.length]));
      dummy.position.set(p.x, 0.18, p.z);
      dummy.scale.set(0.07, 0.12, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      mesh.current!.setMatrixAt(i, dummy.matrix);
    });
    mesh.current!.instanceMatrix.needsUpdate = true;
    if (mesh.current!.instanceColor) mesh.current!.instanceColor.needsUpdate = true;
  }, [particles, dummy]);
  useFrame((_, delta) => {
    if (!mesh.current || !active) return;
    const t = (age.current += Math.min(delta, 0.05));
    particles.forEach((p, i) => {
      const fall = Math.max(0.035, 0.18 + p.vy * t - 2.9 * t * t);
      dummy.position.set(
        p.x + p.vx * (1 - Math.exp(-t)) + Math.sin(t * 3 + p.phase) * 0.08,
        fall,
        p.z + p.vz * t * 0.55,
      );
      const fade = Math.max(0, Math.min(1, (3.5 - t) / 0.45));
      dummy.scale.set(0.07 * fade, 0.12 * fade, 1);
      dummy.rotation.set(p.phase + t * p.spin, p.phase * 0.5 + t * 2, t * p.spin * 0.7);
      dummy.updateMatrix();
      mesh.current!.setMatrixAt(i, dummy.matrix);
    });
    mesh.current.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh
      ref={mesh}
      name="completion-confetti"
      args={[undefined, undefined, 160]}
      frustumCulled={false}
      raycast={() => {}}
    >
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial side={THREE.DoubleSide} toneMapped={false} />
    </instancedMesh>
  );
}
