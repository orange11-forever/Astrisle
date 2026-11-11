import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

type ColoredSurface = { position: Float32Array; color: Float32Array };

/** Bake the quiet sky into vertex colors: no textures or per-pixel noise shader. */
function skySurface(): ColoredSurface {
  const source = new THREE.SphereGeometry(460, 40, 24);
  const geometry = source.toNonIndexed();
  const position = geometry.getAttribute('position').array as Float32Array;
  const color = new Float32Array(position.length);
  const base = new THREE.Color('#080d21');
  const violet = new THREE.Color('#28203e');
  const blue = new THREE.Color('#16243f');
  const violetDirection = new THREE.Vector3(-0.7, -0.2, -0.7).normalize();
  const blueDirection = new THREE.Vector3(0.7, 0.1, -0.5).normalize();
  const direction = new THREE.Vector3();
  const tint = new THREE.Color();
  for (let i = 0; i < position.length; i += 3) {
    direction.fromArray(position, i).normalize();
    const violetWeight = Math.pow(Math.max(0, direction.dot(violetDirection)), 5) * 0.8;
    const blueWeight = Math.pow(Math.max(0, direction.dot(blueDirection)), 6) * 0.52;
    tint.copy(base).lerp(violet, violetWeight).lerp(blue, blueWeight);
    tint.toArray(color, i);
  }
  // Only the arrays survive. The declarative R3F buffers below own GPU disposal.
  source.dispose();
  geometry.dispose();
  return { position, color };
}

function stars(count: number, seed: number): ColoredSurface {
  const position = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  const tints = ['#7683a5', '#9a9db8', '#b2b9cd', '#c6b9aa'].map((value) => new THREE.Color(value));
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
    position.set(
      [Math.cos(angle) * horizontal * radius, y * radius, Math.sin(angle) * horizontal * radius],
      i * 3,
    );
    tints[Math.floor(random() * tints.length)]!.toArray(color, i * 3);
  }
  return { position, color };
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
    const source = new THREE.SphereGeometry(radius, 28, 18);
    const geometry = source.toNonIndexed();
    const vertices = geometry.getAttribute('position').array as Float32Array;
    const normals = geometry.getAttribute('normal');
    const color = new Float32Array(vertices.length);
    const shadow = new THREE.Color(moon ? '#171b32' : '#17172f');
    const light = new THREE.Color(moon ? '#77788e' : '#665675');
    const sun = new THREE.Vector3(-0.9, 0.55, -0.2).normalize();
    const normal = new THREE.Vector3();
    const tint = new THREE.Color();
    for (let i = 0; i < normals.count; i++) {
      normal.fromBufferAttribute(normals, i);
      const illumination = Math.pow(Math.max(0, normal.dot(sun)), 0.7);
      const band = moon ? 1 : 0.93 + Math.sin(normal.y * 19) * 0.07;
      tint
        .copy(shadow)
        .lerp(light, illumination * band)
        .toArray(color, i * 3);
    }
    source.dispose();
    geometry.dispose();
    return { position: vertices, color };
  }, [radius, moon]);
  return (
    <mesh position={position} renderOrder={-5} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[surface.position, 3]} />
        <bufferAttribute attach="attributes-color" args={[surface.color, 3]} />
      </bufferGeometry>
      <meshBasicMaterial vertexColors toneMapped={false} fog={false} />
    </mesh>
  );
}

/** Static, camera-centered scenery; it never invalidates the demand-rendered canvas. */
export function CosmicBackdrop({ reduced = false }: { reduced?: boolean }) {
  const root = useRef<THREE.Group>(null);
  const sky = useMemo(skySurface, []);
  const field = useMemo(() => stars(reduced ? 360 : 620, 0x41535452), [reduced]);
  const bright = useMemo(() => stars(32, 0x49534c45), []);
  useFrame(({ camera }) => {
    // Following translation keeps the shell beyond every orbit/pan without adding motion.
    root.current?.position.copy(camera.position);
  });
  return (
    <group ref={root} name="cosmic-backdrop">
      <mesh renderOrder={-20} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[sky.position, 3]} />
          <bufferAttribute attach="attributes-color" args={[sky.color, 3]} />
        </bufferGeometry>
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
        { data: field, size: 0.58 },
        { data: bright, size: 1.05 },
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
      <Planet position={[-128, -45, -90]} radius={10.5} />
      <mesh
        position={[-128, -45, -90]}
        rotation={[1.15, -0.18, 0.38]}
        renderOrder={-5}
        frustumCulled={false}
      >
        <ringGeometry args={[13.5, 17.6, 80]} />
        <meshBasicMaterial color="#48405b" side={THREE.DoubleSide} toneMapped={false} fog={false} />
      </mesh>
      <Planet position={[-23, -55, -180]} radius={4.5} moon />
    </group>
  );
}
