import { BufferGeometry, Color, Float32BufferAttribute, ShapeUtils, Vector2 } from 'three';
import { ISLAND_RADIUS } from './island-motion';
import { POND_CENTER, POND_WATER_LEVEL, POND_WATER_RADIUS, pondWorldRing } from './island-pond';
import type { islandAppearance } from './islands';

type Point = [number, number, number];
type TerrainPalette = Pick<ReturnType<typeof islandAppearance>, 'grass' | 'stone' | 'rotation'>;

const segments = 72;
const groundY = -0.025;
const gardenRadius = ISLAND_RADIUS - 0.3;

export function shoreRadius(angle: number, rotation: number) {
  return (
    ISLAND_RADIUS +
    0.24 +
    0.23 * Math.sin(angle * 3 + rotation) +
    0.13 * Math.sin(angle * 5 - rotation * 0.7) +
    0.055 * Math.cos(angle * 9 + rotation * 2)
  );
}

/** Keep the garden level and let the narrow outer verge descend into the cliff. */
export function shoreGroundHeight(angle: number, radius: number, rotation: number) {
  const slope = Math.max(
    0,
    (radius - gardenRadius) / (shoreRadius(angle, rotation) - gardenRadius),
  );
  return groundY - 0.11 * slope;
}

export function createIslandTerrain({ grass, stone, rotation }: TerrainPalette) {
  const turf = new Color(grass);
  const rock = new Color(stone);
  const moss = turf.clone().lerp(new Color('#526947'), 0.47);
  const loam = rock.clone().lerp(new Color('#756654'), 0.57);
  const shale = rock.clone().lerp(new Color('#556063'), 0.31);
  const shelf = rock.clone().lerp(new Color('#a8a08b'), 0.43);
  const underside = rock.clone().lerp(new Color('#47505c'), 0.69);
  const rings: Point[][] = [];
  const positions: number[] = [];
  const colors: number[] = [];
  const color = new Color();
  const angles = Array.from({ length: segments }, (_, i) => (i * Math.PI * 2) / segments);

  for (const radius of [3.2, 6.1, gardenRadius]) {
    rings.push(
      angles.map((angle) => [Math.cos(angle) * radius, groundY, Math.sin(angle) * radius]),
    );
  }

  // Each band shares its edges with the next. The shelves track the rim before
  // the lower layers break away into an asymmetric, much narrower underside.
  const bands = [
    { inset: 0, height: -0.135, relief: 0, tint: turf.clone().lerp(moss, 0.25) },
    { inset: 0.095, height: -0.3, relief: 0.05, tint: moss },
    { inset: 0.05, height: -0.48, relief: 0.1, tint: loam },
    { inset: 0.33, height: -0.87, relief: 0.16, tint: shale },
    { inset: 0.15, height: -1.09, relief: 0.2, tint: shelf },
    { inset: 0.48, height: -1.26, relief: 0.21, tint: loam },
    { inset: 0.88, height: -1.83, relief: 0.29, tint: rock },
    { inset: 0.78, height: -2.0, relief: 0.29, tint: shelf.clone().lerp(rock, 0.45) },
    { inset: 1.57, height: -2.61, relief: 0.37, tint: shale },
    { inset: 3.09, height: -3.39, relief: 0.43, tint: shale.clone().lerp(underside, 0.44) },
    { inset: 4.88, height: -4.02, relief: 0.53, tint: underside },
    { inset: 7.23, height: -4.54, relief: 0.48, tint: underside },
  ];

  bands.forEach(({ inset, height, relief }, band) => {
    rings.push(
      angles.map((angle) => {
        const ridge = Math.max(0, Math.sin(angle * 3 + rotation - 0.6)) ** 3;
        const radius =
          shoreRadius(angle, rotation) -
          inset +
          Math.min(inset * 0.23, 0.56) * ridge +
          relief *
            (Math.sin(angle * 6 + rotation + band * 0.8) * 0.63 +
              Math.cos(angle * 13 - band * 0.55) * 0.37);
        const fold = Math.min(band * 0.075, (bands.length - band) * 0.15);
        const verticalVariation =
          relief * (Math.sin(angle * 4 - rotation) * 0.48 + Math.cos(angle * 9 + 0.2) * 0.19) +
          fold *
            (Math.sin(angle * 2 + rotation * 0.5) * 0.61 + Math.cos(angle * 3 - rotation) * 0.39);
        return [
          Math.cos(angle) * radius - inset * 0.15,
          height + verticalVariation,
          Math.sin(angle) * radius + inset * 0.09,
        ];
      }),
    );
  });

  const addTriangle = (a: Point, b: Point, c: Point, tint: Color) => {
    for (const [x, y, z] of [a, b, c]) {
      positions.push(x, y, z);
      const variation =
        Math.sin(x * 1.12 + z * 1.73 + rotation) * 0.085 + Math.cos(x * 3.7 - z * 2.6) * 0.045;
      color.copy(tint).multiplyScalar(1 + variation);
      colors.push(color.r, color.g, color.b);
    }
  };

  const center: Point = [0, groundY, 0];
  const bottom: Point = [-1.15, -4.98, 0.63];
  const ground = rings[0]!;
  const taper = rings[rings.length - 1]!;
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;
    addTriangle(center, ground[next]!, ground[i]!, turf);
    addTriangle(taper[i]!, taper[next]!, bottom, underside);
  }
  for (let j = 1; j < rings.length; j++) {
    const upper = rings[j - 1]!;
    const lower = rings[j]!;
    const tint = bands[j - 3]?.tint ?? turf;
    if (j === 2) {
      const rim = pondWorldRing(1, groundY);
      const points = [...lower, ...upper, ...rim];
      const project = (ring: Point[]) => ring.map(([x, , z]) => new Vector2(x, -z));
      const top = ShapeUtils.triangulateShape(project(lower), [project(upper), project(rim)]);
      for (const [a, b, c] of top) addTriangle(points[a!]!, points[b!]!, points[c!]!, turf);

      const wetBank = new Color('#596d5d').lerp(rock, 0.28);
      const layers = [
        { scale: 0.91, height: -0.056, tint: turf.clone().lerp(new Color('#817657'), 0.56) },
        { scale: POND_WATER_RADIUS, height: POND_WATER_LEVEL, tint: wetBank },
        { scale: 0.68, height: -0.218, tint: new Color('#718879').lerp(rock, 0.24) },
        { scale: 0.44, height: -0.29, tint: new Color('#506b64') },
      ];
      let edge = rim;
      for (const layer of layers) {
        const deeper = pondWorldRing(layer.scale, layer.height);
        for (let i = 0; i < edge.length; i++) {
          const next = (i + 1) % edge.length;
          addTriangle(edge[i]!, deeper[i]!, edge[next]!, layer.tint);
          addTriangle(edge[next]!, deeper[i]!, deeper[next]!, layer.tint);
        }
        edge = deeper;
      }
      const bed: Point = [POND_CENTER[0], -0.324, POND_CENTER[2]];
      for (let i = 0; i < edge.length; i++) {
        addTriangle(bed, edge[(i + 1) % edge.length]!, edge[i]!, layers[3]!.tint);
      }
      continue;
    }
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      addTriangle(upper[i]!, upper[next]!, lower[i]!, tint);
      addTriangle(upper[next]!, lower[next]!, lower[i]!, tint);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}
