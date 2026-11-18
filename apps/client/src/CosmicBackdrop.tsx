import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

type ColoredSurface = { position: Float32Array; color: Float32Array };
type IndexedSurface = ColoredSurface & { index: Uint16Array };

const galaxyPole = new THREE.Vector3(0.28, 0.8, -0.53).normalize();
const ringTilt: [number, number, number] = [1.15, -0.18, 0.38];
const planetAxis = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...ringTilt));
const planetSun = new THREE.Vector3(-0.64, 0.64, 0.53).normalize();
const ringedPlanet: [number, number, number] = [-128, -45, -90];
const moonPosition: [number, number, number] = [-23, -55, -180];
const celestialDistance = 2.2;

function coloredSurface(
  geometry: THREE.BufferGeometry,
  fill: (position: THREE.Vector3, tint: THREE.Color) => void,
): IndexedSurface {
  const positions = geometry.getAttribute('position');
  const position = positions.array as Float32Array;
  const index = geometry.getIndex()!.array as Uint16Array;
  const color = new Float32Array(position.length);
  const vertex = new THREE.Vector3();
  const tint = new THREE.Color();
  for (let i = 0; i < positions.count; i++) {
    fill(vertex.fromBufferAttribute(positions, i), tint);
    tint.toArray(color, i * 3);
  }
  geometry.dispose();
  return { position, index, color };
}

function haze(distance: number, width: number) {
  return Math.exp(-((distance / width) ** 2));
}

/** Bake the quiet sky into vertex colors: no textures or per-pixel noise shader. */
function skySurface() {
  const base = new THREE.Color('#080d21');
  const violet = new THREE.Color('#241c39');
  const blue = new THREE.Color('#172844');
  const starlight = new THREE.Color('#4f4f68');
  const coolCloud = new THREE.Color('#354765');
  const violetDirection = new THREE.Vector3(-0.7, -0.2, -0.7).normalize();
  const blueDirection = new THREE.Vector3(0.7, 0.1, -0.5).normalize();
  return coloredSurface(new THREE.SphereGeometry(460, 72, 42), (direction, tint) => {
    direction.normalize();
    const violetWeight = Math.pow(Math.max(0, direction.dot(violetDirection)), 5) * 0.8;
    const blueWeight = Math.pow(Math.max(0, direction.dot(blueDirection)), 6) * 0.58;
    const longitude = Math.atan2(direction.z, direction.x);
    const lane =
      direction.dot(galaxyPole) -
      0.044 * Math.sin(longitude * 3 + 0.5) -
      0.018 * Math.sin(longitude * 7 - 1);
    const cloudCover =
      0.6 + 0.19 * Math.sin(longitude * 5 + 2.4) + 0.13 * Math.sin(longitude * 11 - 0.8);
    const mist = haze(lane, 0.25) * (0.1 + 0.18 * cloudCover);
    const core = (0.15 * haze(lane - 0.046, 0.09) + 0.1 * haze(lane + 0.085, 0.12)) * cloudCover;
    tint
      .copy(base)
      .lerp(violet, violetWeight)
      .lerp(blue, blueWeight)
      .lerp(coolCloud, mist)
      .lerp(starlight, core);
  });
}

function stars(count: number, seed: number, cluster: number, brightness: number): ColoredSurface {
  const position = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  const tints = ['#7889ba', '#a3add0', '#bac8de', '#c8af9f'].map((value) => new THREE.Color(value));
  const direction = new THREE.Vector3();
  const tint = new THREE.Color();
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = 0; i < count; i++) {
    const y = random() * 2 - 1;
    const angle = random() * Math.PI * 2;
    const radius = 285 + random() * 90;
    const horizontal = Math.sqrt(1 - y * y);
    direction.set(Math.cos(angle) * horizontal, y, Math.sin(angle) * horizontal);
    if (random() < cluster) {
      direction.addScaledVector(galaxyPole, -direction.dot(galaxyPole)).normalize();
      direction.addScaledVector(galaxyPole, (random() + random() - 1) * 0.26).normalize();
    }
    direction.multiplyScalar(radius).toArray(position, i * 3);
    tint
      .copy(tints[Math.floor(random() * tints.length)]!)
      .multiplyScalar(brightness * (0.44 + random() * 0.56))
      .toArray(color, i * 3);
  }
  return { position, color };
}

function SurfaceGeometry({ surface }: { surface: IndexedSurface }) {
  return (
    <bufferGeometry>
      <bufferAttribute attach="index" args={[surface.index, 1]} />
      <bufferAttribute attach="attributes-position" args={[surface.position, 3]} />
      <bufferAttribute attach="attributes-color" args={[surface.color, 3]} />
    </bufferGeometry>
  );
}

function Planet({
  position,
  radius,
  moon = false,
}: {
  position: [number, number, number];
  radius: number;
  moon?: boolean;
}) {
  const surface = useMemo(() => {
    const shadow = new THREE.Color(moon ? '#151b30' : '#15182c');
    const dusk = new THREE.Color(moon ? '#46465d' : '#4c415a');
    const light = new THREE.Color(moon ? '#8b8b99' : '#847383');
    const limb = new THREE.Color(moon ? '#9a9cae' : '#9a8fa9');
    const albedo = new THREE.Color();
    const observer = new THREE.Vector3(...position).normalize().negate();
    return coloredSurface(new THREE.SphereGeometry(radius, 56, 36), (normal, tint) => {
      normal.normalize();
      const illumination = THREE.MathUtils.smoothstep(normal.dot(planetSun), -0.2, 0.9);
      const edge = (1 - Math.max(0, normal.dot(observer))) ** 4;
      const latitude = Math.asin(THREE.MathUtils.clamp(normal.dot(planetAxis), -1, 1));
      const band = 0.64 + 0.16 * Math.cos(latitude * 18 + 0.8) + 0.08 * Math.sin(latitude * 44);
      const mare =
        0.64 + 0.2 * Math.sin(normal.x * 12 + normal.z * 5) * Math.sin(normal.y * 8 - normal.z * 4);
      albedo.copy(dusk).lerp(light, moon ? mare : band);
      tint
        .copy(shadow)
        .lerp(albedo, 0.07 + illumination * 0.91)
        .lerp(limb, edge * (0.018 + illumination * 0.18));
    });
  }, [radius, moon, position]);
  return (
    <mesh position={position} renderOrder={-5} frustumCulled={false}>
      <SurfaceGeometry surface={surface} />
      <meshBasicMaterial vertexColors toneMapped={false} fog={false} />
    </mesh>
  );
}

function ringSurface() {
  const innerRadius = 13.5;
  const outerRadius = 17.6;
  const shadow = new THREE.Color('#2a263d');
  const frost = new THREE.Color('#73677f');
  return coloredSurface(
    new THREE.RingGeometry(innerRadius, outerRadius, 96, 18),
    (vertex, tint) => {
      const t = (vertex.length() - innerRadius) / (outerRadius - innerRadius);
      const radial =
        0.45 + 0.18 * Math.cos(t * Math.PI * 8 + 0.5) + 0.1 * Math.sin(t * Math.PI * 17);
      const edge = Math.sin(Math.PI * THREE.MathUtils.clamp(t, 0, 1)) ** 0.55;
      const side = 0.68 + 0.24 * Math.cos(Math.atan2(vertex.y, vertex.x) - 2.1);
      tint.copy(shadow).lerp(frost, radial * edge * side);
    },
  );
}

/** Static, camera-centered scenery; it never invalidates the demand-rendered canvas. */
export function CosmicBackdrop({ reduced = false }: { reduced?: boolean }) {
  const root = useRef<THREE.Group>(null);
  const sky = useMemo(skySurface, []);
  const rings = useMemo(ringSurface, []);
  const field = useMemo(() => stars(reduced ? 720 : 980, 0x41535452, 0.64, 0.42), [reduced]);
  const mid = useMemo(() => stars(134, 0x5a574f52, 0.44, 0.7), []);
  const bright = useMemo(() => stars(42, 0x49534c45, 0.26, 0.92), []);
  useFrame(({ camera }) => {
    // Following translation keeps the shell beyond every orbit/pan without adding motion.
    root.current?.position.copy(camera.position);
  });
  return (
    <group ref={root} name="cosmic-backdrop">
      <mesh renderOrder={-20} frustumCulled={false}>
        <SurfaceGeometry surface={sky} />
        <meshBasicMaterial
          vertexColors
          side={THREE.BackSide}
          depthWrite={false}
          depthTest={false}
          toneMapped={false}
          fog={false}
        />
      </mesh>
      {[
        { data: field, size: 0.64 },
        { data: mid, size: 0.94 },
        { data: bright, size: 1.23 },
      ].map(({ data, size }, i) => (
        <points key={i} renderOrder={-10} frustumCulled={false}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[data.position, 3]} />
            <bufferAttribute attach="attributes-color" args={[data.color, 3]} />
          </bufferGeometry>
          <pointsMaterial
            vertexColors
            size={size}
            sizeAttenuation
            depthWrite={false}
            depthTest={false}
            toneMapped={false}
            fog={false}
          />
        </points>
      ))}
      <group scale={celestialDistance}>
        <Planet position={ringedPlanet} radius={10.5} />
        <mesh position={ringedPlanet} rotation={ringTilt} renderOrder={-5} frustumCulled={false}>
          <SurfaceGeometry surface={rings} />
          <meshBasicMaterial vertexColors side={THREE.DoubleSide} toneMapped={false} fog={false} />
        </mesh>
        <Planet position={moonPosition} radius={4.5} moon />
      </group>
    </group>
  );
}
