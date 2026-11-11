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
import { Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { Workspace } from '@astrisle/contracts';
import { islandAppearance, islandPosition } from './islands';
import { IslandTree, Pennant } from './IslandLandscape';

const LabelPortal = createContext<RefObject<HTMLElement> | undefined>(undefined);
function MiniIsland({
  workspace,
  index,
  count,
  selected,
  reduced,
  onSelect,
}: {
  workspace: Workspace;
  index: number;
  count: number;
  selected: boolean;
  reduced: boolean;
  onSelect: (id: string) => void;
}) {
  const palette = useMemo(() => islandAppearance(workspace.id), [workspace.id]);
  const portal = useContext(LabelPortal);
  const root = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (root.current)
      root.current.position.y =
        (index % 2 ? 0.35 : 0) + (reduced ? 0 : Math.sin(clock.elapsedTime * 0.34 + index) * 0.045);
  });
  return (
    <group
      ref={root}
      position={islandPosition(index, count)}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(workspace.id);
      }}
    >
      <mesh position={[0, -0.47, 0]} castShadow rotation={[0, palette.rotation, 0]}>
        <cylinderGeometry args={[2.6, 2.12, 0.8, 11]} />
        <meshStandardMaterial color={palette.stone} roughness={1} flatShading />
      </mesh>
      <mesh position={[0, -1.16, 0]} rotation={[Math.PI, 0, 0.04]}>
        <coneGeometry args={[2.14, 1.2, 9]} />
        <meshStandardMaterial color={palette.stone} flatShading />
      </mesh>
      <mesh position={[0, -0.01, 0]} receiveShadow castShadow>
        <cylinderGeometry args={[2.68, 2.6, 0.22, 64]} />
        <meshStandardMaterial color={palette.grass} roughness={1} />
      </mesh>
      <mesh position={[0.2, 0.14, 0.32]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.5, 64]} />
        <meshStandardMaterial color="#cbbda3" roughness={1} />
      </mesh>
      <mesh position={[0.15, 0.35, 0.15]}>
        <cylinderGeometry args={[0.88, 1, 0.4, 36]} />
        <meshStandardMaterial color="#b1babb" />
      </mesh>
      <mesh position={[0.15, 0.6, 0.15]}>
        <cylinderGeometry args={[1.03, 1.03, 0.12, 48]} />
        <meshStandardMaterial color="#e9e7d7" />
      </mesh>
      <mesh position={[0.15, 0.83, 0.15]} rotation={[0, 0, Math.PI / 4]}>
        <octahedronGeometry args={[0.2]} />
        <meshStandardMaterial color="#b69b5d" metalness={0.4} roughness={0.3} />
      </mesh>
      <mesh position={[0.15, 0.68, 0.15]} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.69, 0.018, 6, 48]} />
        <meshStandardMaterial color="#b49b65" />
      </mesh>
      <IslandTree position={[-1.4, 0.09, -0.9]} scale={0.48} palette={palette} />
      <IslandTree position={[1.15, 0.09, -1.35]} scale={0.38} palette={palette} />
      <group position={[0.45, 0.1, -1.2]}>
        <mesh position={[0, 0.45, 0]} castShadow>
          <boxGeometry args={[0.9, 0.8, 0.5]} />
          <meshStandardMaterial color="#d7ddd0" />
        </mesh>
        <mesh position={[0, 0.91, 0]} rotation={[0, Math.PI / 4, 0]} castShadow>
          <coneGeometry args={[0.79, 0.45, 4]} />
          <meshStandardMaterial color={palette.flag} />
        </mesh>
        <mesh position={[0, 0.5, 0.26]}>
          <boxGeometry args={[0.36, 0.35, 0.015]} />
          <meshStandardMaterial color="#779a9e" />
        </mesh>
      </group>
      <mesh position={[1.57, 0.13, 0.9]} scale={[0.59, 0.035, 0.39]}>
        <sphereGeometry args={[1, 24, 8]} />
        <meshStandardMaterial color={palette.water} roughness={0.2} metalness={0.2} />
      </mesh>
      <Pennant position={[-1.75, 0.08, 0.7]} palette={palette} reduced={reduced} />
      {Array.from({ length: 9 }, (_, i) => {
        const a = i * 2.4;
        return (
          <mesh
            key={i}
            position={[Math.cos(a) * 2.25, 0.2, Math.sin(a) * 2.25]}
            scale={[0.15, 0.13, 0.15]}
          >
            <icosahedronGeometry args={[1, 0]} />
            <meshStandardMaterial color={i % 3 ? palette.lightLeaf : palette.flower} />
          </mesh>
        );
      })}
      <mesh position={[0, -0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[2.86, selected ? 0.045 : 0.012, 6, 90]} />
        <meshBasicMaterial
          color={selected ? '#9c7c3d' : '#b6cac9'}
          transparent
          opacity={selected ? 1 : 0.45}
        />
      </mesh>
      <Html
        portal={portal}
        position={[0, -1.55, 1.55]}
        center
        distanceFactor={22}
        zIndexRange={[4, 0]}
      >
        <button
          className={`island-label ${selected ? 'selected' : ''}`}
          aria-label={`选择岛屿 ${workspace.name}`}
          aria-pressed={selected}
          onClick={() => onSelect(workspace.id)}
        >
          <b>{workspace.name}</b>
          <small>
            {palette.name}
            {selected ? ' · 已选中' : ''}
          </small>
        </button>
      </Html>
    </group>
  );
}
class OverviewBoundary extends Component<
  { children: ReactNode; workspaces: Workspace[]; onSelect: (id: string) => void },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="island-access-list">
        <p>3D 总览暂时不可用，可以直接选择岛屿。</p>
        {this.props.workspaces.map((w) => (
          <button key={w.id} onClick={() => this.props.onSelect(w.id)}>
            {w.name}
          </button>
        ))}
      </div>
    ) : (
      this.props.children
    );
  }
}
export function Archipelago({
  workspaces,
  selectedId,
  onSelect,
  reduced,
}: {
  workspaces: Workspace[];
  selectedId: string;
  onSelect: (id: string) => void;
  reduced: boolean;
}) {
  const portal = useRef<HTMLDivElement>(null!);
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const rows = Math.ceil(workspaces.length / 3);
  const distance = Math.max(17, rows * 4.6 + 9);
  return (
    <OverviewBoundary workspaces={workspaces} onSelect={onSelect}>
      <div className="archipelago-canvas" aria-label="持久项目的 3D 群岛总览">
        <div
          ref={portal}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2 }}
        />
        <Canvas
          shadows
          dpr={[1, 1.6]}
          frameloop={visible ? 'always' : 'never'}
          camera={{ position: [distance * 0.4, distance * 0.75, distance], fov: 41 }}
        >
          <LabelPortal.Provider value={portal}>
            <Suspense fallback={null}>
              <color attach="background" args={['#dce7ed']} />
              <ambientLight intensity={1.4} />
              <hemisphereLight args={['#ecf2ff', '#829a8c', 1.8]} />
              <directionalLight
                position={[-8, 14, 8]}
                intensity={2.4}
                castShadow
                shadow-mapSize={[1024, 1024]}
                shadow-camera-left={-15}
                shadow-camera-right={15}
                shadow-camera-top={15}
                shadow-camera-bottom={-15}
              />
              <OrbitControls
                makeDefault
                enablePan
                enableRotate
                minDistance={12}
                maxDistance={70}
                minPolarAngle={0.35}
                maxPolarAngle={1.25}
              />
              {workspaces.map((w, i) => (
                <MiniIsland
                  key={w.id}
                  workspace={w}
                  index={i}
                  count={workspaces.length}
                  selected={w.id === selectedId}
                  reduced={reduced}
                  onSelect={onSelect}
                />
              ))}
              <mesh position={[0, -2.6, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[200, 200]} />
                <meshStandardMaterial color="#d5e2e6" roughness={1} />
              </mesh>
            </Suspense>
          </LabelPortal.Provider>
        </Canvas>
      </div>
    </OverviewBoundary>
  );
}
