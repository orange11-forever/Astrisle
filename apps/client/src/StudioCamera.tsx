import { useEffect, useRef } from 'react';
import type { ComponentRef } from 'react';
import { useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Vector3 } from 'three';
import type { GroundPoint } from './island-motion';
import { harborOrigin } from './islands';

const overviewHeight = 0.35;
const harborLookOffset = [0.37, 0.65, 1.45] as const;
export type StudioDistrict = 'harbor' | 'garden';
const cameraViews = {
  studio: { target: [0, overviewHeight, 0], offset: [13.5, 13.5 - overviewHeight, 20.3] },
  harbor: {
    target: [
      harborOrigin[0] + harborLookOffset[0],
      harborLookOffset[1],
      harborOrigin[2] + harborLookOffset[2],
    ],
    offset: [-8.42, 12.38, 16.8],
  },
  garden: { target: [-6.95, 0.62, 5.25], offset: [5.2, 3.8, 6.6] },
} as const;
// Keep the point of interest inside the island, with room to look around its edge.
const panRadius = 7;

export function CameraRig({
  reset,
  fixed,
  focusHome,
  district,
  reduced,
}: {
  reset: number;
  fixed: boolean;
  focusHome?: GroundPoint;
  district?: StudioDistrict;
  reduced: boolean;
}) {
  const { camera, size, invalidate } = useThree();
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const view = cameraViews[district ?? 'studio'];
  const [centerX, centerY, centerZ] = view.target;
  const focus = !!focusHome;
  const [focusX, focusZ] = focusHome ?? [];
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
      ? new Vector3(focusX, 0.95, focusZ)
      : new Vector3(centerX, centerY, centerZ);
    if (focus) camera.position.set(target.x, target.y + 0.12, target.z + 4.05 * Math.sqrt(fit));
    else {
      camera.position.set(
        centerX + view.offset[0] * fit,
        centerY + view.offset[1] * fit,
        centerZ + view.offset[2] * fit,
      );
    }
    orbit.target.copy(target);
    camera.lookAt(target);
    orbit.update();
    orbit.enableDamping = damping;
    invalidate();
    // Resize updates the projection, but only an explicit view change reframes the camera.
  }, [reset, focus, focusX, focusZ, view, centerX, centerY, centerZ, camera, invalidate]);

  const boundPan = () => {
    const orbit = controls.current;
    if (!orbit || focus) return;
    const { target } = orbit;
    const radius = Math.hypot(target.x - centerX, target.z - centerZ);
    const scale = radius > panRadius ? panRadius / radius : 1;
    const x = centerX + (target.x - centerX) * scale;
    const z = centerZ + (target.z - centerZ) * scale;
    // Move camera and target together so reaching the boundary never changes the orbit.
    camera.position.x += x - target.x;
    camera.position.y += centerY - target.y;
    camera.position.z += z - target.z;
    target.set(x, centerY, z);
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
