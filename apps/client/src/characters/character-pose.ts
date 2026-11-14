import type { LeisureActivity } from '../island-facilities';
import type { BlueWhaleGirl } from './blue-whale-girl';
import { MathUtils } from 'three';

export interface LeisurePose {
  activity: LeisureActivity;
  blend: number;
  time: number;
  seatHeight: number;
}
export interface CharacterMotion {
  walking: boolean;
  working: boolean;
  carrying: boolean;
  time: number;
  phase?: number;
  strength?: number;
  leisure?: LeisurePose;
  leisureCapable?: boolean;
}
export const teaSip = (time: number) => Math.max(0, Math.sin(time * 0.8)) ** 2;

export function poseDefaultCharacter(
  model: BlueWhaleGirl,
  state: CharacterMotion,
  reduced: boolean,
) {
  const { walking, working, carrying, time: t, phase = t * 7, strength = walking ? 1 : 0 } = state;
  const movement = reduced ? 0 : 1;
  const joints = model.joints;
  const leisure = reduced ? undefined : state.leisure;
  const weight = leisure?.blend ?? 0;
  model.root.position.y =
    (Math.sin(t * 1.7) * 0.007 + Math.abs(Math.sin(phase)) * 0.014 * strength) *
    movement *
    (1 - weight);
  joints.head.rotation.set(0, 0, Math.sin(t * 0.7) * 0.035 * movement);
  joints.hair.rotation.z = Math.sin(t * 0.9 + 0.8) * 0.018 * movement;
  const stride = Math.sin(phase) * 0.3 * strength * movement;
  joints.leftLeg.rotation.x = stride;
  joints.rightLeg.rotation.x = -stride;
  joints.leftLeg.position.z = joints.rightLeg.position.z = 0;
  joints.leftArm.rotation.z = joints.rightArm.rotation.z = 0;
  joints.leftArm.rotation.x = walking
    ? -stride
    : working
      ? -0.65 + Math.sin(t * 5) * 0.07 * movement
      : carrying
        ? -0.65
        : Math.sin(t * 0.9) * 0.05 * movement;
  joints.rightArm.rotation.x = walking
    ? stride
    : working
      ? -0.65 + Math.cos(t * 5) * 0.07 * movement
      : carrying
        ? -0.6
        : Math.sin(t * 0.9 + 1) * 0.05 * movement;
  if (!leisure || weight <= 0) return;
  // This chibi's knees are hidden by its short skirt: the stocking pivots hang from the seat.
  model.root.position.y += (leisure.seatHeight - 0.21) * weight;
  const kick = leisure.activity === 'swing' ? Math.sin(leisure.time * 1.65) * 0.15 : 0;
  joints.leftLeg.rotation.x = MathUtils.lerp(joints.leftLeg.rotation.x, -0.32 + kick, weight);
  joints.rightLeg.rotation.x = MathUtils.lerp(joints.rightLeg.rotation.x, -0.27 + kick, weight);
  joints.leftLeg.position.z = joints.rightLeg.position.z = 0.08 * weight;
  const sip = leisure.activity === 'tea' ? teaSip(leisure.time) : 0;
  const grip = leisure.activity === 'swing';
  joints.leftArm.rotation.x = MathUtils.lerp(
    joints.leftArm.rotation.x,
    grip ? -0.95 : -0.45,
    weight,
  );
  joints.rightArm.rotation.x = MathUtils.lerp(
    joints.rightArm.rotation.x,
    grip ? -0.95 : leisure.activity === 'tea' ? -1.1 - sip * 0.85 : -0.45,
    weight,
  );
  joints.leftArm.rotation.z = grip ? 0.45 * weight : 0;
  joints.rightArm.rotation.z = grip
    ? -0.45 * weight
    : leisure.activity === 'tea'
      ? -0.12 * weight
      : 0;
  joints.head.rotation.x = sip * 0.06 * weight;
}
