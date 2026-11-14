import { expect, it } from 'vitest';
import * as THREE from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  createProceduralGaitTemplate,
  poseProceduralGait,
  sampleGaitHand,
} from './procedural-gait';

function figure(skirt = false) {
  const parts: THREE.BufferGeometry[] = [
    new THREE.BoxGeometry(0.48, 0.55, 0.27).translate(0, 0.88, 0),
    new THREE.SphereGeometry(0.37, 12, 8).translate(0, 1.48, 0),
    ...[-1, 1].flatMap((side) => [
      new THREE.BoxGeometry(0.16, 0.53, 0.18).translate(side * 0.16, 0.31, 0),
      new THREE.BoxGeometry(0.18, 0.09, 0.28).translate(side * 0.16, 0.045, 0.05),
      new THREE.BoxGeometry(0.13, 0.38, 0.15).translate(side * 0.32, 0.83, 0),
    ]),
  ];
  if (skirt)
    parts.push(new THREE.CylinderGeometry(0.22, 0.47, 0.55, 24, 4, true).translate(0, 0.355, 0));
  const geometry = mergeGeometries(parts)!;
  parts.forEach((part) => part.dispose());
  const root = new THREE.Group();
  root.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
  return root;
}
it('binds a suitable static figure without changing its rest geometry, UVs or source', () => {
  const source = figure(),
    original = source.children[0] as THREE.Mesh;
  const positions = [...original.geometry.attributes.position.array];
  const rig = createProceduralGaitTemplate(source, 0)!;
  expect(rig).not.toBeNull();
  rig.updateMatrixWorld(true);
  const mesh = rig.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
  expect(mesh).toBeDefined();
  for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
    const point = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, i);
    expect(mesh.applyBoneTransform(i, point.clone()).distanceTo(point)).toBeLessThan(1e-5);
    const weights = mesh.geometry.attributes.skinWeight;
    expect(weights.getX(i) + weights.getY(i) + weights.getZ(i) + weights.getW(i)).toBeCloseTo(1);
  }
  expect([...original.geometry.attributes.position.array]).toEqual(positions);
  expect([...mesh.geometry.attributes.uv.array]).toEqual([
    ...original.geometry.attributes.uv.array,
  ]);
});
it('moves actual foot vertices with a gait while preserving a stable head and independent clones', () => {
  const template = createProceduralGaitTemplate(figure(), 0)!;
  const a = clone(template),
    b = clone(template);
  const mesh = a.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
  const position = mesh.geometry.attributes.position;
  const foot = Array.from({ length: position.count }, (_, i) => i).find(
    (i) => position.getY(i) < 0.05 && position.getX(i) > 0.1,
  )!;
  const head = Array.from({ length: position.count }, (_, i) => i).find(
    (i) => position.getY(i) > 1.7,
  )!;
  const point = (i: number) =>
    mesh.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(position, i));
  a.updateMatrixWorld(true);
  const originalFoot = point(foot),
    originalHead = point(head);
  poseProceduralGait(a, { phase: Math.PI / 2, strength: 1, time: 1, working: false });
  a.updateMatrixWorld(true);
  expect(point(foot).distanceTo(originalFoot)).toBeGreaterThan(0.02);
  expect(point(head).distanceTo(originalHead)).toBeLessThan(0.09);
  expect(b.getObjectByName('gait-left-thigh')!.rotation.x).toBeCloseTo(0);
  expect((b.getObjectByProperty('isSkinnedMesh', true) as THREE.Mesh).geometry).toBe(mesh.geometry);
});
it('uses the selected facing direction when inferring left and right legs', () => {
  const source = figure();
  source.rotation.y = Math.PI / 2;
  const rig = createProceduralGaitTemplate(source, 270)!;
  expect(rig).not.toBeNull();
  expect(rig.getObjectByName('gait-left-thigh')!.position.x).toBeLessThan(0);
  expect(rig.getObjectByName('gait-right-thigh')!.position.x).toBeGreaterThan(0);
});
it('plants the stance foot while lifting the swing foot with a forward-bending knee', () => {
  const rig = createProceduralGaitTemplate(figure(), 0)!;
  poseProceduralGait(rig, { phase: Math.PI / 2, strength: 1, time: 0, working: false });
  rig.updateMatrixWorld(true);
  const mesh = rig.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh,
    positions = mesh.geometry.attributes.position;
  const low = [Infinity, Infinity];
  for (let i = 0; i < positions.count; i++)
    if (positions.getY(i) < 0.06) {
      const point = mesh.applyBoneTransform(
        i,
        new THREE.Vector3().fromBufferAttribute(positions, i),
      );
      const side = positions.getX(i) < 0 ? 0 : 1;
      low[side] = Math.min(low[side], point.y);
    }
  expect(low[0]).toBeCloseTo(0, 2);
  expect(low[1]).toBeGreaterThan(0.04);
  expect(rig.getObjectByName('gait-right-knee')!.rotation.x).toBeGreaterThan(0);
});
it('keeps a continuous long skirt with the body instead of splitting it between the legs', () => {
  const rig = createProceduralGaitTemplate(figure(true), 0)!;
  poseProceduralGait(rig, { phase: Math.PI / 2, strength: 1, time: 0, working: false });
  rig.updateMatrixWorld(true);
  const mesh = rig.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh,
    position = mesh.geometry.attributes.position;
  let inspected = 0;
  for (let i = 0; i < position.count; i++)
    if (position.getY(i) < 0.3 && Math.abs(position.getX(i)) > 0.35) {
      const original = new THREE.Vector3().fromBufferAttribute(position, i),
        moved = mesh.applyBoneTransform(i, original.clone());
      expect(Math.hypot(moved.x - original.x, moved.z - original.z)).toBeLessThan(0.02);
      inspected++;
    }
  expect(inspected).toBeGreaterThan(10);
});
it('leaves non-humanoid static geometry unchanged rather than inventing a skeleton', () => {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 2), new THREE.MeshBasicMaterial()));
  expect(createProceduralGaitTemplate(root, 0)).toBeNull();
  expect(root.children[0]).toBeInstanceOf(THREE.Mesh);
  expect((root.children[0] as THREE.Mesh).geometry.attributes.skinWeight).toBeUndefined();
});

it('bends both knees to sit, raises the tea arm, and restores the imported rig before walking', () => {
  const rig = createProceduralGaitTemplate(figure(), 0)!;
  const restHip = rig.getObjectByName('gait-hips')!.position.y;
  poseProceduralGait(rig, {
    phase: 0,
    strength: 0,
    time: 2,
    working: false,
    leisure: { activity: 'tea', blend: 1, time: 2, seatHeight: 0.55 },
  });
  expect(rig.getObjectByName('gait-left-thigh')!.rotation.x).toBeLessThan(-1);
  expect(rig.getObjectByName('gait-right-knee')!.rotation.x).toBeGreaterThan(1);
  expect(rig.getObjectByName('gait-right-arm')!.rotation.x).toBeLessThan(-0.4);
  poseProceduralGait(rig, { phase: 0, strength: 0, time: 0, working: false });
  expect(rig.getObjectByName('gait-hips')!.position.y).toBe(restHip);
  expect(rig.getObjectByName('gait-left-thigh')!.rotation.x).toBeCloseTo(0);
  expect(rig.getObjectByName('gait-right-knee')!.rotation.x).toBe(0);
  expect(rig.getObjectByName('gait-right-arm')!.rotation.z).toBe(0);
});

it('keeps the seated long garment above the cushion instead of passing a seat through the dress', () => {
  const rig = createProceduralGaitTemplate(figure(true), 0)!;
  poseProceduralGait(rig, {
    phase: 0,
    strength: 0,
    time: 0,
    working: false,
    leisure: { activity: 'sit', blend: 1, time: 0, seatHeight: 0.55 },
  });
  rig.updateMatrixWorld(true);
  const mesh = rig.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
  const p = mesh.geometry.attributes.position;
  let points = 0;
  for (let i = 0; i < p.count; i++) {
    if (
      p.getY(i) < 0.6 &&
      p.getY(i) > 0.07 &&
      Math.abs(p.getX(i)) > 0.25 &&
      Math.abs(p.getX(i)) < 0.42 &&
      Math.abs(p.getZ(i)) < 0.26
    ) {
      const moved = mesh.getVertexPosition(i, new THREE.Vector3());
      expect(moved.y).toBeGreaterThanOrEqual(0.545);
      points++;
    }
  }
  expect(points).toBeGreaterThan(10);
});

it('samples the actual deformed lower hand for prop contact throughout a sip, including rotated models', () => {
  for (const rotation of [0, 270]) {
    const source = figure();
    source.rotation.y = rotation === 270 ? Math.PI / 2 : 0;
    const rig = createProceduralGaitTemplate(source, rotation)!;
    const mesh = rig.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh;
    const p = mesh.geometry.attributes.position;
    for (const time of [0, Math.PI / 1.6, 4]) {
      poseProceduralGait(rig, {
        phase: 0,
        strength: 0,
        time,
        working: false,
        leisure: { activity: 'tea', blend: 1, time, seatHeight: 0.55 },
      });
      const hand = new THREE.Vector3();
      expect(sampleGaitHand(rig, hand)).toBe(true);
      let nearest = Infinity;
      for (let i = 0; i < p.count; i++)
        if (p.getX(i) > 0.25 && p.getY(i) >= 0.6 && p.getY(i) < 0.7) {
          nearest = Math.min(
            nearest,
            mesh.getVertexPosition(i, new THREE.Vector3()).distanceTo(hand),
          );
        }
      expect(nearest).toBeLessThan(1e-4);
    }
  }
});

it('uses visible lower hand landmarks for a short-bodied figure instead of raising a point in its hair', () => {
  const source = figure(true);
  for (const side of [-1, 1]) {
    const hand = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 12, 8),
      new THREE.MeshStandardMaterial({ color: '#f4cbb2' }),
    );
    hand.position.set(side * 0.34, 0.42, 0.15);
    source.add(hand);
  }
  const rig = createProceduralGaitTemplate(source, 0)!;
  const before = new THREE.Vector3(),
    after = new THREE.Vector3();
  expect(sampleGaitHand(rig, before)).toBe(true);
  expect(before.y).toBeLessThan(0.48);
  poseProceduralGait(rig, {
    phase: 0,
    strength: 0,
    time: 2,
    working: false,
    leisure: { activity: 'tea', blend: 1, time: 2, seatHeight: 0.55 },
  });
  expect(sampleGaitHand(rig, after)).toBe(true);
  const lift = rig.getObjectByName('gait-hips')!.position.y - Number(rig.userData.gaitRestHipY);
  expect(after.y - before.y - lift).toBeGreaterThan(0.06);
});
