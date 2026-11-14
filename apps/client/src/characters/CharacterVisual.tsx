import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { CharacterProfile } from '@astrisle/contracts';
import { createBlueWhaleGirl } from './blue-whale-girl';
import { characterModelCache, disposeCharacterClone } from './model-cache';
import { configureModelTextureSampling, useSceneQuality } from '../render-quality';
import { poseProceduralGait } from './procedural-gait';

export interface CharacterMotion {
  walking: boolean;
  working: boolean;
  carrying: boolean;
  time: number;
  phase?: number;
  strength?: number;
}
type Props = {
  profile: CharacterProfile;
  motionRef: RefObject<CharacterMotion>;
  reduced: boolean;
  accent?: string;
};

export function CharacterVisual(props: Props) {
  return props.profile.model ? (
    <ImportedCharacter
      key={`${props.profile.model.assetId}:${props.profile.modelRevision ?? 0}`}
      {...props}
    />
  ) : (
    <DefaultCharacter {...props} />
  );
}

function DefaultCharacter({ profile, motionRef, reduced, accent }: Props) {
  const color =
    accent || (profile.id === 'mori' ? '#497a75' : profile.id === 'luma' ? '#818ba9' : '#ceb8a1');
  const model = useMemo(() => createBlueWhaleGirl({ accent: color }), [color]);
  const retirement = useRef<
    { model: typeof model; timer: ReturnType<typeof setTimeout> } | undefined
  >(undefined);
  const parcel = useMemo(() => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.035, 0.25),
      new THREE.MeshStandardMaterial({ color: '#e7eef0', roughness: 0.8 }),
    );
    mesh.name = 'handoff-parcel';
    mesh.position.set(0, -0.29, 0.13);
    mesh.visible = false;
    return mesh;
  }, [model]);
  useEffect(() => {
    if (retirement.current?.model === model) {
      clearTimeout(retirement.current.timer);
      retirement.current = undefined;
    }
    model.joints.rightArm.add(parcel);
    return () => {
      model.joints.rightArm.remove(parcel);
      const timer = setTimeout(() => {
        model.dispose();
        parcel.geometry.dispose();
        parcel.material.dispose();
        if (retirement.current?.timer === timer) retirement.current = undefined;
      }, 0);
      retirement.current = { model, timer };
    };
  }, [model, parcel]);
  useFrame(() => {
    const {
      walking,
      working,
      carrying,
      time: t,
      phase = t * 7,
      strength = walking ? 1 : 0,
    } = motionRef.current;
    const motion = reduced ? 0 : 1;
    const joints = model.joints;
    model.root.position.y =
      (Math.sin(t * 1.7) * 0.007 + Math.abs(Math.sin(phase)) * 0.014 * strength) * motion;
    joints.head.rotation.z = Math.sin(t * 0.7) * 0.035 * motion;
    joints.hair.rotation.z = Math.sin(t * 0.9 + 0.8) * 0.018 * motion;
    const swing = !reduced ? Math.sin(phase) * 0.3 * strength : 0;
    joints.leftLeg.rotation.x = swing;
    joints.rightLeg.rotation.x = -swing;
    joints.leftArm.rotation.x = walking
      ? -swing
      : working
        ? -0.65 + Math.sin(t * 5) * 0.07 * motion
        : carrying
          ? -0.65
          : Math.sin(t * 0.9) * 0.05 * motion;
    joints.rightArm.rotation.x = walking
      ? swing
      : working
        ? -0.65 + Math.cos(t * 5) * 0.07 * motion
        : carrying
          ? -0.6
          : Math.sin(t * 0.9 + 1) * 0.05 * motion;
    parcel.visible = carrying;
  });
  return <primitive object={model.root} dispose={null} />;
}

function ImportedCharacter({ profile, motionRef, reduced }: Props) {
  const assetId = profile.model!.assetId;
  const quality = useSceneQuality();
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const [loaded, setLoaded] = useState<{ root: THREE.Group; clips: THREE.AnimationClip[] }>();
  const [error, setError] = useState('');
  const mixer = useRef<THREE.AnimationMixer | undefined>(undefined);
  const active = useRef<THREE.AnimationAction | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    let instance: THREE.Group | undefined;
    const lease = characterModelCache.acquire(assetId);
    lease.ready
      .then((asset) => {
        if (!alive) return;
        instance = asset.instantiate({ procedural: true, rotationY: profile.rotationY ?? 0 });
        mixer.current = asset.animations.length ? new THREE.AnimationMixer(instance) : undefined;
        setLoaded({ root: instance, clips: asset.animations });
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : '模型加载失败');
      });
    return () => {
      alive = false;
      mixer.current?.stopAllAction();
      if (instance) {
        mixer.current?.uncacheRoot(instance);
        disposeCharacterClone(instance);
      }
      mixer.current = undefined;
      active.current = undefined;
      lease.release();
    };
  }, [assetId, profile.rotationY]);
  useLayoutEffect(() => {
    if (
      loaded &&
      configureModelTextureSampling(loaded.root, quality, gl.capabilities.getMaxAnisotropy())
    )
      invalidate();
  }, [loaded, quality, gl, invalidate]);
  useFrame((_state, delta) => {
    if (!loaded) return;
    if (loaded.root.userData.proceduralGait) {
      const { phase = 0, strength = 0, time, working } = motionRef.current;
      poseProceduralGait(loaded.root, {
        phase,
        strength: reduced ? 0 : strength,
        time: reduced ? 0 : time,
        working: !reduced && working,
      });
      return;
    }
    if (!mixer.current) return;
    if (reduced) {
      if (active.current) {
        mixer.current.stopAllAction();
        active.current = undefined;
      }
      return;
    }
    const { walking, working } = motionRef.current;
    const pattern = walking ? /walk|run|走|跑/i : working ? /work|act|工作/i : /idle|stand|待机/i;
    const clip = loaded.clips.find((item) => pattern.test(item.name)) || loaded.clips[0];
    const next = mixer.current.clipAction(clip);
    if (active.current !== next) {
      active.current?.fadeOut(0.2);
      next.reset().fadeIn(0.2).play();
      active.current = next;
    }
    mixer.current.update(Math.min(delta, 0.05));
  });
  if (!loaded)
    return (
      <group>
        <mesh position={[0, 0.9, 0]}>
          <capsuleGeometry args={[0.25, 1.1, 4, 8]} />
          <meshStandardMaterial
            color={error ? '#ad7585' : '#899eaf'}
            wireframe
            transparent
            opacity={0.7}
          />
        </mesh>
        <Html position={[0, 1.95, 0]} center zIndexRange={[4, 0]}>
          <span className="scene-label" role="status" title={error || undefined}>
            {error ? `角色加载失败：${error}` : `${profile.displayName} · 模型加载中`}
          </span>
        </Html>
      </group>
    );
  return (
    <group rotation={[0, ((profile.rotationY ?? 0) * Math.PI) / 180, 0]}>
      <primitive object={loaded.root} dispose={null} />
      <mesh position={[0, 0.925, 0]}>
        <boxGeometry args={[1.1, 1.85, 0.8]} />
        <meshBasicMaterial visible={false} />
      </mesh>
    </group>
  );
}
