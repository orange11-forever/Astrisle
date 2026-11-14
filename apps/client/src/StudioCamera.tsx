import { useEffect, useRef } from 'react';
import type { ComponentRef } from 'react';
import { useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Vector3 } from 'three';
import type { CharacterFocus } from './Scene';

const homes = {
  mori: [-3.45, 1.2],
  luma: [3.45, 1.2],
  user: [0, 3.65],
} as const;
const overviewHeight = 0.35;
// Keep the point of interest inside the island, with room to look around its edge.
const panRadius = 7;

export function CameraRig({
  reset,
  fixed,
  focus,
  reduced,
}: {
  reset: number;
  fixed: boolean;
  focus?: CharacterFocus;
  reduced: boolean;
}) {
  const { camera, size, invalidate } = useThree();
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const viewport = useRef(size);
  viewport.current = size;
  useEffect(() => {
    const orbit = controls.current;
    if (!orbit) return;
    // Clear any remaining drag damping before applying an explicit view change.
    const damping = orbit.enableDamping;
    orbit.enableDamping = false;
    orbit.update();
    const fit = Math.max(1, 1.05 / (viewport.current.width / viewport.current.height));
    const target = focus
      ? new Vector3(homes[focus][0], 0.95, homes[focus][1])
      : new Vector3(0, overviewHeight, 0);
    if (focus) camera.position.set(target.x, target.y + 0.12, target.z + 4.05 * Math.sqrt(fit));
    else camera.position.set(13.5 * fit, 13.5 * fit, 20.3 * fit);
    orbit.target.copy(target);
    camera.lookAt(target);
    orbit.update();
    orbit.enableDamping = damping;
    invalidate();
    // Resize updates the projection, but only an explicit view change reframes the camera.
  }, [reset, focus, camera, invalidate]);

  const boundPan = () => {
    const orbit = controls.current;
    if (!orbit || focus) return;
    const { target } = orbit;
    const radius = Math.hypot(target.x, target.z);
    const scale = radius > panRadius ? panRadius / radius : 1;
    const x = target.x * scale;
    const z = target.z * scale;
    // Move camera and target together so reaching the boundary never changes the orbit.
    camera.position.x += x - target.x;
    camera.position.y += overviewHeight - target.y;
    camera.position.z += z - target.z;
    target.set(x, overviewHeight, z);
  };

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enabled={!fixed}
      enableRotate={!fixed}
      enablePan={!fixed && !focus}
      enableZoom={!fixed}
      enableDamping={!reduced}
      screenSpacePanning={false}
      minDistance={focus ? 2.3 : 3}
      maxDistance={focus ? 9 : 70}
      minPolarAngle={focus ? 0.2 : 0.1}
      maxPolarAngle={focus ? 1.65 : 1.5}
      onChange={boundPan}
    />
  );
}
