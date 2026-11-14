import * as THREE from 'three';

const skinColor = (r: number, g: number, b: number) =>
  r > 155 && g > 100 && b > 80 && r - g >= 8 && g - b >= 4 && r - g < 65 && g - b < 55;

/** Optional appearance evidence for stylized figures whose hands sit below standard proportions. */
export function skinProbe(mesh: THREE.Mesh): ((vertex: number) => boolean) | undefined {
  if (Array.isArray(mesh.material)) return undefined;
  const material = mesh.material as THREE.MeshStandardMaterial;
  const texture = material.map;
  if (!texture) {
    if (!material.color) return undefined;
    const color = material.color.clone().convertLinearToSRGB();
    return skinColor(color.r * 255, color.g * 255, color.b * 255) ? () => true : undefined;
  }
  const uv = mesh.geometry.attributes.uv;
  if (!uv || !texture.image || typeof OffscreenCanvas === 'undefined') return undefined;
  try {
    const canvas = new OffscreenCanvas(256, 256);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return undefined;
    context.drawImage(texture.image as CanvasImageSource, 0, 0, 256, 256);
    const pixels = context.getImageData(0, 0, 256, 256).data;
    texture.updateMatrix();
    const point = new THREE.Vector2();
    return (vertex) => {
      texture.transformUv(point.set(uv.getX(vertex), uv.getY(vertex)));
      const x = Math.min(255, Math.max(0, Math.floor(point.x * 256)));
      const y = Math.min(255, Math.max(0, Math.floor(point.y * 256)));
      const at = (y * 256 + x) * 4;
      return skinColor(pixels[at], pixels[at + 1], pixels[at + 2]);
    };
  } catch {
    return undefined;
  }
}

export function inferHandLandmarks(
  meshes: THREE.Mesh[],
  transforms: THREE.Matrix4[],
  bounds: THREE.Box3,
) {
  const probes = meshes.map(skinProbe);
  const h = bounds.max.y - bounds.min.y,
    center = bounds.getCenter(new THREE.Vector3());
  const candidates: THREE.Vector3[][] = [[], []];
  const p = new THREE.Vector3();
  meshes.forEach((mesh, index) => {
    const probe = probes[index];
    if (!probe) return;
    const positions = mesh.geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      p.fromBufferAttribute(positions, i).applyMatrix4(transforms[index]);
      const x = (p.x - center.x) / h,
        y = (p.y - bounds.min.y) / h,
        z = (p.z - center.z) / h;
      if (Math.abs(x) > 0.12 && Math.abs(x) < 0.35 && y > 0.12 && y < 0.5 && z > -0.08 && probe(i))
        candidates[x < 0 ? 0 : 1].push(p.clone());
    }
  });
  const hands = candidates.map((points) => {
    if (points.length < 8) return null;
    const low = points.reduce((minimum, point) => Math.min(minimum, point.y), Infinity);
    const cluster = points.filter((point) => point.y < low + h * 0.065);
    if (cluster.length < 8) return null;
    return cluster
      .reduce((sum, point) => sum.add(point), new THREE.Vector3())
      .divideScalar(cluster.length);
  });
  return { hands, probes };
}
