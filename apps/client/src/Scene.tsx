import { Component, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Html, RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import { DEFAULT_CHARACTERS } from '@astrisle/contracts';
import type { CharacterId, CharacterProfile, ProjectSnapshot, Task } from '@astrisle/contracts';
import { directScene, emptyDirector, placeSceneActors } from './director';
import type { SceneIntent } from './director';
import { IslandLandscape } from './IslandLandscape';
import { CharacterVisual } from './characters/CharacterVisual';
import type { CharacterMotion } from './characters/CharacterVisual';
import { CosmicBackdrop, IslandSkyLighting } from './CosmicBackdrop';
import type { IslandLight, IslandLightMode } from './island-daylight';
import { useIslandLight } from './use-island-light';
import { OuterIslets } from './OuterIslets';
import { IslandGlasshouse } from './IslandGlasshouse';
import { nurseryWalkingHeight } from './garden-access';
import { HarborQuarter } from './HarborQuarter';
import { harborWalkingHeight } from './harbor-layout';
import { CoastalIslet } from './CoastalIslet';
import { coastWalkingHeight } from './coastal-islet';
import { laneWalkingHeight } from './harbor-lane';
import { HarborHorizon } from './HarborHorizon';
import {
  ArmillaryStand,
  AtlasSheets,
  BoundBooks as Books,
  ReadingGallery,
  StudioDeck,
  WritingSet,
} from './StudioWoodwork';
import { SceneFrameBudget, useSceneActivity } from './render-budget';
import { SceneQualityContext, useScenePixelRatio } from './render-quality';
import type { SceneQuality } from './render-quality';
import {
  advanceWalker,
  createWalker,
  getIslandCharacterHomes,
  islandStops,
  type GroundPoint,
} from './island-motion';
import { Confetti } from './Confetti';
import { IslandLeisure } from './IslandLeisure';
import { islandAppearance } from './islands';
import type { IslandThemeId } from './islands';
import {
  advanceLeisure,
  createLeisure,
  releaseLeisure,
  swingAngle,
  type LeisureWorld,
} from './island-activities';
import { FACILITIES, SWING_ROPE_LENGTH } from './island-facilities';
import { CameraRig, type StudioDistrict } from './StudioCamera';
import { LabelPortal, ToolStation } from './ToolStation';

const c = {
  paper: '#e7eef0',
  ink: '#203d50',
  wood: '#b6a58b',
  brass: '#ba994f',
  teal: '#4e9690',
  coral: '#c76a68',
  rock: '#7c91a0',
};
export type Panel =
  | 'goal'
  | 'tasks'
  | 'dialogue'
  | 'evidence'
  | 'artifacts'
  | 'requests'
  | 'dailyNews'
  | 'settings';
export type CharacterFocus = CharacterId;
type V3 = [number, number, number];
const characterHeight = 0.02;
const partnerAccents = ['#866d8b', '#937555', '#577c8e', '#728555'];
const UNIT_BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);
const UNIT_SPHERE_GEOMETRY = new THREE.SphereGeometry(1, 16, 12);
const PLANT_POT_GEOMETRY = new THREE.CylinderGeometry(0.29, 0.21, 0.55, 12);
const cylinderGeometryCache = new Map<string, THREE.CylinderGeometry>();
const torusGeometryCache = new Map<string, THREE.TorusGeometry>();
const standardMaterialCache = new Map<string, THREE.MeshStandardMaterial>();

function getCylinderGeometry(radius: number, height: number): THREE.CylinderGeometry {
  const segments = radius < 0.12 ? 8 : radius > 4 ? 96 : radius >= 0.7 ? 48 : 24;
  const key = `${radius}:${height}:${segments}`;
  let geometry = cylinderGeometryCache.get(key);
  if (!geometry) {
    geometry = new THREE.CylinderGeometry(radius, radius, height, segments);
    cylinderGeometryCache.set(key, geometry);
  }
  return geometry;
}

function getTorusGeometry(radius: number, arc: number): THREE.TorusGeometry {
  const key = `${radius}:${arc}`;
  let geometry = torusGeometryCache.get(key);
  if (!geometry) {
    geometry = new THREE.TorusGeometry(radius, 0.026, 6, 100, arc);
    torusGeometryCache.set(key, geometry);
  }
  return geometry;
}

function getStandardMaterial(
  color: string,
  roughness: number,
  metalness = 0,
): THREE.MeshStandardMaterial {
  const key = `${color}|${roughness}|${metalness}`;
  let material = standardMaterialCache.get(key);
  if (!material) {
    material = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    standardMaterialCache.set(key, material);
  }
  return material;
}

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
    <mesh
      castShadow
      receiveShadow
      position={position}
      scale={scale}
      rotation={rotation}
      geometry={UNIT_BOX_GEOMETRY}
      material={getStandardMaterial(color, 0.72)}
      {...props}
    />
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
    <mesh
      castShadow
      position={position}
      scale={scale}
      geometry={UNIT_SPHERE_GEOMETRY}
      material={getStandardMaterial(color, 0.8)}
    />
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
    <mesh
      castShadow
      receiveShadow
      position={position}
      geometry={getCylinderGeometry(radius, height)}
      material={getStandardMaterial(color, 0.7)}
    />
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
    <mesh
      position={[0, y, 0]}
      rotation={[-Math.PI / 2, 0, rotation]}
      geometry={getTorusGeometry(radius, arc)}
      material={getStandardMaterial(color, 0.4, 0.6)}
    />
  );
}
function Label({
  position,
  children,
  onClick,
  characterId,
  taskId,
  title,
}: {
  position: V3;
  children: ReactNode;
  onClick?: () => void;
  characterId: CharacterId;
  taskId?: string;
  title?: string;
}) {
  const portal = useContext(LabelPortal);
  return (
    <Html portal={portal} position={position} center zIndexRange={[4, 0]}>
      <button
        className="scene-label"
        title={title}
        onClick={onClick}
        data-character-id={characterId}
        data-task-id={taskId}
      >
        {children}
      </button>
    </Html>
  );
}
function Plant({ position, scale = 1 }: { position: V3; scale?: number }) {
  return (
    <group position={position} scale={scale}>
      <mesh
        position={[0, 0.27, 0]}
        geometry={PLANT_POT_GEOMETRY}
        material={getStandardMaterial('#d0c2ad', 1)}
      />
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
function Lamp({ position }: { position: V3 }) {
  return (
    <group position={position}>
      <Cylinder radius={0.17} height={0.05} color={c.brass} />
      <Cylinder position={[0, 0.35, 0]} radius={0.025} height={0.7} color={c.brass} />
      <mesh position={[0, 0.72, 0]} rotation={[0, 0, 0.15]}>
        <sphereGeometry args={[0.26, 24, 10, 0, Math.PI * 2, 0, Math.PI * 0.46]} />
        <meshStandardMaterial color="#446d64" side={THREE.DoubleSide} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.69, 0]}>
        <sphereGeometry args={[0.08, 12, 8]} />
        <meshStandardMaterial color="#fff3c4" emissive="#ffe7ae" emissiveIntensity={1.2} />
      </mesh>
    </group>
  );
}
const deskPedestal = [
  [0, 0.02],
  [0.66, 0.02],
  [0.7, 0.08],
  [0.64, 0.16],
  [0.48, 0.21],
  [0.31, 0.38],
  [0.28, 0.67],
  [0.41, 0.92],
  [0.69, 1.035],
  [0, 1.06],
].map(([r, y]) => new THREE.Vector2(r, y));
const DESK_PEDESTAL_GEOMETRY = new THREE.LatheGeometry(deskPedestal, 40);
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
      <mesh geometry={DESK_PEDESTAL_GEOMETRY} material={getStandardMaterial('#648480', 0.54)} />
      <Ring radius={0.66} y={0.12} />
      <Ring radius={1.109} y={1.1} />
      <WritingSet />
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
      <ArmillaryStand />
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
            <meshStandardMaterial color="#c0a377" metalness={0.24} roughness={0.52} />
          </mesh>
          <mesh
            position={[0, 1.252, -0.075]}
            rotation={[-Math.PI / 2, 0, 0]}
            scale={[0.95, 0.93, 1]}
          >
            <shapeGeometry args={[petal, 24]} />
            <meshStandardMaterial color={active ? '#3a7374' : '#547e7b'} roughness={0.47} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
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
  home,
  target = home,
  color,
  task,
  intent,
  reduced,
  onClick,
  dialogueAvailable,
  preview = false,
  profile,
  life,
}: {
  home: GroundPoint;
  target?: GroundPoint;
  color: string;
  task?: Task;
  intent?: SceneIntent;
  reduced: boolean;
  onClick?: () => void;
  dialogueAvailable?: boolean;
  preview?: boolean;
  profile: CharacterProfile;
  life: LeisureWorld;
}) {
  const id = profile.id;
  const root = useRef<THREE.Group>(null);
  const seatPivot = useRef<THREE.Group>(null);
  const seatOffset = useRef<THREE.Group>(null);
  const labelRoot = useRef<THREE.Group>(null);
  const activity = useSceneActivity();
  const walker = useRef<ReturnType<typeof createWalker> | null>(null);
  if (!walker.current) walker.current = createWalker(id, home);
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
  const roaming = !preview && !intent && (!task || ['passed', 'cancelled'].includes(task.status));
  useFrame((_, delta) => {
    if (!root.current || !walker.current) return;
    advanceLeisure(leisure, delta, {
      position: walker.current.position,
      idle: roaming,
      reduced: reduced || preview,
      active: activity,
      capable: motion.current.leisureCapable ?? false,
      visitingHarbor: !!walker.current.harborVisit,
      reservations: life.reservations,
    });
    const facility = leisure.facility ? FACILITIES[leisure.facility] : undefined;
    const state = advanceWalker(walker.current, delta, {
      roaming: roaming && !facility,
      target: facility?.approach ?? target,
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
      characterHeight +
        (preview
          ? 0
          : Math.max(
              harborWalkingHeight(state.position),
              nurseryWalkingHeight(state.position),
              coastWalkingHeight(state.position),
              laneWalkingHeight(state.position),
            )) +
        lift,
      THREE.MathUtils.lerp(state.position[1], facility?.position[1] ?? state.position[1], weight) +
        Math.cos(facility?.yaw ?? 0) * sway,
    );
    const walking = state.speed > 0.025 && !reduced && activity && weight === 0;
    const atStation = state.route.length === 0 && weight === 0;
    const working =
      task?.status === 'running' &&
      !/model|response|等待/i.test(task.step) &&
      (!id.startsWith('partner-') || atStation);
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
    root.current.userData.working = working;
    const visit = state.harborVisit;
    root.current.userData.harborStage = visit?.stage;
    const walkingLabel = !visit
      ? '散步'
      : visit.stage === 'watching'
        ? islandStops[visit.stop].name
        : visit.stage === 'outbound'
          ? visit.stop === 'coast'
            ? '走向潮池'
            : '走向花港'
          : '返回花园';
    const description =
      leisure.stage === 'approaching'
        ? `走向${facility!.name}`
        : leisure.stage === 'settling'
          ? facility?.activity === 'tend'
            ? '俯身察看'
            : '坐下休息'
          : leisure.stage === 'leaving'
            ? facility?.activity === 'tend'
              ? '收手'
              : '起身'
            : leisure.stage === 'enjoying'
              ? facility!.activity === 'tend'
                ? '照看幼苗'
                : facility!.activity === 'tea'
                  ? '喝茶'
                  : facility!.activity === 'swing'
                    ? '荡秋千'
                    : '小憩'
              : reduced
                ? '空闲'
                : walkingLabel;
    if (label.current !== description) {
      label.current = description;
      setLeisureLabel(description);
    }
  }, -1);
  return (
    <group
      ref={root}
      name={`avatar-${id}`}
      position={[home[0], characterHeight, home[1]]}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
    >
      <group ref={seatPivot}>
        <group ref={seatOffset}>
          <CharacterVisual profile={profile} motionRef={motion} reduced={reduced} accent={color} />
        </group>
      </group>
      <GroundShadow />
      {!preview && id !== 'user' && (
        <group ref={labelRoot} position={[0, 2.12, 0]}>
          <Label
            position={[0, 0, 0]}
            onClick={onClick}
            characterId={id}
            taskId={task?.id}
            title={dialogueAvailable ? `与${profile.displayName}对话` : undefined}
          >
            <b>{profile.displayName}</b>
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
  themeId,
  snapshot,
  onPanel,
  dailyNewsAvailable,
  onPartner,
  reduced,
  reset,
  fixed,
  focus,
  district,
  light,
  onVisitObservatory,
  characters,
  celebration,
}: {
  workspaceId: string;
  themeId?: IslandThemeId;
  snapshot?: ProjectSnapshot;
  onPanel: (panel: Panel) => void;
  dailyNewsAvailable?: boolean;
  onPartner: (partnerId: CharacterId) => void;
  reduced: boolean;
  reset: number;
  fixed: boolean;
  focus?: CharacterFocus;
  district?: StudioDistrict;
  light: IslandLight;
  onVisitObservatory?: () => void;
  characters?: CharacterProfile[];
  celebration?: number | null;
}) {
  const director = useRef(emptyDirector());
  const life = useMemo<LeisureWorld>(
    () => ({ states: new Map(), reservations: new Map() }),
    [workspaceId],
  );
  const roster = useMemo(() => {
    const profiles = new Map(DEFAULT_CHARACTERS.map((profile) => [profile.id, profile]));
    for (const profile of characters ?? []) profiles.set(profile.id, profile);
    const homes = getIslandCharacterHomes([...profiles.keys()]);
    return Array.from(profiles.values(), (profile, index) => ({
      profile,
      home: homes.get(profile.id)!,
      color:
        profile.id === 'mori'
          ? '#497a75'
          : profile.id === 'luma'
            ? '#818ba9'
            : profile.id === 'user'
              ? '#ceb8a1'
              : partnerAccents[(index - DEFAULT_CHARACTERS.length) % partnerAccents.length],
    }));
  }, [characters]);
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
  const preview = roster.find(({ profile }) => profile.id === focus);
  if (preview) {
    const { profile, home, color } = preview;
    const [x, z] = home;
    return (
      <>
        <color attach="background" args={['#e3edf1']} />
        <ambientLight intensity={0.75} />
        <hemisphereLight args={['#edf5ff', '#93a6b4', 1.5]} />
        <directionalLight position={[x - 3, 6, z + 4]} intensity={2.4} />
        <directionalLight position={[x + 4, 3, z + 1]} intensity={0.7} color="#d2e9ff" />
        <CameraRig reset={reset} fixed={fixed} focusHome={home} reduced={reduced} />
        <Avatar
          key={profile.id}
          profile={profile}
          life={life}
          home={home}
          color={color}
          reduced={reduced}
          preview
        />
        <mesh position={[x, -0.05, z]} receiveShadow>
          <cylinderGeometry args={[0.75, 0.79, 0.09, 64]} />
          <meshStandardMaterial color="#f3f2ec" roughness={0.86} />
        </mesh>
      </>
    );
  }
  const assignedTasks = new Map<string, Task>();
  for (const task of snapshot?.tasks ?? []) {
    if (task.agentId === 'user' || task.status === 'passed' || task.status === 'cancelled')
      continue;
    const assigned = assignedTasks.get(task.agentId);
    if (!assigned || (task.status === 'running' && assigned.status !== 'running'))
      assignedTasks.set(task.agentId, task);
  }
  const actors = roster.map((actor) => ({
    ...actor,
    id: actor.profile.id,
    task: assignedTasks.get(actor.profile.id),
  }));
  const placements = placeSceneActors(actors, intents);
  return (
    <>
      <CosmicBackdrop reduced={reduced} light={light} />
      <HarborHorizon />
      <OuterIslets reduced={reduced} />
      <CoastalIslet />
      <HarborQuarter snapshot={snapshot} onPanel={onPanel} />
      <IslandGlasshouse />
      <IslandSkyLighting light={light} />
      <CameraRig reset={reset} fixed={fixed} reduced={reduced} district={district} />
      <IslandLandscape
        workspaceId={workspaceId}
        themeId={themeId}
        reduced={reduced}
        observatoryLampStrength={light.dusk * 0.55 + light.night}
        onVisitObservatory={district === 'observatory' ? undefined : onVisitObservatory}
      />
      <IslandLeisure life={life} />
      {celebration != null && !reduced && <Confetti key={celebration} burst={celebration} />}
      <StudioDeck />
      <group position={[0, 0, -0.65]} scale={0.82}>
        <StarTable active={!!snapshot} onClick={() => onPanel('goal')} />
      </group>
      <Desk x={-3.6} onClick={() => onPanel('tasks')} />
      <Desk x={3.6} onClick={() => onPanel('tasks')} />
      <ToolStation
        position={[0, 0, -3.55]}
        labelPosition={[0, 2.6, 0]}
        label="对照架 · 检查记录"
        onActivate={() => onPanel('evidence')}
      >
        <Box position={[0, 1.5, 0]} scale={[2.2, 1.7, 0.13]} color={c.wood} />
        <AtlasSheets />
        {[-0.78, 0.78].map((x) => (
          <Cylinder key={x} position={[x, 0.6, 0]} radius={0.04} height={1.2} color={c.brass} />
        ))}
      </ToolStation>
      <group position={[-3.3, 0, -3.55]} rotation={[0, 0.37, 0]}>
        <Box position={[0, 1.23, -0.22]} scale={[2.1, 2.46, 0.09]} color="#656f63" />
        <Box position={[0, 0.23, 0.04]} scale={[2.18, 0.46, 0.67]} color="#9a856a" />
        <Box position={[0, 2.48, 0.04]} scale={[2.24, 0.105, 0.71]} color="#9f886a" />
        {[-1, 1].map((x) => (
          <Box key={x} position={[x, 1.25, 0.04]} scale={[0.09, 2.46, 0.63]} color="#a89374" />
        ))}
        {[0.5, 1.2, 1.9].map((y) => (
          <group key={y}>
            <Box position={[0, y, 0.1]} scale={[2.15, 0.08, 0.67]} color={c.wood} />
            <Books position={[-0.45, y + 0.04, 0.24]} />
            <Books position={[0.4, y + 0.04, 0.24]} />
          </group>
        ))}
      </group>
      <group position={[2.75, 0, -3.75]} rotation={[0, -0.25, 0]}>
        <Box position={[0, 0.28, 0]} scale={[2.32, 0.17, 0.85]} color="#9b8063" />
        <RoundedBox
          position={[0, 0.81, -0.34]}
          args={[2.32, 0.93, 0.32]}
          radius={0.14}
          smoothness={3}
        >
          <meshStandardMaterial color="#688b88" roughness={0.96} />
        </RoundedBox>
        {[-1, 1].map((side) => (
          <group key={side}>
            <RoundedBox
              args={[1.12, 0.28, 0.82]}
              position={[side * 0.565, 0.5, 0.04]}
              radius={0.1}
              smoothness={3}
            >
              <meshStandardMaterial color="#7c9c96" roughness={0.95} />
            </RoundedBox>
            <RoundedBox
              args={[0.5, 0.5, 0.2]}
              position={[side * 0.68, 0.83, -0.01]}
              rotation={[-0.17, 0, -side * 0.17]}
              radius={0.09}
              smoothness={3}
            >
              <meshStandardMaterial color={side < 0 ? '#c89b87' : '#b4c6ae'} roughness={0.96} />
            </RoundedBox>
          </group>
        ))}
      </group>
      <ToolStation
        position={[-4.2, 0, 2.7]}
        labelPosition={[-0.4, 0.85, 0.65]}
        label={`回信匣 · ${snapshot?.requests.some((r) => r.status === 'open') ? '需要你' : '输入与审批'}`}
        onActivate={() => onPanel('requests')}
      >
        <Cylinder radius={0.55} height={0.12} position={[0, 0.12, 0]} color={c.wood} />
        <Cylinder radius={0.04} height={0.95} position={[0, 0.6, 0]} color={c.brass} />
        <Box position={[0, 1.18, 0]} scale={[0.8, 0.67, 0.24]} color="#d3dfdc" />
        <Box position={[0, 1.22, 0.14]} scale={[0.49, 0.06, 0.03]} color={c.ink} />
      </ToolStation>
      {dailyNewsAvailable && (
        <ToolStation
          position={[-1.8, 0, 4.1]}
          rotation={[0, 0.12, 0]}
          labelPosition={[0, 1.35, 0.7]}
          label="日报邮箱"
          onActivate={() => onPanel('dailyNews')}
        >
          <group name="island-daily-news-postbox">
            <Cylinder radius={0.35} height={0.12} position={[0, 0.07, 0]} color="#a79173" />
            <Cylinder radius={0.085} height={0.81} position={[0, 0.47, 0]} color="#6c625a" />
            <RoundedBox position={[0, 1.05, 0]} args={[0.78, 0.57, 0.65]} radius={0.14}>
              <meshStandardMaterial color="#a85848" roughness={0.64} />
            </RoundedBox>
            <Box position={[0, 1.14, 0.327]} scale={[0.44, 0.085, 0.025]} color="#ddba77" />
            <Box position={[0, 1.14, 0.342]} scale={[0.37, 0.036, 0.022]} color="#443339" />
            <Box position={[0, 0.96, 0.325]} scale={[0.23, 0.075, 0.02]} color="#f1dfaf" />
          </group>
        </ToolStation>
      )}
      <ToolStation
        position={[4.2, 0, 2.7]}
        labelPosition={[0, 0.95, 0.9]}
        label={`交付港 · ${snapshot?.artifacts.length ? `${snapshot.artifacts.length} 项成果` : '等待成果'}`}
        onActivate={() => onPanel('artifacts')}
      >
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
      </ToolStation>
      {[
        [-5, 0, 2],
        [-5, 0, -2],
        [4.65, 0, -2.7],
        [1.2, 0, -4.7],
        [-1.7, 0, -4.7],
      ].map((p, i) => (
        <Plant key={i} position={p as V3} scale={i > 2 ? 0.8 : 1} />
      ))}
      <ReadingGallery />
      {actors.map(({ id, profile, home, color, task }) => (
        <Avatar
          key={id}
          life={life}
          profile={profile}
          home={home}
          color={color}
          task={task}
          {...placements.get(id)!}
          reduced={reduced}
          onClick={id === 'user' ? undefined : () => onPartner(id)}
          dialogueAvailable={id !== 'user' && snapshot?.agents.some((agent) => agent.id === id)}
        />
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
  lightMode?: IslandLightMode;
  onVisitObservatory?: () => void;
  themeId?: IslandThemeId;
  snapshot?: ProjectSnapshot;
  onPanel: (panel: Panel) => void;
  dailyNewsAvailable?: boolean;
  onPartner: (partnerId: CharacterId) => void;
  reduced: boolean;
  reset: number;
  fixed: boolean;
  focus?: CharacterFocus;
  district?: StudioDistrict;
  characters?: CharacterProfile[];
  quality?: SceneQuality;
  celebration?: number | null;
}) {
  const portal = useRef<HTMLDivElement>(null!);
  const active = useSceneActivity();
  const light = useIslandLight(props.lightMode ?? 'auto', active && !props.focus);
  const quality = props.quality ?? 'clear';
  const dpr = useScenePixelRatio(quality, portal);
  return (
    <SceneBoundary>
      <div
        className="studio-canvas"
        data-island-theme={islandAppearance(props.workspaceId, props.themeId).id}
        data-light-phase={props.focus ? undefined : light.phase}
        style={{ position: 'absolute', inset: 0 }}
      >
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
                <World key={props.workspaceId} {...props} light={light} />
              </Suspense>
            </LabelPortal.Provider>
          </SceneQualityContext.Provider>
        </Canvas>
      </div>
    </SceneBoundary>
  );
}
