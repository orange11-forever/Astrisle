import { expect, it } from 'vitest';
import * as THREE from 'three';
import { createBlueWhaleGirl } from './blue-whale-girl';
import { poseDefaultCharacter, type CharacterMotion } from './character-pose';

const idle: CharacterMotion = { walking: false, working: false, carrying: false, time: 0 };
it('seats the default character above the cushion and raises its tea hand, then restores its rest pose', () => {
  const model = createBlueWhaleGirl();
  const hand = model.joints.rightArm.getObjectByName('Right_hand')!;
  const before = hand.getWorldPosition(new THREE.Vector3());
  poseDefaultCharacter(
    model,
    { ...idle, leisure: { activity: 'tea', blend: 1, time: 2, seatHeight: 0.55 } },
    false,
  );
  const tea = hand.getWorldPosition(new THREE.Vector3());
  expect(tea.y - before.y).toBeGreaterThan(0.3);
  expect(tea.z - before.z).toBeGreaterThan(0.15);
  expect(model.root.position.y).toBeGreaterThan(0.25);
  poseDefaultCharacter(model, idle, false);
  expect(model.root.position.y).toBe(0);
  expect(model.joints.rightArm.rotation.z).toBe(0);
  expect(model.joints.leftLeg.position.z).toBe(0);
  expect(hand.getWorldPosition(new THREE.Vector3()).distanceTo(before)).toBeLessThan(0.02);
  model.dispose();
});

it('keeps the swing grip still with reduced motion and releases both arms for work', () => {
  const model = createBlueWhaleGirl();
  poseDefaultCharacter(
    model,
    { ...idle, leisure: { activity: 'swing', blend: 1, time: 3, seatHeight: 0.55 } },
    false,
  );
  expect(model.joints.leftArm.rotation.x).toBeLessThan(-0.5);
  expect(model.joints.rightArm.rotation.x).toBeLessThan(-0.5);
  poseDefaultCharacter(model, { ...idle, working: true }, true);
  expect(model.joints.leftArm.rotation.z).toBe(0);
  expect(model.joints.rightArm.rotation.z).toBe(0);
  expect(model.root.position.y).toBe(0);
  model.dispose();
});
