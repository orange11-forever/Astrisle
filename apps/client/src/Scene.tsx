import {
  Component,
  createContext,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode, RefObject } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { DEFAULT_CHARACTERS } from '@astrisle/contracts';
import type { CharacterProfile, ProjectSnapshot, Task } from '@astrisle/contracts';
import { directScene, emptyDirector, resolveStation } from './director';
import type { SceneIntent } from './director';
import { IslandLandscape } from './IslandLandscape';
import { CharacterVisual } from './characters/CharacterVisual';
import type { CharacterMotion } from './characters/CharacterVisual';
import { CosmicBackdrop } from './CosmicBackdrop';
import { SceneFrameBudget, useSceneActivity } from './render-budget';
import { SceneQualityContext, useScenePixelRatio } from './render-quality';
import type { SceneQuality } from './render-quality';
import { advanceWalker, createWalker, STATION_POINTS } from './island-motion';
import { Confetti } from './Confetti';
import { IslandLeisure } from './IslandLeisure';
import {
  advanceLeisure,
  createLeisure,
  releaseLeisure,
  swingAngle,
  type LeisureWorld,
} from './island-activities';
import { FACILITIES, SWING_ROPE_LENGTH } from './island-facilities';
import { CameraRig } from './StudioCamera';

const c = {
  paper: '#e7eef0',
  ink: '#203d50',
  wood: '#b6a58b',
  brass: '#ba994f',
  teal: '#4e9690',
  coral: '#c76a68',
  rock: '#7c91a0',
};
export type Panel = 'goal' | 'tasks' | 'evidence' | 'artifacts' | 'requests' | 'settings';
export type CharacterFocus = 'mori' | 'luma' | 'user';
type V3 = [number, number, number];
const homes: Record<CharacterFocus, V3> = {
  mori: [-3.45, 0.02, 1.2],
  luma: [3.45, 0.02, 1.2],
  user: [0, 0.02, 3.65],
};
function Box({
  position = [0, 0, 0],
  scale = [1, 1, 1],
  color = c.paper,
  rotation = [0, 0, 0],
  ...props
}: {
  position?: V3;
  scale?: V3;
  color?: string;
  rotation?: V3;
  onClick?: () => void;
}) {
  return (
    <mesh castShadow receiveShadow position={position} scale={scale} rotation={rotation} {...props}>
      <boxGeometry />
      <meshStandardMaterial color={color} roughness={0.72} />
    </mesh>
  );
}
function Sphere({
  position = [0, 0, 0],
  scale = [1, 1, 1],
  color = c.paper,
}: {
  position?: V3;
  scale?: V3;
  color?: string;
}) {
  return (
    <mesh castShadow position={position} scale={scale}>
      <sphereGeometry args={[1, 16, 12]} />
      <meshStandardMaterial color={color} roughness={0.8} />
    </mesh>
  );
}
function Cylinder({
  position = [0, 0, 0],
  radius = 0.2,
  height = 1,
  color = c.wood,
}: {
  position?: V3;
  radius?: number;
  height?: number;
  color?: string;
}) {
  return (
    <mesh castShadow receiveShadow position={position}>
      <cylinderGeometry
        args={[
          radius,
          radius,
          height,
          radius < 0.12 ? 8 : radius > 4 ? 96 : radius >= 0.7 ? 48 : 24,
        ]}
      />
      <meshStandardMaterial color={color} roughness={0.7} />
    </mesh>
  );
}
function Ring({
  radius = 1,
  y = 0,
  color = c.brass,
  arc = Math.PI * 2,
  rotation = 0,
}: {
  radius?: number;
  y?: number;
  color?: string;
  arc?: number;
  rotation?: number;
}) {
  return (
    <mesh position={[0, y, 0]} rotation={[-Math.PI / 2, 0, rotation]}>
      <torusGeometry args={[radius, 0.026, 6, 100, arc]} />
      <meshStandardMaterial color={color} metalness={0.6} roughness={0.4} />
    </mesh>
  );
}
const LabelPortal = createContext<RefObject<HTMLElement> | undefined>(undefined);
function Label({
  position,
  children,
  onClick,
}: {
  position: V3;
  children: ReactNode;
  onClick?: () => void;
}) {
  const portal = useContext(LabelPortal);
  return (
    <Html portal={portal} position={position} center zIndexRange={[4, 0]}>
      <button className="scene-label" onClick={onClick}>
        {children}
      </button>
    </Html>
  );
}
function Plant({ position, scale = 1 }: { position: V3; scale?: number }) {
  return (
    <group position={position} scale={scale}>
      <mesh position={[0, 0.27, 0]}>
        <cylinderGeometry args={[0.29, 0.21, 0.55, 12]} />
        <meshStandardMaterial color="#d0c2ad" />
      </mesh>
      {Array.from({ length: 7 }, (_, i) => (
        <group key={i} rotation={[0.2 * Math.sin(i), i * 2.4, 0.35]}>
          <Cylinder position={[0, 0.72, 0]} radius={0.024} height={0.8} color="#4b685c" />
          <Sphere
            position={[0.1, 0.95, 0]}
            scale={[0.17, 0.35, 0.08]}
            color={i % 2 ? '#71948a' : '#476f68'}
          />
        </group>
      ))}
    </group>
  );
}
function Books({ position, side = false }: { position: V3; side?: boolean }) {
  return (
    <group position={position} rotation={[0, side ? Math.PI / 2 : 0, 0]}>
      {['#507474', '#c6b18a', '#7c8caa', '#c78776', '#e0d6bf'].map((color, i) => (
        <Box
          key={color}
          position={[(i - 2) * 0.14, 0.22, 0]}
          scale={[0.11, 0.4 + (i % 2) * 0.09, 0.29]}
          color={color}
          rotation={[0, 0, (i - 2) * 0.025]}
        />
      ))}
    </group>
  );
}
function Lamp({ position }: { position: V3 }) {
  return (
    <group position={position}>
      <Cylinder radius={0.17} height={0.05} color={c.brass} />
      <Cylinder position={[0, 0.35, 0]} radius={0.025} height={0.7} color={c.brass} />
      <mesh position={[0, 0.75, 0]} rotation={[0, 0, 0.2]}>
        <coneGeometry args={[0.28, 0.18, 24, 1, true]} />
        <meshStandardMaterial color={c.brass} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 0.69, 0]}>
        <sphereGeometry args={[0.08, 12, 8]} />
        <meshStandardMaterial color="#fff3c4" emissive="#ffe7ae" emissiveIntensity={1.2} />
      </mesh>
    </group>
  );
}
function Desk({ x, onClick }: { x: number; onClick: () => void }) {
  return (
    <group
      position={[x, 0, -1.1]}
      scale={[0.94, 0.82, 0.94]}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Cylinder position={[0, 1.12, 0]} radius={1.12} height={0.14} color={c.wood} />
      <Cylinder position={[0, 0.57, 0]} radius={0.7} height={1} color="#81969b" />
      <Ring radius={0.73} y={0.17} />
      <Box position={[0, 1.22, 0.13]} scale={[0.82, 0.04, 0.55]} color="#edf0df" />
      <Box
        position={[0, 1.25, -0.1]}
        scale={[0.4, 0.025, 0.25]}
        color="#8da9af"
        rotation={[0, 0.2, 0]}
      />
      <Books position={[-0.62, 1.2, -0.25]} />
      <Lamp position={[0.64, 1.21, -0.3]} />
      <Cylinder position={[0, 0.48, 1.16]} radius={0.39} height={0.12} color="#597b7f" />
      <Cylinder position={[0, 0.24, 1.16]} radius={0.06} height={0.48} color={c.brass} />
      <Box position={[0, 0.85, 1.5]} scale={[0.76, 0.65, 0.16]} color="#64868b" />
    </group>
  );
}
function StarTable({ active, onClick }: { active: boolean; onClick: () => void }) {
  const petal = useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.bezierCurveTo(-1.2, 0.5, -1.22, 1.9, 0, 2.23);
    shape.bezierCurveTo(1.22, 1.9, 1.2, 0.5, 0, 0);
    return shape;
  }, []);
  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Cylinder position={[0, 0.55, 0]} radius={0.58} height={1.08} color="#748e98" />
      {[0, 1, 2].map((i) => (
        <group key={i} rotation={[0, (i * Math.PI * 2) / 3, 0]}>
          <mesh position={[0, 1.12, 0]} rotation={[-Math.PI / 2, 0, 0]} castShadow receiveShadow>
            <extrudeGeometry
              args={[
                petal,
                {
                  depth: 0.1,
                  bevelEnabled: true,
                  bevelSegments: 2,
                  steps: 1,
                  bevelSize: 0.04,
                  bevelThickness: 0.025,
                  curveSegments: 24,
                },
              ]}
            />
            <meshStandardMaterial color={i === 1 ? '#cfdddd' : '#e6e4d7'} roughness={0.6} />
          </mesh>
          <Box
            position={[0, 1.25, 1.24]}
            scale={[0.57, 0.02, 0.7]}
            rotation={[0, 0, 0]}
            color={active ? '#cfbd96' : '#a9c0c4'}
          />
        </group>
      ))}
      <Ring radius={0.55} y={1.28} />
      <mesh position={[0, 1.45, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <octahedronGeometry args={[0.19]} />
        <meshStandardMaterial color={c.brass} metalness={0.65} roughness={0.2} />
      </mesh>
    </group>
  );
}
const anchors: Record<string, V3> = Object.fromEntries(
  Object.entries(STATION_POINTS).map(([name, [x, z]]) => [name, [x, 0, z] as V3]),
);
/** One tiny draw instead of rendering the whole island into a shadow framebuffer. */
function GroundShadow() {
  return (
    <mesh position={[0, 0.006, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
      <planeGeometry args={[1.15, 0.85]} />
      <shaderMaterial
        transparent
        depthWrite={false}
        vertexShader="varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }"
        fragmentShader="varying vec2 vUv; void main(){ float a=0.18*(1.0-smoothstep(0.1,1.0,length(vUv-0.5)*2.0)); gl_FragColor=vec4(0.05,0.07,0.12,a); }"
      />
    </mesh>
  );
}
function Avatar({
  id,
  home,
  color,
  task,
  intent,
  reduced,
  onClick,
  preview = false,
  profile,
  life,
}: {
  id: CharacterFocus;
  home: V3;
  color: string;
  task?: Task;
  intent?: SceneIntent;
  reduced: boolean;
  onClick?: () => void;
  preview?: boolean;
  profile?: CharacterProfile;
  life: LeisureWorld;
}) {
  const root = useRef<THREE.Group>(null);
  const seatPivot = useRef<THREE.Group>(null);
  const seatOffset = useRef<THREE.Group>(null);
  const labelRoot = useRef<THREE.Group>(null);
  const activity = useSceneActivity();
  const walker = useRef(createWalker(id, [home[0], home[2]]));
  const leisure = useMemo(() => createLeisure(id), [id]);
  const [leisureLabel, setLeisureLabel] = useState('散步');
  const label = useRef('散步');
  useEffect(() => {
    life.states.set(id, leisure);
    return () => {
      releaseLeisure(leisure, life.reservations);
      life.states.delete(id);
    };
  }, [id, life, leisure]);
  const motion = useRef<CharacterMotion>({
    walking: false,
    working: false,
    carrying: false,
    time: 0,
  });
  const character = profile ?? DEFAULT_CHARACTERS.find((entry) => entry.id === id)!;
  const target = intent && !intent.stationary ? anchors[intent.anchor] || home : home;
  const roaming = !preview && !intent && (!task || ['passed', 'cancelled'].includes(task.status));
  useFrame((_, delta) => {
    if (!root.current) return;
    advanceLeisure(leisure, delta, {
      position: walker.current.position,
      idle: roaming,
      reduced: reduced || preview,
      active: activity,
      capable: motion.current.leisureCapable ?? false,
      reservations: life.reservations,
    });
    const facility = leisure.facility ? FACILITIES[leisure.facility] : undefined;
    const state = advanceWalker(walker.current, delta, {
      roaming: roaming && !facility,
      target: facility?.approach ?? [target[0], target[2]],
      reduced,
      active: activity,
      preview,
    });
    const weight = leisure.blend;
    const angle = swingAngle(leisure);
    const sway = -SWING_ROPE_LENGTH * Math.sin(angle);
    const lift = SWING_ROPE_LENGTH * (1 - Math.cos(angle));
    root.current.position.set(
      THREE.MathUtils.lerp(state.position[0], facility?.position[0] ?? state.position[0], weight) +
        Math.sin(facility?.yaw ?? 0) * sway,
      home[1] + lift,
      THREE.MathUtils.lerp(state.position[1], facility?.position[1] ?? state.position[1], weight) +
        Math.cos(facility?.yaw ?? 0) * sway,
    );
    const walking = state.speed > 0.025 && !reduced && activity && weight === 0;
    const working = task?.status === 'running' && !/model|response|等待/i.test(task.step);
    motion.current.walking = walking;
    motion.current.working = working;
    motion.current.carrying = !!intent;
    if (activity && !reduced) motion.current.time += Math.min(Math.max(delta, 0), 0.05);
    motion.current.phase = state.phase;
    motion.current.strength = state.strength;
    motion.current.leisure =
      facility && weight > 0
        ? {
            activity: facility.activity,
            blend: weight,
            time: leisure.time,
            seatHeight: facility.seatHeight,
          }
        : undefined;
    const turn = facility
      ? Math.atan2(Math.sin(facility.yaw - state.yaw), Math.cos(facility.yaw - state.yaw))
      : 0;
    root.current.rotation.y = preview ? 0 : state.yaw + turn * weight;
    if (seatPivot.current && seatOffset.current) {
      seatPivot.current.position.y = (facility?.seatHeight ?? 0) * weight;
      seatPivot.current.rotation.x = angle;
      seatOffset.current.position.y = -seatPivot.current.position.y;
    }
    if (labelRoot.current)
      labelRoot.current.position.y =
        2.12 + Math.max(0, (facility?.seatHeight ?? 0) - 0.18) * weight;
    root.current.userData.activity = facility?.activity ?? 'walk';
    root.current.userData.activityStage = leisure.stage;
    root.current.userData.activityBlend = weight;
    const description =
      leisure.stage === 'approaching'
        ? `走向${facility!.name}`
        : leisure.stage === 'settling'
          ? '坐下休息'
          : leisure.stage === 'leaving'
            ? '起身'
            : leisure.stage === 'enjoying'
              ? facility!.activity === 'tea'
                ? '喝茶'
                : facility!.activity === 'swing'
                  ? '荡秋千'
                  : '小憩'
              : reduced
                ? '空闲'
                : '散步';
    if (label.current !== description) {
      label.current = description;
      setLeisureLabel(description);
    }
  }, -1);
  return (
    <group
      ref={root}
      name={`avatar-${id}`}
      position={home}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
    >
      <group ref={seatPivot}>
        <group ref={seatOffset}>
          <CharacterVisual
            profile={character}
            motionRef={motion}
            reduced={reduced}
            accent={color}
          />
        </group>
      </group>
      <GroundShadow />
      {!preview && id !== 'user' && (
        <group ref={labelRoot} position={[0, 2.12, 0]}>
          <Label position={[0, 0, 0]} onClick={onClick}>
            <b>{character.displayName}</b>
            <span>
              {task
                ? task.status === 'running'
                  ? '工作中'
                  : task.status === 'waiting_input'
                    ? '等待输入'
                    : task.status === 'waiting_approval'
                      ? '等待审批'
                      : '待命'
                : leisureLabel}
            </span>
          </Label>
        </group>
      )}
    </group>
  );
}
function World({
  workspaceId,
  snapshot,
  onPanel,
  reduced,
  reset,
  fixed,
  focus,
  characters,
  celebration,
}: {
  workspaceId: string;
  snapshot?: ProjectSnapshot;
  onPanel: (panel: Panel) => void;
  reduced: boolean;
  reset: number;
  fixed: boolean;
  focus?: CharacterFocus;
  characters?: CharacterProfile[];
  celebration?: number | null;
}) {
  const director = useRef(emptyDirector());
  const life = useMemo<LeisureWorld>(
    () => ({ states: new Map(), reservations: new Map() }),
    [workspaceId],
  );
  const [intents, setIntents] = useState<SceneIntent[]>([]);
  useEffect(() => {
    if (snapshot) {
      director.current = directScene(director.current, snapshot, Date.now(), reduced);
      setIntents(director.current.intents);
    } else {
      director.current = emptyDirector();
      setIntents([]);
    }
  }, [snapshot, reduced]);
  useEffect(() => {
    if (!intents.length) return;
    const timer = setTimeout(
      () => setIntents((old) => old.filter((i) => i.expiresAt > Date.now())),
      reduced ? 160 : 5600,
    );
    return () => clearTimeout(timer);
  }, [intents, reduced]);
  const occupied = new Set<string>();
  const visualIntents = intents.map((i) => {
    const conflict = occupied.has(i.anchor);
    occupied.add(i.anchor);
    return resolveStation(i, conflict, 1500)!;
  });
  const profileFor = (id: CharacterFocus) =>
    characters?.find((profile) => profile.id === id) ??
    DEFAULT_CHARACTERS.find((profile) => profile.id === id)!;
  if (focus) {
    const home = homes[focus];
    return (
      <>
        <color attach="background" args={['#e3edf1']} />
        <ambientLight intensity={0.75} />
        <hemisphereLight args={['#edf5ff', '#93a6b4', 1.5]} />
        <directionalLight position={[home[0] - 3, 6, home[2] + 4]} intensity={2.4} />
        <directionalLight
          position={[home[0] + 4, 3, home[2] + 1]}
          intensity={0.7}
          color="#d2e9ff"
        />
        <CameraRig reset={reset} fixed={fixed} focus={focus} reduced={reduced} />
        <Avatar
          key={focus}
          id={focus}
          profile={profileFor(focus)}
          life={life}
          home={home}
          color={focus === 'mori' ? '#497a75' : focus === 'luma' ? '#818ba9' : '#ceb8a1'}
          reduced={reduced}
          preview
        />
        <mesh position={[home[0], -0.05, home[2]]} receiveShadow>
          <cylinderGeometry args={[0.75, 0.79, 0.09, 64]} />
          <meshStandardMaterial color="#f3f2ec" roughness={0.86} />
        </mesh>
      </>
    );
  }
  return (
    <>
      <CosmicBackdrop reduced={reduced} />
      <ambientLight intensity={0.9} />
      <hemisphereLight args={['#c6d9ff', '#64557c', 1.35]} />
      <directionalLight position={[-6, 12, 8]} intensity={2.3} color="#ffe8c8" />
      <directionalLight position={[6, 3, -8]} intensity={1.1} color="#98a9ed" />
      <CameraRig reset={reset} fixed={fixed} focus={focus} reduced={reduced} />
      <IslandLandscape workspaceId={workspaceId} reduced={reduced} />
      <IslandLeisure life={life} />
      {celebration != null && !reduced && <Confetti key={celebration} burst={celebration} />}
      <group position={[0, -0.38, 0]}>
        <mesh receiveShadow>
          <cylinderGeometry args={[6.1, 5.4, 0.55, 80]} />
          <meshStandardMaterial color="#a5b4b5" />
        </mesh>
        <Cylinder position={[0, 0.3, 0]} radius={5.97} height={0.13} color="#b9ad97" />
        <Ring radius={5.78} y={0.39} />
        {Array.from({ length: 19 }, (_, i) => (
          <Box
            key={i}
            position={[(i - 9) * 0.58, 0.375, 0]}
            scale={[0.016, 0.006, Math.sqrt(Math.max(0, 35 - ((i - 9) * 0.58) ** 2)) * 2]}
            color="#a89b85"
          />
        ))}
      </group>
      <group position={[0, 0, -0.65]} scale={0.82}>
        <StarTable active={!!snapshot} onClick={() => onPanel('goal')} />
      </group>
      <Desk x={-3.6} onClick={() => onPanel('tasks')} />
      <Desk x={3.6} onClick={() => onPanel('tasks')} />
      <group position={[0, 0, -3.55]} onClick={() => onPanel('evidence')}>
        <Box position={[0, 1.5, 0]} scale={[2.2, 1.7, 0.13]} color={c.wood} />
        <Box position={[-0.55, 1.52, 0.085]} scale={[0.94, 1.4, 0.025]} color="#dce4de" />
        <Box position={[0.55, 1.52, 0.085]} scale={[0.94, 1.4, 0.025]} color="#c7d8dc" />
        {[-0.78, 0.78].map((x) => (
          <Cylinder key={x} position={[x, 0.6, 0]} radius={0.04} height={1.2} color={c.brass} />
        ))}
        <mesh position={[0, 1.5, 0.25]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.3, 0.025, 8, 32]} />
          <meshStandardMaterial color={c.brass} />
        </mesh>
        <Label position={[0, 2.6, 0]} onClick={() => onPanel('evidence')}>
          对照架 · 检查记录
        </Label>
      </group>
      <group position={[-3.3, 0, -3.55]} rotation={[0, 0.37, 0]}>
        <Box position={[0, 1.25, 0]} scale={[2.1, 2.5, 0.55]} color="#8a9085" />
        {[0.5, 1.2, 1.9].map((y) => (
          <group key={y}>
            <Box position={[0, y, 0.1]} scale={[2.15, 0.08, 0.67]} color={c.wood} />
            <Books position={[-0.45, y + 0.04, 0.24]} />
            <Books position={[0.4, y + 0.04, 0.24]} />
          </group>
        ))}
      </group>
      <group position={[2.75, 0, -3.75]} rotation={[0, -0.25, 0]}>
        <Box position={[0, 0.43, 0]} scale={[2.3, 0.5, 0.85]} color="#719093" />
        <Box position={[0, 0.85, -0.35]} scale={[2.3, 0.75, 0.22]} color="#77999a" />
        <Box
          position={[-0.63, 0.91, 0]}
          scale={[0.55, 0.55, 0.17]}
          color="#d5bdb2"
          rotation={[0, 0, 0.12]}
        />
        <Box
          position={[0.45, 0.9, 0]}
          scale={[0.6, 0.5, 0.18]}
          color="#d2d7ca"
          rotation={[0, 0, -0.13]}
        />
      </group>
      <group position={[-4.2, 0, 2.7]} onClick={() => onPanel('requests')}>
        <Cylinder radius={0.55} height={0.12} position={[0, 0.12, 0]} color={c.wood} />
        <Cylinder radius={0.04} height={0.95} position={[0, 0.6, 0]} color={c.brass} />
        <Box position={[0, 1.18, 0]} scale={[0.8, 0.67, 0.24]} color="#d3dfdc" />
        <Box position={[0, 1.22, 0.14]} scale={[0.49, 0.06, 0.03]} color={c.ink} />
        <Label position={[-0.4, 0.85, 0.65]} onClick={() => onPanel('requests')}>
          回信匣
          {snapshot?.requests.some((r) => r.status === 'open') ? ' · 需要你' : ' · 输入与审批'}
        </Label>
      </group>
      <group position={[4.2, 0, 2.7]} onClick={() => onPanel('artifacts')}>
        <Box position={[0, 0.12, 0]} scale={[2, 0.2, 1.5]} color={c.wood} />
        <Box position={[0, 0.48, 0]} scale={[1.25, 0.56, 0.8]} color="#dce0d1" />
        {[-0.57, 0.57].map((x) => (
          <Box key={x} position={[x, 0.5, 0.405]} scale={[0.045, 0.63, 0.025]} color={c.brass} />
        ))}
        <group
          position={[0, 0.78, -0.4]}
          rotation={[snapshot?.commission.status === 'awaiting_acceptance' ? -1.1 : 0, 0, 0]}
        >
          <Box position={[0, 0.04, 0.4]} scale={[1.3, 0.1, 0.86]} color="#e3e4d7" />
        </group>
        <Label position={[0, 0.95, 0.9]} onClick={() => onPanel('artifacts')}>
          交付港 · {snapshot?.artifacts.length ? `${snapshot.artifacts.length} 项成果` : '等待成果'}
        </Label>
      </group>
      {[
        [-5, 0, 2],
        [-5, 0, -2],
        [4.65, 0, -2.7],
        [1.2, 0, -4.7],
        [-1.7, 0, -4.7],
      ].map((p, i) => (
        <Plant key={i} position={p as V3} scale={i > 2 ? 0.8 : 1} />
      ))}
      <group position={[0, 0, -0.1]}>
        {[0, 0.5, 1].map((y, i) => (
          <mesh
            key={i}
            position={[0, y * 2.4 + 0.45, 0]}
            rotation={[-Math.PI / 2, 0.0, Math.PI * 0.05]}
          >
            <torusGeometry args={[Math.sqrt(37 - (y * 2.4) ** 2), 0.055, 8, 80, Math.PI * 0.96]} />
            <meshStandardMaterial color={c.wood} />
          </mesh>
        ))}
        {[-2.3, -1.15, 0, 1.15, 2.3].map((a, i) => (
          <mesh key={i} rotation={[Math.PI / 2, 0, a]} position={[0, 0.4, 0]}>
            <torusGeometry args={[5.9, 0.045, 6, 60, Math.PI * 0.46]} />
            <meshStandardMaterial color={c.brass} transparent opacity={0.55} />
          </mesh>
        ))}
      </group>
      <Avatar
        id="mori"
        life={life}
        profile={profileFor('mori')}
        home={homes.mori}
        color="#497a75"
        task={snapshot?.tasks.find(
          (t) => t.agentId === 'mori' && !['passed', 'cancelled'].includes(t.status),
        )}
        intent={visualIntents.find((i) => i.actorId === 'mori')}
        reduced={reduced}
        onClick={() => onPanel('tasks')}
      />
      <Avatar
        id="luma"
        life={life}
        profile={profileFor('luma')}
        home={homes.luma}
        color="#818ba9"
        task={snapshot?.tasks.find(
          (t) => t.agentId === 'luma' && !['passed', 'cancelled'].includes(t.status),
        )}
        intent={visualIntents.find((i) => i.actorId === 'luma')}
        reduced={reduced}
        onClick={() => onPanel('tasks')}
      />
      <Avatar
        id="user"
        life={life}
        profile={profileFor('user')}
        home={homes.user}
        color="#ceb8a1"
        reduced={reduced}
      />
    </>
  );
}
class SceneBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="scene-fallback">
        <h2>场景暂时无法显示</h2>
        <p>你仍可通过两侧面板管理委托、查看成果。</p>
      </div>
    ) : (
      this.props.children
    );
  }
}
export function StudioScene(props: {
  workspaceId: string;
  snapshot?: ProjectSnapshot;
  onPanel: (panel: Panel) => void;
  reduced: boolean;
  reset: number;
  fixed: boolean;
  focus?: CharacterFocus;
  characters?: CharacterProfile[];
  quality?: SceneQuality;
  celebration?: number | null;
}) {
  const portal = useRef<HTMLDivElement>(null!);
  const active = useSceneActivity();
  const quality = props.quality ?? 'clear';
  const dpr = useScenePixelRatio(quality, portal);
  return (
    <SceneBoundary>
      <div className="studio-canvas" style={{ position: 'absolute', inset: 0 }}>
        <div
          ref={portal}
          className="scene-label-layer"
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2 }}
        />
        <Canvas
          dpr={dpr}
          frameloop="demand"
          camera={{ position: [13.5, 13.5, 20.3], fov: 38 }}
          gl={{ antialias: true, powerPreference: 'default' }}
        >
          <SceneFrameBudget reduced={props.reduced} active={active} />
          <SceneQualityContext.Provider value={quality}>
            <LabelPortal.Provider value={portal}>
              <Suspense fallback={null}>
                <World key={props.workspaceId} {...props} />
              </Suspense>
            </LabelPortal.Provider>
          </SceneQualityContext.Provider>
        </Canvas>
      </div>
    </SceneBoundary>
  );
}
