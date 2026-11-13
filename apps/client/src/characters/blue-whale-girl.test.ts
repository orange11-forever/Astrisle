import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createBlueWhaleGirl } from './blue-whale-girl';

describe('the whale-girl scene asset', () => {
  it('supplies finite renderable geometry at ground level within the three-character scene budget', () => {
    const character = createBlueWhaleGirl();
    const box = new THREE.Box3().setFromObject(character.root);
    expect(box.min.y).toBeGreaterThanOrEqual(-0.002);
    expect(box.min.y).toBeLessThan(0.02);
    expect(box.max.y).toBeGreaterThan(1.65);
    expect(box.max.y).toBeLessThan(1.95);
    let meshes = 0;
    let triangles = 0;
    character.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      meshes++;
      const position = object.geometry.getAttribute('position');
      const normal = object.geometry.getAttribute('normal');
      expect(Array.from(position.array).every(Number.isFinite), object.name).toBe(true);
      expect(Array.from(normal.array).every(Number.isFinite), object.name).toBe(true);
      expect(
        object.geometry.index?.array.every((index: number) => index < position.count) ?? true,
      ).toBe(true);
      triangles += (object.geometry.index?.count ?? position.count) / 3;
    });
    expect(meshes).toBeGreaterThan(15);
    // Deliberate contour shells and sampled cloth/hair surfaces buy a closer
    // anime silhouette while remaining small for three simultaneous avatars.
    expect(meshes).toBeLessThan(100);
    expect(triangles).toBeGreaterThan(5000);
    expect(triangles).toBeLessThan(65000);
    character.dispose();
  });

  it('uses the wide low-chin chibi proportions instead of the rejected long-bodied doll', () => {
    const character = createBlueWhaleGirl();
    const face = character.root.getObjectByName('Round_cheeks_and_face')!;
    const faceBounds = new THREE.Box3().setFromObject(face);
    const faceSize = faceBounds.getSize(new THREE.Vector3());
    expect(faceSize.x).toBeGreaterThan(0.87);
    expect(faceSize.y).toBeGreaterThan(0.67);
    expect(faceBounds.min.y).toBeGreaterThan(0.85);
    expect(faceBounds.min.y).toBeLessThan(1.02);
    expect(character.root.getObjectByName('Tiny_nose')).toBeUndefined();
    character.dispose();
  });

  it('lets the scene animate the head, hair, tail and limbs around attached independent pivots', () => {
    const character = createBlueWhaleGirl();
    const { root, joints } = character;
    expect(Object.keys(joints).sort()).toEqual([
      'hair',
      'head',
      'leftArm',
      'leftLeg',
      'rightArm',
      'rightLeg',
      'tail',
    ]);
    for (const joint of Object.values(joints)) {
      expect(root.getObjectById(joint.id)).toBe(joint);
      if (joint !== joints.tail) expect(joint.children.length).toBeGreaterThan(0);
    }
    const hand = joints.leftArm.getObjectByName('Left_hand');
    expect(hand).toBeDefined();
    const before = hand!.getWorldPosition(new THREE.Vector3());
    joints.leftArm.rotation.z = 0.5;
    root.updateMatrixWorld(true);
    expect(hand!.getWorldPosition(new THREE.Vector3()).distanceTo(before)).toBeGreaterThan(0.07);
    expect(joints.rightArm.rotation.z).toBe(0);
    expect(joints.hair.parent).toBe(joints.head);
    expect(joints.tail.children).toHaveLength(0);
    character.dispose();
  });

  it('covers the scalp at bang roots and turned temples while leaving the lower face visible', () => {
    const character = createBlueWhaleGirl();
    const ray = new THREE.Raycaster();
    const firstSurface = (origin: THREE.Vector3, target: THREE.Vector3) => {
      ray.set(origin, target.clone().sub(origin).normalize());
      return ray.intersectObject(character.joints.head, true).find(({ object }) => {
        if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return false;
        return /anime skin|periwinkle hair/.test(object.material.name);
      })?.object.name;
    };
    for (const x of [-0.16, 0.15]) {
      const visible = firstSurface(new THREE.Vector3(x, 1.45, 2), new THREE.Vector3(x, 1.45, 0.27));
      expect(visible).toBeDefined();
      expect(visible).not.toBe('Round_cheeks_and_face');
    }
    for (const side of [-1, 1]) {
      const visible = firstSurface(
        new THREE.Vector3(side * 1.68, 1.27, 2),
        new THREE.Vector3(side * 0.43, 1.27, 0.24),
      );
      expect(visible).toBeDefined();
      expect(visible).not.toBe('Round_cheeks_and_face');
    }
    expect(firstSurface(new THREE.Vector3(0, 1.0, 2), new THREE.Vector3(0, 1.0, 0.27))).toBe(
      'Round_cheeks_and_face',
    );
    character.dispose();
  });

  it('keeps the apron and its whale emblem in front of the curved dress between surface vertices', () => {
    const character = createBlueWhaleGirl();
    character.root.updateMatrixWorld(true);
    const apron = character.root.getObjectByName('White_whale_apron')!;
    const skirt = character.root.getObjectByName('Twelve_pleat_bell_skirt')!;
    const bodice = character.root.getObjectByName('Dress_bodice')!;
    const emblem = character.root.getObjectByName('Blue_whale_apron_emblem')!;
    const ray = new THREE.Raycaster();
    for (const x of [-0.11, -0.055, 0, 0.055, 0.11]) {
      for (const y of [0.34, 0.39, 0.44, 0.49, 0.54, 0.59]) {
        ray.set(new THREE.Vector3(x, y, 1), new THREE.Vector3(0, 0, -1));
        const apronHit = ray.intersectObject(apron, false)[0];
        const clothingHit = ray.intersectObjects([skirt, bodice], false)[0];
        expect(apronHit, `missing apron at ${x}, ${y}`).toBeDefined();
        expect(
          clothingHit.distance - apronHit.distance,
          `apron clearance at ${x}, ${y}`,
        ).toBeGreaterThan(0.006);
      }
    }
    for (const [x, y] of [
      [-0.025, 0.42],
      [0, 0.393],
    ]) {
      ray.set(new THREE.Vector3(x, y, 1), new THREE.Vector3(0, 0, -1));
      expect(ray.intersectObjects([emblem, apron], false)[0].object).toBe(emblem);
    }
    character.dispose();
  });

  it('owns its GPU resources so disposing one of three characters leaves the others intact', () => {
    const first = createBlueWhaleGirl();
    const second = createBlueWhaleGirl({ accent: '#92dcf6' });
    const third = createBlueWhaleGirl({ accent: '#c8a56c' });
    let firstDisposed = 0;
    let secondDisposed = 0;
    let thirdDisposed = 0;
    const firstGeometry = first.root.getObjectByProperty('isMesh', true) as THREE.Mesh;
    const secondGeometry = second.root.getObjectByProperty('isMesh', true) as THREE.Mesh;
    const thirdGeometry = third.root.getObjectByProperty('isMesh', true) as THREE.Mesh;
    expect(firstGeometry.geometry).not.toBe(secondGeometry.geometry);
    expect(secondGeometry.material).not.toBe(thirdGeometry.material);
    firstGeometry.geometry.addEventListener('dispose', () => firstDisposed++);
    secondGeometry.geometry.addEventListener('dispose', () => secondDisposed++);
    thirdGeometry.geometry.addEventListener('dispose', () => thirdDisposed++);
    first.dispose();
    expect(firstDisposed).toBe(1);
    expect(secondDisposed).toBe(0);
    expect(thirdDisposed).toBe(0);
    first.dispose();
    expect(firstDisposed).toBe(1);
    second.dispose();
    expect(secondDisposed).toBe(1);
    expect(thirdDisposed).toBe(0);
    third.dispose();
    expect(thirdDisposed).toBe(1);
  });
});
