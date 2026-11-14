import * as THREE from 'three';
import { teaSip, type LeisurePose } from './character-pose';
import { inferHandLandmarks } from './hand-landmarks';

const smooth = (a: number, b: number, value: number) => THREE.MathUtils.smoothstep(value, a, b);
const rigs = new WeakMap<THREE.Object3D, Record<string, THREE.Bone>>();

const handSamples = new WeakMap<
  THREE.Object3D,
  { mesh: THREE.SkinnedMesh; vertex: number } | null
>();
/** Samples the rendered hand, including its blended weights, in the normalized body's space. */
export function sampleGaitHand(root: THREE.Object3D, target: THREE.Vector3): boolean {
  let sample = handSamples.get(root);
  if (sample === undefined) {
    sample = null;
    root.traverse((object) => {
      if (
        object instanceof THREE.SkinnedMesh &&
        Number.isInteger(object.userData.gaitRightHandVertex)
      )
        sample = { mesh: object, vertex: object.userData.gaitRightHandVertex };
    });
    handSamples.set(root, sample);
  }
  if (!sample) return false;
  root.updateWorldMatrix(true, true);
  const { mesh, vertex } = sample;
  mesh.getVertexPosition(vertex, target);
  mesh.localToWorld(target);
  root.getObjectByName('Imported_character_normalized')!.worldToLocal(target);
  return true;
}

/** Conservative display-only skinning for upright, two-footed static figures. */
export function createProceduralGaitTemplate(
  source: THREE.Group,
  rotationY: number,
): THREE.Group | null {
  source.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  let unsupported = false;
  source.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh) unsupported = true;
    if (object instanceof THREE.Mesh) {
      if (object.geometry.morphAttributes.position?.length) unsupported = true;
      meshes.push(object);
    }
  });
  if (unsupported || !meshes.length) return null;
  const facing = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(rotationY));
  const bounds = new THREE.Box3(),
    point = new THREE.Vector3();
  const transforms = meshes.map((mesh) =>
    new THREE.Matrix4().multiplyMatrices(facing, mesh.matrixWorld),
  );
  let vertices = 0;
  meshes.forEach((mesh, index) => {
    const positions = mesh.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++)
      bounds.expandByPoint(point.fromBufferAttribute(positions, i).applyMatrix4(transforms[index]));
    vertices += positions.count;
  });
  const size = bounds.getSize(new THREE.Vector3()),
    h = size.y;
  if (vertices < 100 || h < 1e-5 || size.x / h < 0.15 || size.x / h > 0.95 || size.z / h > 0.8)
    return null;
  const center = bounds.getCenter(new THREE.Vector3());
  const feet = [
    { x: 0, z: 0, count: 0 },
    { x: 0, z: 0, count: 0 },
  ];
  let middle = 0,
    soleWidth = 0,
    garmentWidth = 0,
    soleMinZ = Infinity,
    soleMaxZ = -Infinity;
  meshes.forEach((mesh, index) => {
    const positions = mesh.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(transforms[index]);
      const height = (point.y - bounds.min.y) / h;
      if (height > 0.05 && height < 0.2)
        garmentWidth = Math.max(garmentWidth, Math.abs(point.x - center.x));
      if (height > 0.03) continue;
      const x = point.x - center.x;
      soleWidth = Math.max(soleWidth, Math.abs(x));
      soleMinZ = Math.min(soleMinZ, point.z - center.z);
      soleMaxZ = Math.max(soleMaxZ, point.z - center.z);
      if (Math.abs(x) < h * 0.025) middle++;
      const foot = feet[x < 0 ? 0 : 1];
      foot.x += point.x;
      foot.z += point.z;
      foot.count++;
    }
  });
  if (feet.some((foot) => foot.count < 8) || middle > (feet[0].count + feet[1].count) * 0.28)
    return null;
  feet.forEach((foot) => {
    foot.x /= foot.count;
    foot.z /= foot.count;
  });
  if (feet[1].x - feet[0].x < h * 0.08) return null;
  const { hands, probes } = inferHandLandmarks(meshes, transforms, bounds);

  const root = new THREE.Group(),
    body = new THREE.Group();
  body.name = 'Imported_character_normalized';
  root.userData.proceduralGait = true;
  root.userData.gaitHeight = h;
  const longGarment = garmentWidth > soleWidth * 1.45;
  root.userData.gaitLongGarment = longGarment;
  root.userData.gaitHandLandmarks = hands.map((hand) => hand?.toArray() ?? null);
  root.add(body);
  const bones: THREE.Bone[] = [];
  const absolute = new Map<THREE.Bone, THREE.Vector3>();
  const joint = (name: string, parent: THREE.Bone | null, position: [number, number, number]) => {
    const bone = new THREE.Bone();
    bone.name = `gait-${name}`;
    const at = new THREE.Vector3(...position);
    absolute.set(bone, at);
    bone.position.copy(at).sub(parent ? absolute.get(parent)! : new THREE.Vector3());
    if (parent) parent.add(bone);
    else body.add(bone);
    bones.push(bone);
    return bone;
  };
  const y = (height: number) => bounds.min.y + height * h;
  const hip = joint('hips', null, [center.x, y(0.36), center.z]);
  root.userData.gaitRestHipY = hip.position.y;
  const spine = joint('spine', hip, [center.x, y(0.48), center.z]);
  joint('head', spine, [center.x, y(0.64), center.z]);
  for (const [index, side] of ['left', 'right'].entries()) {
    const foot = feet[index],
      sign = index ? 1 : -1;
    const thigh = joint(`${side}-thigh`, hip, [foot.x, y(0.34), center.z]);
    const knee = joint(`${side}-knee`, thigh, [foot.x, y(0.18), center.z]);
    joint(`${side}-ankle`, knee, [foot.x, y(0.045), center.z]);
    const hand = hands[index];
    const arm = joint(
      `${side}-arm`,
      spine,
      hand
        ? [hand.x - sign * h * 0.035, hand.y + h * 0.18, hand.z - h * 0.025]
        : [center.x + sign * h * 0.18, y(0.51), center.z],
    );
    joint(
      `${side}-forearm`,
      arm,
      hand
        ? [hand.x - sign * h * 0.015, hand.y + h * 0.09, hand.z]
        : [center.x + sign * h * 0.2, y(0.4), center.z],
    );
  }
  const skeleton = new THREE.Skeleton(bones);
  const indices = Object.fromEntries(bones.map((bone, index) => [bone.name.slice(5), index]));
  let seatBase = Infinity;
  let hand: { mesh: THREE.SkinnedMesh; vertex: number; score: number } | undefined;
  meshes.forEach((original, meshIndex) => {
    const geometry = original.geometry.clone().applyMatrix4(transforms[meshIndex]);
    const position = geometry.attributes.position;
    const skinIndex = new Uint16Array(position.count * 4),
      skinWeight = new Float32Array(position.count * 4);
    let handVertex = -1,
      handScore = Infinity;
    for (let i = 0; i < position.count; i++) {
      const x = (position.getX(i) - center.x) / h,
        height = (position.getY(i) - bounds.min.y) / h;
      const right = smooth(-0.045, 0.045, x);
      // A smooth skirt-to-hips blend avoids splitting a continuous garment at the centre.
      const z = (position.getZ(i) - center.z) / h;
      const footprint =
        (1 - smooth(soleWidth / h + 0.01, soleWidth / h + 0.035, Math.abs(x))) *
        smooth(soleMinZ / h - 0.04, soleMinZ / h - 0.02, z) *
        (1 - smooth(soleMaxZ / h + 0.02, soleMaxZ / h + 0.04, z));
      const leg = longGarment
        ? (1 - smooth(0.055, 0.1, height)) * footprint
        : 1 - smooth(0.24, 0.37, height);
      // Rigid long cloth rests on the cushion; it cannot drape around a seat.
      if (
        longGarment &&
        leg < 0.05 &&
        height > 0.035 &&
        height < 0.35 &&
        Math.abs(x) > 0.14 &&
        Math.abs(x) < 0.25 &&
        Math.abs(z) < 0.16
      )
        seatBase = Math.min(seatBase, position.getY(i));
      const lower = 1 - smooth(0.14, 0.21, height),
        ankle = 1 - smooth(0.035, 0.075, height);
      const weights: [number, number][] = [
        [indices.hips, (1 - leg) * (1 - smooth(0.44, 0.64, height))],
        [indices.head, smooth(0.6, 0.72, height)],
        [indices.spine, (1 - leg) * smooth(0.44, 0.64, height) * (1 - smooth(0.6, 0.72, height))],
      ];
      for (const [side, blend] of [
        ['left', 1 - right],
        ['right', right],
      ] as const) {
        weights.push([indices[`${side}-thigh`], leg * blend * (1 - lower)]);
        weights.push([indices[`${side}-knee`], leg * blend * lower * (1 - ankle)]);
        weights.push([indices[`${side}-ankle`], leg * blend * ankle]);
      }
      // Conservative arm weights keep adjacent long hair and sleeves from tearing.
      let arm =
        smooth(0.15, 0.24, Math.abs(x)) *
        smooth(0.31, 0.39, height) *
        (1 - smooth(0.5, 0.57, height)) *
        0.45;
      const handLandmark = hands[x < 0 ? 0 : 1];
      if (handLandmark) {
        const py = position.getY(i),
          sign = x < 0 ? -1 : 1;
        const along = THREE.MathUtils.clamp((py - handLandmark.y) / (h * 0.18), 0, 1);
        const dx = position.getX(i) - (handLandmark.x - sign * h * 0.035 * along);
        const dz = position.getZ(i) - (handLandmark.z - h * 0.025 * along);
        const radial = Math.hypot(dx, dz) / h;
        const sleeve =
          smooth(handLandmark.y - h * 0.06, handLandmark.y - h * 0.02, py) *
          (1 - smooth(handLandmark.y + h * 0.13, handLandmark.y + h * 0.22, py)) *
          (1 - smooth(0.025, 0.085, radial));
        arm = Math.max(arm * 0.2, sleeve * 0.35);
        if (radial < 0.04 && Math.abs(py - handLandmark.y) < h * 0.04 && probes[meshIndex]?.(i))
          arm = 0.45;
      }
      if (arm > 0) {
        weights.forEach((entry) => (entry[1] *= 1 - arm));
        weights.push([indices[`${x < 0 ? 'left' : 'right'}-arm`], arm]);
      }
      const rightHand = hands[1];
      const nearRightHand =
        rightHand &&
        x > 0 &&
        Math.abs(position.getY(i) - rightHand.y) < h * 0.075 &&
        probes[meshIndex]?.(i);
      if (
        rightHand
          ? nearRightHand
          : arm > 0.035 && x > 0.14 && height > 0.3 && height < 0.46 && z > -0.02
      ) {
        const score = rightHand
          ? (position.getX(i) - rightHand.x) ** 2 +
            (position.getY(i) - rightHand.y) ** 2 +
            (position.getZ(i) - rightHand.z) ** 2
          : (x - 0.22) ** 2 + (height - 0.36) ** 2 + (z - 0.08) ** 2;
        if (score < handScore) {
          handVertex = i;
          handScore = score;
        }
      }
      const selected = weights.sort((a, b) => b[1] - a[1]).slice(0, 4),
        total = selected.reduce((sum, entry) => sum + entry[1], 0);
      selected.forEach(([index, weight], channel) => {
        skinIndex[i * 4 + channel] = index;
        skinWeight[i * 4 + channel] = weight / total;
      });
    }
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
    const mesh = new THREE.SkinnedMesh(geometry, original.material);
    mesh.name = original.name;
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    body.add(mesh);
    if (handVertex >= 0 && (!hand || handScore < hand.score))
      hand = { mesh, vertex: handVertex, score: handScore };
  });
  if (hand) hand.mesh.userData.gaitRightHandVertex = hand.vertex;
  root.userData.gaitSeatBaseY = Number.isFinite(seatBase) ? seatBase : bounds.min.y + h * 0.1;
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh) object.bind(skeleton);
  });
  // The existing outer orientation control still applies, including in closeups.
  body.rotation.y = -THREE.MathUtils.degToRad(rotationY);
  return root;
}

export function poseProceduralGait(
  root: THREE.Object3D,
  motion: {
    phase: number;
    strength: number;
    time: number;
    working: boolean;
    leisure?: LeisurePose;
  },
) {
  let joints = rigs.get(root);
  if (!joints) {
    joints = {};
    root.traverse((object) => {
      if (object instanceof THREE.Bone) joints![object.name.slice(5)] = object;
    });
    rigs.set(root, joints);
  }
  if (!joints.hips) return;
  const { phase, strength, time, working } = motion;
  const h = Number(root.userData.gaitHeight) || 1.85;
  const drop = h * 0.014;
  joints.hips.position.y = Number(root.userData.gaitRestHipY) - drop * strength;
  for (const [index, side] of ['left', 'right'].entries()) {
    const angle = phase + index * Math.PI,
      swing = Math.sin(angle);
    const upper = h * 0.16,
      lower = h * 0.135;
    const footZ = Math.cos(angle) * h * 0.07;
    const lift = Math.max(0, -swing) * h * (root.userData.gaitLongGarment ? 0.016 : 0.04);
    const down = upper + lower - drop - lift;
    const knee = Math.acos(
      THREE.MathUtils.clamp(
        (down * down + footZ * footZ - upper * upper - lower * lower) / (2 * upper * lower),
        -1,
        1,
      ),
    );
    const thigh =
      Math.atan2(-footZ, down) - Math.atan2(lower * Math.sin(knee), upper + lower * Math.cos(knee));
    joints[`${side}-thigh`].rotation.x = thigh * strength;
    joints[`${side}-knee`].rotation.x = knee * strength;
    joints[`${side}-ankle`].rotation.x = (-thigh - knee) * strength;
    joints[`${side}-arm`].rotation.x = -swing * 0.14 * strength + (working ? -0.12 : 0);
    joints[`${side}-forearm`].rotation.x = -0.06 * strength;
    joints[`${side}-arm`].rotation.z = 0;
  }
  joints.hips.rotation.z = 0;
  joints.spine.rotation.y = Math.sin(phase) * 0.025 * strength;
  joints.head.rotation.y = -Math.sin(phase) * 0.015 * strength;
  joints.head.rotation.z = Math.sin(time * 0.7) * 0.008 * strength;
  joints.head.rotation.x = 0;
  const leisure = motion.leisure;
  if (!leisure || leisure.blend <= 0) return;
  const weight = leisure.blend;
  const draped = !!root.userData.gaitLongGarment;
  const seatedHip = draped
    ? Number(root.userData.gaitRestHipY) +
      leisure.seatHeight -
      Number(root.userData.gaitSeatBaseY) +
      0.01
    : leisure.seatHeight + h * 0.025;
  joints.hips.position.y = THREE.MathUtils.lerp(joints.hips.position.y, seatedHip, weight);
  const sip = leisure.activity === 'tea' ? teaSip(leisure.time) : 0;
  for (const [index, side] of ['left', 'right'].entries()) {
    const thigh = joints[`${side}-thigh`],
      knee = joints[`${side}-knee`],
      ankle = joints[`${side}-ankle`];
    thigh.rotation.x = THREE.MathUtils.lerp(thigh.rotation.x, draped ? -0.18 : -1.4, weight);
    knee.rotation.x = THREE.MathUtils.lerp(knee.rotation.x, draped ? 0.28 : 1.4, weight);
    ankle.rotation.x *= 1 - weight;
    const grip = leisure.activity === 'swing';
    const arm = joints[`${side}-arm`];
    arm.rotation.x = THREE.MathUtils.lerp(
      arm.rotation.x,
      grip ? -0.6 : side === 'right' && leisure.activity === 'tea' ? -0.65 - sip * 0.45 : -0.2,
      weight,
    );
    arm.rotation.z = grip ? (index ? 0.35 : -0.35) * weight : 0;
    joints[`${side}-forearm`].rotation.x = THREE.MathUtils.lerp(
      joints[`${side}-forearm`].rotation.x,
      -0.3,
      weight,
    );
  }
  joints.head.rotation.x = sip * 0.045 * weight;
}

export function disposeProceduralTemplate(root: THREE.Object3D) {
  const skeletons = new Set<THREE.Skeleton>();
  root.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh) {
      object.geometry.dispose();
      skeletons.add(object.skeleton);
    }
  });
  skeletons.forEach((skeleton) => skeleton.dispose());
}
