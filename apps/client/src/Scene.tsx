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
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { ProjectSnapshot, Task } from '@astrisle/contracts';
import { directScene, emptyDirector, resolveStation } from './director';
import type { SceneIntent } from './director';
import { IslandLandscape } from './IslandLandscape';

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
type V3 = [number, number, number];
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
      <cylinderGeometry args={[radius, radius, height, 48]} />
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
    <Html portal={portal} position={position} center distanceFactor={18} zIndexRange={[4, 0]}>
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
      position={[x, 0, -0.3]}
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
      <Ring radius={2.55} y={0.95} arc={Math.PI * 1.72} rotation={0.42} />
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <Cylinder
          key={i}
          position={[Math.cos(i * 0.8) * 2.55, 0.5, Math.sin(i * 0.8) * 2.55]}
          radius={0.025}
          height={0.9}
          color={c.brass}
        />
      ))}
    </group>
  );
}
const anchors: Record<string, V3> = {
  table: [-1.7, 0, 1.8],
  compare: [0.8, 0, -2.4],
  dock: [3.5, 0, 3],
  mail: [-3.5, 0, 3],
};
function Avatar({
  id,
  home,
  color,
  task,
  intent,
  reduced,
  onClick,
}: {
  id: string;
  home: V3;
  color: string;
  task?: Task;
  intent?: SceneIntent;
  reduced: boolean;
  onClick?: () => void;
}) {
  const body = useRef<THREE.Group>(null),
    head = useRef<THREE.Group>(null),
    armL = useRef<THREE.Group>(null),
    armR = useRef<THREE.Group>(null),
    legL = useRef<THREE.Group>(null),
    legR = useRef<THREE.Group>(null),
    root = useRef<THREE.Group>(null);
  const target = intent && !intent.stationary ? anchors[intent.anchor] || home : home;
  useFrame(({ clock }, delta) => {
    if (!root.current || !body.current) return;
    const t = clock.elapsedTime + (id === 'mori' ? 0 : 2.4);
    const targetV = new THREE.Vector3(...target);
    const dist = root.current.position.distanceTo(targetV);
    if (reduced) root.current.position.copy(targetV);
    else root.current.position.lerp(targetV, 1 - Math.exp(-Math.min(delta, 0.05) * 1.8));
    const walk = dist > 0.15 && !reduced;
    const working = task?.status === 'running' && !/model|response|等待/i.test(task.step);
    body.current.position.y = reduced ? 0 : Math.sin(t * 1.7) * 0.012;
    if (head.current) head.current.rotation.z = reduced ? 0 : Math.sin(t * 0.7) * 0.045;
    const swing = walk ? Math.sin(t * 8) * 0.52 : 0;
    if (legL.current) legL.current.rotation.x = swing;
    if (legR.current) legR.current.rotation.x = -swing;
    if (armL.current)
      armL.current.rotation.x = walk
        ? -swing
        : working
          ? -0.65 + Math.sin(t * 5) * 0.09
          : intent
            ? -0.85
            : Math.sin(t * 0.9) * 0.06;
    if (armR.current)
      armR.current.rotation.x = walk
        ? swing
        : working
          ? -0.65 + Math.cos(t * 5) * 0.09
          : intent
            ? -0.6
            : Math.sin(t * 0.9 + 1) * 0.06;
    root.current.rotation.y = walk
      ? Math.atan2(target[0] - root.current.position.x, target[2] - root.current.position.z)
      : id === 'user'
        ? Math.PI
        : Math.PI * 0.85;
  });
  return (
    <group
      ref={root}
      position={home}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      <group ref={body}>
        <group position={[0, 0.5, 0]}>
          <group ref={legL} position={[-0.13, 0, 0]}>
            <Box position={[0, -0.18, 0]} scale={[0.19, 0.48, 0.22]} color="#344958" />
            <Box position={[0, -0.4, 0.06]} scale={[0.22, 0.13, 0.33]} color="#374048" />
          </group>
          <group ref={legR} position={[0.13, 0, 0]}>
            <Box position={[0, -0.18, 0]} scale={[0.19, 0.48, 0.22]} color="#344958" />
            <Box position={[0, -0.4, 0.06]} scale={[0.22, 0.13, 0.33]} color="#374048" />
          </group>
        </group>
        <mesh position={[0, 0.88, 0]} castShadow>
          <capsuleGeometry args={[0.28, 0.34, 4, 12]} />
          <meshStandardMaterial color={color} />
        </mesh>
        <Box position={[0, 0.89, 0.26]} scale={[0.12, 0.37, 0.025]} color="#e6e0d0" />
        <group ref={armL} position={[-0.32, 1.06, 0]}>
          <mesh position={[0, -0.2, 0]} castShadow>
            <capsuleGeometry args={[0.095, 0.31, 4, 8]} />
            <meshStandardMaterial color={color} />
          </mesh>
          <Sphere position={[0, -0.43, 0]} scale={[0.085, 0.095, 0.08]} color="#d3ab8e" />
        </group>
        <group ref={armR} position={[0.32, 1.06, 0]}>
          <mesh position={[0, -0.2, 0]} castShadow>
            <capsuleGeometry args={[0.095, 0.31, 4, 8]} />
            <meshStandardMaterial color={color} />
          </mesh>
          <Sphere position={[0, -0.43, 0]} scale={[0.085, 0.095, 0.08]} color="#d3ab8e" />
          {intent && (
            <Box
              position={[0, -0.39, 0.15]}
              scale={[0.3, 0.04, 0.34]}
              color={intent.kind === 'return' ? c.coral : c.paper}
            />
          )}
        </group>
        <group ref={head} position={[0, 1.47, 0]}>
          <Sphere scale={[0.255, 0.29, 0.235]} color="#dab498" />
          <Sphere
            position={[0, 0.13, -0.025]}
            scale={[0.27, 0.22, 0.25]}
            color={id === 'mori' ? '#4d4038' : '#3e3940'}
          />
          <Sphere position={[-0.19, 0.055, 0.12]} scale={[0.09, 0.16, 0.12]} color="#4d4038" />
          {id !== 'mori' && (
            <Sphere position={[0, 0.32, -0.1]} scale={[0.14, 0.14, 0.14]} color="#3e3940" />
          )}
          <Sphere position={[-0.084, -0.01, 0.222]} scale={[0.018, 0.025, 0.012]} color={c.ink} />
          <Sphere position={[0.084, -0.01, 0.222]} scale={[0.018, 0.025, 0.012]} color={c.ink} />
        </group>
        {id === 'mori' && (
          <Box position={[-0.24, 0.76, -0.04]} scale={[0.17, 0.35, 0.25]} color="#a47f53" />
        )}
      </group>
      {id !== 'user' && (
        <Label position={[0, 2.04, 0]} onClick={onClick}>
          <b>{id === 'mori' ? 'Mori' : 'Luma'}</b>
          <span>
            {task
              ? task.status === 'running'
                ? '工作中'
                : task.status === 'waiting_input'
                  ? '等待输入'
                  : task.status === 'waiting_approval'
                    ? '等待审批'
                    : '待命'
              : id === 'mori'
                ? '探索伙伴'
                : '整理伙伴'}
          </span>
        </Label>
      )}
    </group>
  );
}
function CameraRig({ reset, fixed }: { reset: number; fixed: boolean }) {
  const { camera, size } = useThree();
  const controls = useRef<any>(null);
  useEffect(() => {
    const fit = Math.max(1, 1.05 / (size.width / size.height));
    camera.position.set(12 * fit, 12 * fit, 17.5 * fit);
    camera.lookAt(0, 0, 0);
    if (controls.current) {
      controls.current.target.set(0, 0.35, 0);
      controls.current.update();
    }
  }, [reset, camera, size.width, size.height]);
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enablePan={false}
      enableRotate={!fixed}
      minDistance={12}
      maxDistance={70}
      minPolarAngle={0.48}
      maxPolarAngle={1.2}
      minAzimuthAngle={-0.75}
      maxAzimuthAngle={0.9}
      target={[0, 0.35, 0]}
    />
  );
}
function World({
  workspaceId,
  snapshot,
  onPanel,
  reduced,
  reset,
  fixed,
}: {
  workspaceId: string;
  snapshot?: ProjectSnapshot;
  onPanel: (panel: Panel) => void;
  reduced: boolean;
  reset: number;
  fixed: boolean;
}) {
  const director = useRef(emptyDirector());
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
  return (
    <>
      <color attach="background" args={['#dce7ed']} />
      <fog attach="fog" args={['#dce7ed', 70, 140]} />
      <ambientLight intensity={1.25} />
      <hemisphereLight args={['#e9f1ff', '#718b8e', 2]} />
      <directionalLight
        position={[-6, 12, 8]}
        intensity={3}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-8}
        shadow-camera-right={8}
        shadow-camera-top={8}
        shadow-camera-bottom={-8}
        shadow-bias={-0.001}
      />
      <CameraRig reset={reset} fixed={fixed} />
      <IslandLandscape workspaceId={workspaceId} reduced={reduced} />
      <group position={[0, -0.38, 0]}>
        <mesh receiveShadow>
          <cylinderGeometry args={[6.1, 5.4, 0.55, 80]} />
          <meshStandardMaterial color="#a5b4b5" />
        </mesh>
        <mesh position={[0, -0.7, 0]} rotation={[0, 0.1, 0]}>
          <coneGeometry args={[5.6, 1.6, 9]} />
          <meshStandardMaterial color={c.rock} flatShading />
        </mesh>
        <Cylinder position={[0, 0.3, 0]} radius={5.97} height={0.13} color="#b9ad97" />
        <Ring radius={5.78} y={0.39} />
        <Ring radius={3} y={0.39} color="#e0d2b2" />
        {Array.from({ length: 19 }, (_, i) => (
          <Box
            key={i}
            position={[(i - 9) * 0.58, 0.375, 0]}
            scale={[0.016, 0.006, Math.sqrt(Math.max(0, 35 - ((i - 9) * 0.58) ** 2)) * 2]}
            color="#a89b85"
          />
        ))}
      </group>
      <group position={[0, 0, -0.1]}>
        <StarTable active={!!snapshot} onClick={() => onPanel('goal')} />
      </group>
      <Desk x={-3.9} onClick={() => onPanel('tasks')} />
      <Desk x={3.9} onClick={() => onPanel('tasks')} />
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
      <group position={[-3.65, 0, 3.05]} onClick={() => onPanel('requests')}>
        <Cylinder radius={0.55} height={0.12} position={[0, 0.12, 0]} color={c.wood} />
        <Cylinder radius={0.04} height={0.95} position={[0, 0.6, 0]} color={c.brass} />
        <Box position={[0, 1.18, 0]} scale={[0.8, 0.67, 0.24]} color="#d3dfdc" />
        <Box position={[0, 1.22, 0.14]} scale={[0.49, 0.06, 0.03]} color={c.ink} />
        <Label position={[0, 1.9, 0]} onClick={() => onPanel('requests')}>
          回信匣
          {snapshot?.requests.some((r) => r.status === 'open') ? ' · 需要你' : ' · 输入与审批'}
        </Label>
      </group>
      <group position={[3.65, 0, 3]} onClick={() => onPanel('artifacts')}>
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
        <Label position={[0, 1.5, 0]} onClick={() => onPanel('artifacts')}>
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
        home={[-3.8, 0.02, 1.05]}
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
        home={[3.8, 0.02, 1.05]}
        color="#818ba9"
        task={snapshot?.tasks.find(
          (t) => t.agentId === 'luma' && !['passed', 'cancelled'].includes(t.status),
        )}
        intent={visualIntents.find((i) => i.actorId === 'luma')}
        reduced={reduced}
        onClick={() => onPanel('tasks')}
      />
      <Avatar id="user" home={[0, 0.02, 4.6]} color="#ceb8a1" reduced={reduced} />
      <ContactShadows
        position={[0, -1.7, 0]}
        opacity={0.22}
        scale={26}
        blur={2.8}
        far={10}
        resolution={256}
      />
      <mesh position={[-6, 6, -15]}>
        <sphereGeometry args={[1.3, 32, 24]} />
        <meshBasicMaterial color="#f5f1d4" />
      </mesh>
      {[-1, 1].map((side) => (
        <group key={side} position={[side * 9, -2, -2]}>
          {Array.from({ length: 6 }, (_, i) => (
            <Sphere
              key={i}
              position={[Math.sin(i * 2) * 2, -i * 0.12, Math.cos(i) * 3]}
              scale={[3, 1, 2]}
              color="#e9eef0"
            />
          ))}
        </group>
      ))}
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
}) {
  const portal = useRef<HTMLDivElement>(null!);
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return (
    <SceneBoundary>
      <div className="studio-canvas" style={{ position: 'absolute', inset: 0 }}>
        <div
          ref={portal}
          className="scene-label-layer"
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2 }}
        />
        <Canvas
          shadows
          dpr={[1, 1.6]}
          frameloop={visible ? 'always' : 'never'}
          camera={{ position: [12, 12, 17.5], fov: 38 }}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
        >
          <LabelPortal.Provider value={portal}>
            <Suspense fallback={null}>
              <World {...props} />
            </Suspense>
          </LabelPortal.Provider>
        </Canvas>
      </div>
    </SceneBoundary>
  );
}
