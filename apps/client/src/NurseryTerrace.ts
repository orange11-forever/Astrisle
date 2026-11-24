import * as THREE from 'three';
import type { createIslandPropBuilder } from './IslandPropGeometry';
import { nurseryCrossingZ, nurseryDeck } from './garden-access';

/** The nursery shares the glasshouse's vertex-coloured mesh and material. */
export function buildNurseryTerrace(builder: ReturnType<typeof createIslandPropBuilder>) {
  const { add, box, beam } = builder;
  const timber = '#957153';
  const green = '#416c64';
  const rim = '#caab80';
  const { front, rear } = nurseryDeck;
  for (let i = 0; i < 15; i++) {
    box(
      [0.57 + i * 0.202, 0.067, nurseryCrossingZ - 0.06],
      [0.198, 0.106, front - rear],
      ['#bda588', '#c7ad8d', '#baa080'][i % 3],
    );
  }
  for (const z of [rear, front]) {
    box([1.98, -0.04, z], [3.08, 0.17, 0.105], timber);
    for (const x of [1.55, 3.27]) {
      box([x, -0.39, z], [0.13, 0.82, 0.13], timber);
      beam([x, -0.64, z], [x - 0.51, -0.08, z], 0.095, timber);
    }
  }
  for (const z of [rear, front]) {
    box([2.28, 0.62, z], [2.43, 0.072, 0.068], rim);
    for (const x of [1.13, 2.33, 3.44]) box([x, 0.39, z], [0.07, 0.57, 0.07], green);
  }
  box([3.44, 0.62, 1.72], [0.068, 0.072, 1.84], rim);
  // Canvas sags gently between the two battens over the propagation bench.
  for (const x of [1.49, 3.31]) {
    box([x, 1.06, rear + 0.12], [0.072, 1.89, 0.072], green);
    beam([x, 1.79, rear + 0.12], [x, 2.09, rear + 0.68], 0.055, green);
  }
  for (let stripe = 0; stripe < 9; stripe++) {
    const x = 1.42 + stripe * 0.225;
    const tone = stripe % 2 ? '#8daaa0' : '#ebd8ab';
    box([x, 2.06, rear + 0.31], [0.226, 0.027, 0.66], tone, [-0.12, 0, 0]);
    box([x, 2.075, rear + 0.85], [0.226, 0.027, 0.45], tone, [0.12, 0, 0]);
    box([x, 1.994, rear + 1.07], [0.226, 0.114, 0.025], tone);
  }
  // Growing bench, a flat of cuttings, plant markers and a stack of empty pots.
  box([2.32, 0.75, rear + 0.31], [1.63, 0.08, 0.51], timber);
  for (const x of [1.59, 3.05]) {
    for (const z of [rear + 0.13, rear + 0.48]) box([x, 0.44, z], [0.065, 0.62, 0.065], green);
  }
  box([2.06, 0.815, rear + 0.31], [0.94, 0.09, 0.38], '#b07956');
  box([2.06, 0.863, rear + 0.31], [0.88, 0.013, 0.33], '#665540');
  for (let i = 0; i < 8; i++) {
    const x = 1.72 + (i % 4) * 0.219;
    const z = rear + 0.23 + Math.floor(i / 4) * 0.17;
    for (const side of [-1, 1])
      add(
        new THREE.IcosahedronGeometry(1).scale(0.035, 0.09, 0.028),
        [x + side * 0.031, 0.934, z],
        i % 3 ? '#79945e' : '#98aa74',
        [0.22, i * 0.43, -side * 0.54],
      );
  }
  for (const x of [1.73, 2.39]) {
    box([x, 0.97, rear + 0.18], [0.017, 0.22, 0.014], rim);
    box([x, 1.065, rear + 0.18], [0.107, 0.047, 0.018], '#e9dab0');
  }
  for (let i = 0; i < 3; i++) {
    add(
      new THREE.CylinderGeometry(0.113, 0.075, 0.14, 10),
      [2.83, 0.86 + i * 0.043, rear + 0.31],
      '#ba856c',
    );
  }
  add(new THREE.CircleGeometry(0.096, 10), [2.83, 1.017, rear + 0.31], '#795749', [
    -Math.PI / 2,
    0,
    0,
  ]);
}
