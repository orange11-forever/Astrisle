import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { islandAppearance } from './islands';

type V3 = [number, number, number];
type Palette = ReturnType<typeof islandAppearance>;
function Boulder({
  position,
  scale = [1, 1, 1],
  color,
}: {
  position: V3;
  scale?: V3;
  color: string;
}) {
  return (
    <mesh position={position} scale={scale} castShadow>
      <dodecahedronGeometry args={[1, 0]} />
      <meshStandardMaterial color={color} roughness={0.95} flatShading />
    </mesh>
  );
}
export function IslandTree({
  position,
  scale = 1,
  palette,
}: {
  position: V3;
  scale?: number;
  palette: Palette;
}) {
  return (
    <group position={position} scale={scale}>
      <mesh castShadow position={[0, 0.9, 0]} rotation={[0, 0, -0.06]}>
        <cylinderGeometry args={[0.1, 0.17, 1.8, 7]} />
        <meshStandardMaterial color="#897c66" />
      </mesh>
      <mesh position={[0.25, 1.3, 0]} rotation={[0, 0, -0.65]}>
        <cylinderGeometry args={[0.05, 0.08, 0.8, 6]} />
        <meshStandardMaterial color="#897c66" />
      </mesh>
      {[
        [0, 2, 0, 0.85],
        [-0.48, 1.8, 0.1, 0.59],
        [0.45, 2.3, 0.1, 0.64],
        [0, 2.65, -0.1, 0.56],
      ].map(([x, y, z, s], i) => (
        <mesh key={i} position={[x!, y!, z!]} scale={[s!, s! * 0.8, s!]} castShadow>
          <icosahedronGeometry args={[1, 1]} />
          <meshStandardMaterial color={i % 2 ? palette.lightLeaf : palette.leaf} roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}
function Flowers({
  position,
  palette,
  count = 9,
}: {
  position: V3;
  palette: Palette;
  count?: number;
}) {
  return (
    <group position={position}>
      {Array.from({ length: count }, (_, i) => {
        const a = i * 2.4,
          r = 0.18 + Math.sqrt(i) * 0.13,
          h = 0.22 + (i % 3) * 0.07;
        return (
          <group key={i} position={[Math.cos(a) * r, 0, Math.sin(a) * r]}>
            <mesh position={[0, h / 2, 0]}>
              <cylinderGeometry args={[0.012, 0.014, h, 5]} />
              <meshStandardMaterial color={palette.leaf} />
            </mesh>
            <mesh position={[0, h, 0]} rotation={[0.3, a, 0.1]}>
              <icosahedronGeometry args={[0.085, 0]} />
              <meshStandardMaterial color={i % 3 ? palette.flower : '#f2ead6'} />
            </mesh>
            <mesh position={[0.04, h * 0.5, 0]} scale={[0.08, 0.025, 0.045]} rotation={[0, 0, 0.6]}>
              <sphereGeometry args={[1, 6, 4]} />
              <meshStandardMaterial color={palette.lightLeaf} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
export function Pennant({
  position,
  palette,
  reduced = false,
}: {
  position: V3;
  palette: Palette;
  reduced?: boolean;
}) {
  const flag = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (flag.current)
      flag.current.rotation.y = reduced
        ? 0.1
        : Math.sin(clock.elapsedTime * 1.8 + palette.seed) * 0.15;
  });
  const shape = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.lineTo(0.7, -0.12);
    s.lineTo(0.52, -0.35);
    s.lineTo(0, -0.3);
    s.closePath();
    return s;
  }, []);
  return (
    <group position={position}>
      <mesh position={[0, 1.1, 0]} castShadow>
        <cylinderGeometry args={[0.025, 0.035, 2.2, 8]} />
        <meshStandardMaterial color="#b49a65" metalness={0.3} />
      </mesh>
      <mesh ref={flag} position={[0.03, 2.02, 0]}>
        <shapeGeometry args={[shape]} />
        <meshStandardMaterial color={palette.flag} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 2.25, 0]}>
        <sphereGeometry args={[0.065, 8, 6]} />
        <meshStandardMaterial color="#c9b27b" />
      </mesh>
    </group>
  );
}
function Cloud({
  position,
  scale = 1,
  reduced,
}: {
  position: V3;
  scale?: number;
  reduced: boolean;
}) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (ref.current)
      ref.current.position.x =
        position[0] + (reduced ? 0 : Math.sin(clock.elapsedTime * 0.065 + position[2]) * 0.55);
  });
  return (
    <group ref={ref} position={position} scale={scale}>
      {[
        [0, 0, 0, 1.8],
        [-1, 0.1, 0, 1.3],
        [1, 0.12, 0.2, 1.4],
      ].map(([x, y, z, s], i) => (
        <mesh key={i} position={[x!, y!, z!]} scale={[s!, s! * 0.37, s! * 0.7]}>
          <sphereGeometry args={[1, 12, 8]} />
          <meshStandardMaterial color="#edf2f0" roughness={1} />
        </mesh>
      ))}
    </group>
  );
}
export function IslandLandscape({
  workspaceId,
  reduced,
}: {
  workspaceId: string;
  reduced: boolean;
}) {
  const palette = useMemo(() => islandAppearance(workspaceId), [workspaceId]);
  const path = useMemo(
    () =>
      new THREE.CatmullRomCurve3(
        Array.from({ length: 45 }, (_, i) => {
          const a = (i / 44) * Math.PI * 1.5 - 0.4;
          return new THREE.Vector3(Math.cos(a) * 6.43, -0.05, Math.sin(a) * 6.43);
        }),
      ),
    [],
  );
  return (
    <group>
      <mesh position={[0, -0.84, 0]} rotation={[0, palette.rotation, 0]} receiveShadow castShadow>
        <cylinderGeometry args={[7.35, 6.45, 0.95, 14]} />
        <meshStandardMaterial color={palette.stone} flatShading roughness={0.94} />
      </mesh>
      <mesh position={[0.1, -1.45, 0]} rotation={[0, 0.22, Math.PI]} castShadow>
        <coneGeometry args={[6.47, 2.1, 10]} />
        <meshStandardMaterial color={palette.stone} flatShading roughness={1} />
      </mesh>
      <mesh position={[0, -0.26, 0]} receiveShadow>
        <cylinderGeometry args={[7.42, 7.3, 0.27, 80]} />
        <meshStandardMaterial color={palette.grass} roughness={1} />
      </mesh>
      <mesh receiveShadow>
        <tubeGeometry args={[path, 90, 0.24, 8, false]} />
        <meshStandardMaterial color="#d8cbb0" roughness={1} />
      </mesh>
      {[
        [-5.8, -0.13, -3.9, 0.9],
        [-2.2, -0.13, -6.3, 0.83],
        [3.9, -0.13, -5.6, 0.85],
        [-6.7, -0.13, 0.2, 0.7],
      ].map(([x, y, z, s], i) => (
        <IslandTree key={i} position={[x!, y!, z!]} scale={s!} palette={palette} />
      ))}
      {Array.from({ length: 24 }, (_, i) => {
        const a = i * 0.65 + palette.rotation,
          r = 6.8 + (i % 3) * 0.12;
        return (
          <group key={i}>
            <Boulder
              position={[Math.cos(a) * r, -0.1, Math.sin(a) * r]}
              scale={[0.21 + (i % 3) * 0.06, 0.16, 0.25]}
              color={palette.stone}
            />
            {i % 2 === 0 && (
              <Flowers
                position={[Math.cos(a) * 6.78, -0.12, Math.sin(a) * 6.78]}
                palette={palette}
                count={7}
              />
            )}
          </group>
        );
      })}
      <group position={[5.55, -0.06, 3.45]} rotation={[0, -0.7, 0]}>
        <mesh scale={[1.2, 0.07, 0.68]} receiveShadow>
          <sphereGeometry args={[1, 36, 12]} />
          <meshStandardMaterial color={palette.water} metalness={0.22} roughness={0.15} />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]} scale={[1, 0.5, 1]} position={[0.15, 0.075, 0]}>
          <torusGeometry args={[0.46, 0.013, 4, 40]} />
          <meshBasicMaterial color="#ccdfd7" transparent opacity={0.7} />
        </mesh>
        {[-1, 1].map((side, i) => (
          <Boulder
            key={i}
            position={[side * 0.9, 0.03, side * 0.31]}
            scale={[0.4, 0.23, 0.32]}
            color={palette.stone}
          />
        ))}
        <Flowers position={[-0.6, -0.02, -0.54]} palette={palette} count={5} />
      </group>
      <group position={[0, -0.1, 6.15]} rotation={[0, 0.08, 0]}>
        {Array.from({ length: 8 }, (_, i) => (
          <mesh key={i} position={[(i - 3.5) * 0.23, 0.08, 0.1]} castShadow receiveShadow>
            <boxGeometry args={[0.2, 0.13, 1.36]} />
            <meshStandardMaterial color={i % 2 ? '#b8a384' : '#c3af90'} roughness={0.9} />
          </mesh>
        ))}
        {[-0.8, 0.8].map((x) => (
          <mesh key={x} position={[x, -0.1, 0.15]}>
            <boxGeometry args={[0.12, 0.4, 1.4]} />
            <meshStandardMaterial color="#8f826c" />
          </mesh>
        ))}
      </group>
      <Pennant position={[-5.9, -0.06, 3.6]} palette={palette} reduced={reduced} />
      <Cloud position={[-10, -1.8, 4]} scale={1.1} reduced={reduced} />
      <Cloud position={[10, -2.2, -5]} scale={1.4} reduced={reduced} />
      <Cloud position={[0, -3, -10]} scale={1.1} reduced={reduced} />
    </group>
  );
}
