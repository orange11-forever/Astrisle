import { expect, it } from 'vitest';
import * as THREE from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createProceduralGaitTemplate, poseProceduralGait } from './procedural-gait';

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
