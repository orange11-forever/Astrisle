import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { dayIslandLight, type IslandLight } from './island-daylight';

type ColoredSurface = { position: Float32Array; color: Float32Array };
type IndexedSurface = ColoredSurface & { index: Uint16Array };

const galaxyPole = new THREE.Vector3(0.28, 0.8, -0.53).normalize();
const milkyWayPole = new THREE.Vector3(0.43, 0.84, 0.32).normalize();
const milkyWayCenter = new THREE.Vector3(0, milkyWayPole.z, -milkyWayPole.y).normalize();
const milkyWayTangent = milkyWayCenter.clone().cross(milkyWayPole);
const ringTilt: [number, number, number] = [1.15, -0.18, 0.38];
const planetAxis = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...ringTilt));
const planetSun = new THREE.Vector3(-0.64, 0.64, 0.53).normalize();
const ringedPlanet: [number, number, number] = [-128, -45, -90];
const moonPosition: [number, number, number] = [-23, -55, -180];
const celestialDistance = 2.2;

function coloredSurface(
  geometry: THREE.BufferGeometry,
  fill: (position: THREE.Vector3, tint: THREE.Color) => void,
): IndexedSurface {
  const positions = geometry.getAttribute('position');
  const position = positions.array as Float32Array;
  const index = geometry.getIndex()!.array as Uint16Array;
  const color = new Float32Array(position.length);
  const vertex = new THREE.Vector3();
  const tint = new THREE.Color();
  for (let i = 0; i < positions.count; i++) {
    fill(vertex.fromBufferAttribute(positions, i), tint);
    tint.toArray(color, i * 3);
  }
  geometry.dispose();
  return { position, index, color };
}

function haze(distance: number, width: number) {
  return Math.exp(-((distance / width) ** 2));
}

/** Bake the quiet sky into vertex colors: no textures or per-pixel noise shader. */
function skySurface() {
  const base = new THREE.Color('#080d21');
  const violet = new THREE.Color('#241c39');
  const blue = new THREE.Color('#172844');
  const starlight = new THREE.Color('#4f4f68');
  const coolCloud = new THREE.Color('#354765');
  const violetDirection = new THREE.Vector3(-0.7, -0.2, -0.7).normalize();
  const blueDirection = new THREE.Vector3(0.7, 0.1, -0.5).normalize();
  const geometry = new THREE.SphereGeometry(460, 72, 42);
  const uv = geometry.getAttribute('uv').array as Float32Array;
  const surface = coloredSurface(geometry, (direction, tint) => {
    direction.normalize();
    const violetWeight = Math.pow(Math.max(0, direction.dot(violetDirection)), 5) * 0.8;
    const blueWeight = Math.pow(Math.max(0, direction.dot(blueDirection)), 6) * 0.58;
    const longitude = Math.atan2(direction.z, direction.x);
    const lane =
      direction.dot(galaxyPole) -
      0.044 * Math.sin(longitude * 3 + 0.5) -
      0.018 * Math.sin(longitude * 7 - 1);
    const cloudCover =
      0.6 + 0.19 * Math.sin(longitude * 5 + 2.4) + 0.13 * Math.sin(longitude * 11 - 0.8);
    const mist = haze(lane, 0.25) * (0.1 + 0.18 * cloudCover);
    const core = (0.15 * haze(lane - 0.046, 0.09) + 0.1 * haze(lane + 0.085, 0.12)) * cloudCover;
    tint
      .copy(base)
      .lerp(violet, violetWeight)
      .lerp(blue, blueWeight)
      .lerp(coolCloud, mist)
      .lerp(starlight, core);
  });
  return { ...surface, uv };
}

function cloudHash(x: number, y: number, z: number) {
  const seed = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2246822519);
  const mixed = Math.imul(seed ^ (seed >>> 13), 1274126177);
  return ((mixed ^ (mixed >>> 16)) >>> 0) / 0xffffffff;
}

function cloudNoise(direction: THREE.Vector3, scale: number, offset: number) {
  const x = (direction.x * 0.8 - direction.y * 0.36 + direction.z * 0.48) * scale + offset;
  const y = (direction.x * 0.51 + direction.y * 0.84 - direction.z * 0.19) * scale + offset;
  const z = (-direction.x * 0.33 + direction.y * 0.41 + direction.z * 0.85) * scale + offset;
  const a = Math.floor(x);
  const b = Math.floor(y);
  const c = Math.floor(z);
  const { lerp, smoothstep } = THREE.MathUtils;
  const u = smoothstep(x - a, 0, 1);
  const v = smoothstep(y - b, 0, 1);
  const w = smoothstep(z - c, 0, 1);
  return lerp(
    lerp(
      lerp(cloudHash(a, b, c), cloudHash(a + 1, b, c), u),
      lerp(cloudHash(a, b + 1, c), cloudHash(a + 1, b + 1, c), u),
      v,
    ),
    lerp(
      lerp(cloudHash(a, b, c + 1), cloudHash(a + 1, b, c + 1), u),
      lerp(cloudHash(a, b + 1, c + 1), cloudHash(a + 1, b + 1, c + 1), u),
      v,
    ),
    w,
  );
}

function milkyWayBend(direction: THREE.Vector3, broad: number) {
  const longitude = Math.atan2(direction.dot(milkyWayTangent), direction.dot(milkyWayCenter));
  return 0.035 * Math.sin(longitude * 3 + 0.45) + 0.12 * (broad - 0.5);
}

function skySurfaces() {
  const day = skySurface();
  const dusk = new Float32Array(day.color.length);
  const twilight = new THREE.Color('#aa655e');
  const afterglow = new THREE.Color('#c18771');
  const duskZenith = new THREE.Color('#101a3b');
  const duskWest = new THREE.Vector3(-0.86, 0.04, -0.51).normalize();
  const tint = new THREE.Color();
  const direction = new THREE.Vector3();
  for (let i = 0; i < day.position.length; i += 3) {
    direction.fromArray(day.position, i).normalize();
    const west = Math.max(0, direction.dot(duskWest)) ** 3;
    tint
      .fromArray(day.color, i)
      .lerp(duskZenith, 0.44)
      .lerp(twilight, haze(direction.y + 0.015, 0.28) * (0.13 + 0.34 * west))
      .lerp(afterglow, haze(direction.y + 0.065, 0.11) * west * 0.26)
      .toArray(dusk, i);
  }
  return { day, dusk };
}

const nightSkyWidth = 768;
const nightSkyHeight = 384;
let cachedNightPixels: Uint8Array | undefined;

/** Cache CPU pixels only. Each canvas owns and disposes its GPU texture. */
function nightSkyPixels() {
  if (cachedNightPixels) return cachedNightPixels;
  const width = nightSkyWidth;
  const height = nightSkyHeight;
  const pixels = new Uint8Array(width * height * 4);
  const nightBase = new THREE.Color('#050b24');
  const nightHorizon = new THREE.Color('#1b3053');
  const veil = new THREE.Color('#3b4271');
  const silver = new THREE.Color('#8a9dc3');
  const gold = new THREE.Color('#b9a394');
  const dustShadow = new THREE.Color('#0c142d');
  const { smoothstep } = THREE.MathUtils;
  const direction = new THREE.Vector3();
  const tint = new THREE.Color();
  const horizon = new THREE.Color();
  const meridians = Array.from({ length: width }, (_, i) => {
    const phi = ((i + 0.5) / width) * Math.PI * 2;
    return [-Math.cos(phi), Math.sin(phi)] as const;
  });
  for (let row = 0; row < height; row++) {
    const theta = (1 - (row + 0.5) / height) * Math.PI;
    const horizontal = Math.sin(theta);
    const y = Math.cos(theta);
    const horizonGlow = haze(y + 0.08, 0.29);
    horizon
      .copy(nightBase)
      .lerp(nightHorizon, horizonGlow * 0.5)
      .convertLinearToSRGB();
    const baseR = Math.round(horizon.r * 255);
    const baseG = Math.round(horizon.g * 255);
    const baseB = Math.round(horizon.b * 255);
    for (let column = 0; column < width; column++) {
      const [x, z] = meridians[column]!;
      direction.set(x * horizontal, y, z * horizontal);
      const distance = direction.dot(milkyWayPole);
      const offset = (row * width + column) * 4;
      pixels[offset + 3] = 255;
      if (Math.abs(distance) >= 0.49) {
        pixels[offset] = baseR;
        pixels[offset + 1] = baseG;
        pixels[offset + 2] = baseB;
        continue;
      }
      // Sample in 3D so the dust folds stay continuous across the sphere seam.
      const broad = cloudNoise(direction, 5, 19.3);
      const wisps = cloudNoise(direction, 16, 31.7);
      const grains = cloudNoise(direction, 32, 52.9);
      const lane = distance - milkyWayBend(direction, broad);
      const edge = 1 - smoothstep(Math.abs(distance), 0.32, 0.49);
      const cloudCover = broad * 0.5 + wisps * 0.33 + grains * 0.17;
      const density = 0.11 + 0.89 * smoothstep(cloudCover, 0.28, 0.72);
      const rift = haze(lane + 0.008 + 0.12 * (wisps - 0.5), 0.018 + grains * 0.02);
      const brokenDust = 1 - rift * (0.38 + 0.62 * smoothstep(wisps, 0.24, 0.73));
      const glow = haze(lane - 0.02, 0.2) * (0.05 + 0.2 * density);
      const strands = 0.09 + 0.4 * smoothstep(wisps * 0.65 + grains * 0.35, 0.2, 0.8);
      const silverRidge =
        haze(lane - 0.047 + 0.05 * (grains - 0.5), 0.053 + density * 0.048) * strands;
      const goldRidge = haze(lane + 0.046, 0.059) * smoothstep(grains, 0.3, 0.78) * 0.17;
      tint
        .copy(nightBase)
        .lerp(nightHorizon, horizonGlow * (0.5 + (broad - 0.5) * 0.51 * edge))
        .lerp(veil, glow * edge)
        .lerp(silver, silverRidge * density * brokenDust)
        .lerp(gold, goldRidge * density * brokenDust)
        .lerp(dustShadow, rift * density * 0.34)
        .convertLinearToSRGB();
      pixels[offset] = Math.round(tint.r * 255);
      pixels[offset + 1] = Math.round(tint.g * 255);
      pixels[offset + 2] = Math.round(tint.b * 255);
    }
  }
  cachedNightPixels = pixels;
  return pixels;
}

function nightSkyTexture() {
  const texture = new THREE.DataTexture(nightSkyPixels(), nightSkyWidth, nightSkyHeight);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function starField(reduced: boolean) {
  const layers = [
    { baseline: 42, extra: 58, cluster: 0.27, size: 6.3, intensity: 1 },
    { baseline: 134, extra: reduced ? 235 : 395, cluster: 0.54, size: 4.3, intensity: 0.86 },
    {
      baseline: reduced ? 720 : 980,
      extra: reduced ? 1950 : 3600,
      cluster: 0.72,
      size: 3.25,
      intensity: 0.62,
    },
  ];
  const count = layers.reduce((total, layer) => total + layer.baseline + layer.extra, 0);
  const position = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  // CSS-pixel diameter, strength, brightness tier, and whether a star only appears at night.
  const properties = new Float32Array(count * 4);
  const tints = ['#a6c2f1', '#d3ddf8', '#f0f1f8', '#f2d7be', '#e2b3a4'].map(
    (value) => new THREE.Color(value),
  );
  const direction = new THREE.Vector3();
  let state = 0x41535452;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  let star = 0;
  for (const [tier, layer] of layers.entries()) {
    for (let i = 0; i < layer.baseline + layer.extra; i++, star++) {
      const nightOnly = i >= layer.baseline;
      const pole = nightOnly ? milkyWayPole : galaxyPole;
      const y = random() * 2 - 1;
      const angle = random() * Math.PI * 2;
      const horizontal = Math.sqrt(1 - y * y);
      direction.set(Math.cos(angle) * horizontal, y, Math.sin(angle) * horizontal);
      if (random() < layer.cluster) {
        direction.addScaledVector(pole, -direction.dot(pole)).normalize();
        const scatter = random() + random() - 1;
        const broad = cloudNoise(direction, 5, 19.3);
        const wisp = cloudNoise(direction, 14, 37.5);
        const offset = nightOnly ? milkyWayBend(direction, broad) + (wisp - 0.5) * 0.12 : 0;
        const width = nightOnly ? 0.12 + broad * 0.21 : 0.25;
        direction.addScaledVector(pole, offset + scatter * width).normalize();
      }
      direction.multiplyScalar(448).toArray(position, star * 3);
      tints[Math.floor(random() * tints.length)]!.toArray(color, star * 3);
      properties[star * 4] = layer.size * (0.68 + random() * 0.61);
      properties[star * 4 + 1] = layer.intensity * (0.43 + random() ** 2 * 0.57);
      properties[star * 4 + 2] = tier;
      properties[star * 4 + 3] = Number(nightOnly);
    }
  }
  return { position, color, properties };
}

function StarField({ reduced, light }: { reduced: boolean; light: IslandLight }) {
  const pixels = useThree(
    ({ viewport, size }) => viewport.dpr * THREE.MathUtils.clamp(size.height / 760, 0.72, 1.4),
  );
  const field = useMemo(() => starField(reduced), [reduced]);
  const { bright, mid, faint } = light.stars;
  const uniforms = useMemo(
    () => ({
      pixels: { value: pixels },
      visibility: { value: new THREE.Vector3(bright, mid, faint) },
      night: { value: light.night },
    }),
    [bright, mid, faint, pixels, light.night],
  );
  return (
    <points renderOrder={-10} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[field.position, 3]} />
        <bufferAttribute attach="attributes-color" args={[field.color, 3]} />
        <bufferAttribute attach="attributes-star" args={[field.properties, 4]} />
      </bufferGeometry>
      <shaderMaterial
        vertexColors
        transparent
        toneMapped={false}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        uniforms={uniforms}
        vertexShader={`
          attribute vec4 star;
          uniform float pixels;
          uniform vec3 visibility;
          uniform float night;
          varying vec3 tint;
          varying float strength;
          void main() {
            float tier = star.z < .5 ? visibility.x : (star.z < 1.5 ? visibility.y : visibility.z);
            strength = star.y * tier * mix(.70, 1.0, night) * mix(1.0, night, star.w);
            tint = color;
            gl_PointSize = max(1.0, star.x * pixels);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `}
        fragmentShader={`
          varying vec3 tint;
          varying float strength;
          void main() {
            float distance = length(gl_PointCoord - vec2(.5));
            float core = 1.0 - smoothstep(.06, .29, distance);
            float halo = 1.0 - smoothstep(.03, .50, distance);
            float alpha = (core * .86 + halo * .14) * strength;
            if (alpha < .006) discard;
            gl_FragColor = vec4(tint, alpha);
            #include <colorspace_fragment>
          }
        `}
      />
    </points>
  );
}

function SurfaceGeometry({ surface }: { surface: IndexedSurface }) {
  return (
    <bufferGeometry>
      <bufferAttribute attach="index" args={[surface.index, 1]} />
      <bufferAttribute attach="attributes-position" args={[surface.position, 3]} />
      <bufferAttribute attach="attributes-color" args={[surface.color, 3]} />
    </bufferGeometry>
  );
}

function Planet({
  position,
  radius,
  moon = false,
}: {
  position: [number, number, number];
  radius: number;
  moon?: boolean;
}) {
  const surface = useMemo(() => {
    const shadow = new THREE.Color(moon ? '#151b30' : '#15182c');
    const dusk = new THREE.Color(moon ? '#46465d' : '#4c415a');
    const light = new THREE.Color(moon ? '#8b8b99' : '#847383');
    const limb = new THREE.Color(moon ? '#9a9cae' : '#9a8fa9');
    const albedo = new THREE.Color();
    const observer = new THREE.Vector3(...position).normalize().negate();
    return coloredSurface(new THREE.SphereGeometry(radius, 56, 36), (normal, tint) => {
      normal.normalize();
      const illumination = THREE.MathUtils.smoothstep(normal.dot(planetSun), -0.2, 0.9);
      const edge = (1 - Math.max(0, normal.dot(observer))) ** 4;
      const latitude = Math.asin(THREE.MathUtils.clamp(normal.dot(planetAxis), -1, 1));
      const band = 0.64 + 0.16 * Math.cos(latitude * 18 + 0.8) + 0.08 * Math.sin(latitude * 44);
      const mare =
        0.64 + 0.2 * Math.sin(normal.x * 12 + normal.z * 5) * Math.sin(normal.y * 8 - normal.z * 4);
      albedo.copy(dusk).lerp(light, moon ? mare : band);
      tint
        .copy(shadow)
        .lerp(albedo, 0.07 + illumination * 0.91)
        .lerp(limb, edge * (0.018 + illumination * 0.18));
    });
  }, [radius, moon, position]);
  return (
    <mesh position={position} renderOrder={-5}>
      <SurfaceGeometry surface={surface} />
      <meshBasicMaterial vertexColors toneMapped={false} fog={false} />
    </mesh>
  );
}

function ringSurface() {
  const innerRadius = 13.5;
  const outerRadius = 17.6;
  const shadow = new THREE.Color('#2a263d');
  const frost = new THREE.Color('#73677f');
  return coloredSurface(
    new THREE.RingGeometry(innerRadius, outerRadius, 96, 18),
    (vertex, tint) => {
      const t = (vertex.length() - innerRadius) / (outerRadius - innerRadius);
      const radial =
        0.45 + 0.18 * Math.cos(t * Math.PI * 8 + 0.5) + 0.1 * Math.sin(t * Math.PI * 17);
      const edge = Math.sin(Math.PI * THREE.MathUtils.clamp(t, 0, 1)) ** 0.55;
      const side = 0.68 + 0.24 * Math.cos(Math.atan2(vertex.y, vertex.x) - 2.1);
      tint.copy(shadow).lerp(frost, radial * edge * side);
    },
  );
}

/** Static, camera-centered scenery; it never invalidates the demand-rendered canvas. */
export function CosmicBackdrop({
  reduced = false,
  light = dayIslandLight,
}: {
  reduced?: boolean;
  light?: IslandLight;
}) {
  const root = useRef<THREE.Group>(null);
  const nightTexture = useRef<THREE.DataTexture>(null);
  const sky = useMemo(skySurfaces, []);
  const { dusk, night } = light;
  if (night > 0 && !nightTexture.current) nightTexture.current = nightSkyTexture();
  const texture = nightTexture.current;
  useEffect(() => () => nightTexture.current?.dispose(), []);
  const uniforms = useMemo(
    () => ({
      duskMix: { value: dusk },
      nightMix: { value: night },
      nightSky: { value: texture },
    }),
    [dusk, night, texture],
  );
  const rings = useMemo(ringSurface, []);
  useFrame(({ camera }) => {
    // Following translation keeps the shell beyond every orbit/pan without adding motion.
    root.current?.position.copy(camera.position);
  });
  return (
    <group ref={root} name="cosmic-backdrop">
      <mesh renderOrder={-20} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="index" args={[sky.day.index, 1]} />
          <bufferAttribute attach="attributes-position" args={[sky.day.position, 3]} />
          <bufferAttribute attach="attributes-color" args={[sky.day.color, 3]} />
          <bufferAttribute attach="attributes-uv" args={[sky.day.uv, 2]} />
          <bufferAttribute attach="attributes-duskColor" args={[sky.dusk, 3]} />
        </bufferGeometry>
        <shaderMaterial
          vertexColors
          side={THREE.BackSide}
          depthWrite={false}
          depthTest={false}
          toneMapped={false}
          uniforms={uniforms}
          vertexShader={`
            attribute vec3 duskColor;
            uniform float duskMix;
            uniform float nightMix;
            varying vec3 skyColor;
            varying vec2 skyUv;
            void main() {
              skyColor = color * (1.0 - duskMix - nightMix) + duskColor * duskMix;
              skyUv = uv;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `}
          fragmentShader={`
            uniform float nightMix;
            uniform sampler2D nightSky;
            varying vec3 skyColor;
            varying vec2 skyUv;
            void main() {
              vec3 tint = skyColor;
              if (nightMix > 0.0) tint += texture2D(nightSky, skyUv).rgb * nightMix;
              gl_FragColor = vec4(tint, 1.0);
              #include <colorspace_fragment>
            }
          `}
        />
      </mesh>
      <StarField reduced={reduced} light={light} />
      <group scale={celestialDistance}>
        <Planet position={ringedPlanet} radius={10.5} />
        <mesh position={ringedPlanet} rotation={ringTilt} renderOrder={-5}>
          <SurfaceGeometry surface={rings} />
          <meshBasicMaterial vertexColors side={THREE.DoubleSide} toneMapped={false} fog={false} />
        </mesh>
        <Planet position={moonPosition} radius={4.5} moon />
      </group>
    </group>
  );
}

export function IslandSkyLighting({
  light,
  overview = false,
}: {
  light: IslandLight;
  overview?: boolean;
}) {
  const { dusk, night } = light;
  const colors = useMemo(() => {
    const mix = (day: string, sunset: string, moonlight: string) =>
      new THREE.Color(day)
        .lerp(new THREE.Color(sunset), dusk)
        .lerp(new THREE.Color(moonlight), night);
    return {
      ambient: mix('#ffffff', '#fbe5d8', '#c9d6ec'),
      sky: mix(overview ? '#cedaff' : '#d3e5fe', '#bbcadf', '#a9c8f0'),
      ground: mix(overview ? '#665575' : '#71637d', '#685674', '#615475'),
      key: mix(overview ? '#ffe7c5' : '#ffe5bf', '#ffd09d', '#bfd6f7'),
      rim: mix('#a9c1f4', '#aabfe9', '#9bbcf3'),
    };
  }, [dusk, night, overview]);
  const intensity = (day: number, sunset: number, moonlight: number) =>
    day * (1 - dusk - night) + sunset * dusk + moonlight * night;
  return (
    <>
      <ambientLight
        color={colors.ambient}
        intensity={intensity(overview ? 0.9 : 0.6, 0.62, 0.53)}
      />
      <hemisphereLight
        color={colors.sky}
        groundColor={colors.ground}
        intensity={intensity(overview ? 1.4 : 1.12, 1.01, 0.83)}
      />
      <directionalLight
        position={overview ? [-8, 14, 8] : [-8, 9, 6]}
        intensity={intensity(overview ? 2 : 2.58, 1.7, 1.05)}
        color={colors.key}
      />
      {!overview && (
        <directionalLight
          position={[6, 4, -8]}
          intensity={intensity(0.92, 0.89, 1.08)}
          color={colors.rim}
        />
      )}
    </>
  );
}
