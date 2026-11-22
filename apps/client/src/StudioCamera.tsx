import { useEffect, useRef } from 'react';
import type { ComponentRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { PerspectiveCamera, Vector3 } from 'three';
import type { GroundPoint } from './island-motion';
import {
  OBSERVATORY,
  observatoryApproachPose,
  observatoryTargetHeight,
} from './island-observatory';
import { harborOrigin } from './islands';

const overviewHeight = 0.35;
const harborLookOffset = [0.37, 0.65, 1.45] as const;
export type StudioDistrict = 'harbor' | 'garden' | 'observatory';
const observatoryTarget = observatoryApproachPose(1.4, 1).target;
const approachDuration = 0.84;
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
  observatory: { target: observatoryTarget },
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
  const visiting = district === 'observatory' && !focus;
  const [focusX, focusZ] = focusHome ?? [];
  const viewport = useRef(size);
  viewport.current = size;
  const motionOptions = useRef({ reduced, fixed });
  motionOptions.current = { reduced, fixed };
  const approach = useRef<{ elapsed: number; aspect: number } | undefined>(undefined);
  useEffect(() => {
    if (!visiting || !(camera instanceof PerspectiveCamera)) return;
    const originalFov = camera.fov;
    camera.fov = OBSERVATORY.fieldOfView;
    camera.updateProjectionMatrix();
    invalidate();
    return () => {
      camera.fov = originalFov;
      camera.updateProjectionMatrix();
      invalidate();
    };
  }, [visiting, camera, invalidate]);

  useEffect(() => {
    const orbit = controls.current;
    if (!orbit) return;
    approach.current = undefined;
    // Clear any remaining drag damping before applying an explicit view change.
    const damping = orbit.enableDamping;
    orbit.enableDamping = false;
    orbit.update();
    const aspect = Math.max(1, viewport.current.width) / Math.max(1, viewport.current.height);
    const fit = Math.max(1, 1.05 / aspect);
    if (visiting) {
      const { reduced, fixed } = motionOptions.current;
      const snap = reduced || fixed;
      const pose = observatoryApproachPose(aspect, snap ? 1 : 0);
      if (!snap) approach.current = { elapsed: 0, aspect };
      camera.position.set(...pose.position);
      orbit.target.set(...pose.target);
      orbit.update();
      orbit.enableDamping = damping;
      invalidate();
      return;
    }
    const target = focus
      ? new Vector3(focusX, 0.95, focusZ)
      : new Vector3(centerX, centerY, centerZ);
    if (focus) camera.position.set(target.x, target.y + 0.12, target.z + 4.05 * Math.sqrt(fit));
    else if ('offset' in view) {
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
  }, [reset, focus, focusX, focusZ, visiting, view, centerX, centerY, centerZ, camera, invalidate]);

  useFrame((_, delta) => {
    const travel = approach.current;
    const orbit = controls.current;
    if (!travel || !orbit) return;
    // Demand rendering may leave a long gap before the first frame of a visit.
    travel.elapsed += Math.min(delta, 1 / 20);
    const { reduced, fixed } = motionOptions.current;
    const progress = reduced || fixed ? 1 : Math.min(1, travel.elapsed / approachDuration);
    const pose = observatoryApproachPose(travel.aspect, progress);
    camera.position.set(...pose.position);
    orbit.target.set(...pose.target);
    orbit.update();
    if (progress === 1) approach.current = undefined;
    else invalidate();
  });

  const boundPan = () => {
    const orbit = controls.current;
    if (!orbit || focus || approach.current) return;
    const { target } = orbit;
    const radius = Math.hypot(target.x - centerX, target.z - centerZ);
    const limit = visiting ? 3.3 : panRadius;
    const scale = radius > limit ? limit / radius : 1;
    const x = centerX + (target.x - centerX) * scale;
    const y = visiting ? observatoryTargetHeight(camera.position.y, target.y, centerY) : centerY;
    const z = centerZ + (target.z - centerZ) * scale;
    // Move camera and target together so reaching the boundary never changes the orbit.
    camera.position.x += x - target.x;
    camera.position.y += y - target.y;
    camera.position.z += z - target.z;
    target.set(x, y, z);
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
      minDistance={focus ? 2.3 : visiting ? 1.65 : 3}
      maxDistance={focus ? 9 : visiting ? 22 : 70}
      minPolarAngle={focus ? 0.2 : 0.1}
      maxPolarAngle={focus ? 1.65 : visiting ? 2.92 : 1.5}
      onChange={boundPan}
      onStart={() => {
        approach.current = undefined;
      }}
    />
  );
}
