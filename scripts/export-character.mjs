import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Box3, Vector3 } from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// GLTFExporter uses FileReader for Blob conversion, even when no textures exist.
// Keep this polyfill scoped to this Node-only export tool, never the application.
globalThis.FileReader ??= class FileReader {
  result = null;
  onloadend = null;
  onerror = null;

  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then(
      (result) => {
        this.result = result;
        this.onloadend?.();
      },
      (error) => this.onerror?.(error),
    );
  }

  readAsDataURL(blob) {
    blob.arrayBuffer().then(
      (result) => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(result).toString('base64')}`;
        this.onloadend?.();
      },
      (error) => this.onerror?.(error),
    );
  }
};

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(project, 'apps/client/public/models/blue-whale-girl.glb');
const compiled = await build({
  entryPoints: [resolve(project, 'apps/client/src/characters/blue-whale-girl.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  write: false,
  logLevel: 'warning',
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`;
const { createBlueWhaleGirl } = await import(moduleUrl);
const character = createBlueWhaleGirl();
const bounds = new Box3().setFromObject(character.root);
let triangles = 0;
let meshes = 0;
const breakdown = [];
character.root.traverse((object) => {
  if (!object.isMesh) return;
  meshes++;
  const position = object.geometry.getAttribute('position');
  const normal = object.geometry.getAttribute('normal');
  if (
    !Array.from(position.array).every(Number.isFinite) ||
    !Array.from(normal.array).every(Number.isFinite)
  ) {
    throw new Error(`Non-finite geometry: ${object.name}`);
  }
  const count = (object.geometry.index?.count ?? position.count) / 3;
  triangles += count;
  breakdown.push({ name: object.name, triangles: count });
});
// Broad sampled hair/cloth surfaces and explicit contour shells replace the
// rejected primitive doll. Keep the extra silhouette fidelity bounded for 3 avatars.
if (meshes >= 100 || triangles >= 65000) {
  console.table(breakdown.sort((a, b) => b.triangles - a.triangles));
  throw new Error(`Character exceeds render budget: ${meshes} meshes, ${triangles} triangles`);
}
if (bounds.min.y < -0.002 || bounds.max.y > 1.95)
  throw new Error('Invalid character ground or scale');

const exported = await new GLTFExporter().parseAsync(character.root, {
  binary: true,
  onlyVisible: true,
  trs: true,
});
if (!(exported instanceof ArrayBuffer)) throw new Error('Exporter did not produce binary glTF');
const glb = Buffer.from(exported);
if (
  glb.readUInt32LE(0) !== 0x46546c67 ||
  glb.readUInt32LE(4) !== 2 ||
  glb.readUInt32LE(8) !== glb.length
) {
  throw new Error('Invalid GLB 2.0 header or byte length');
}
const jsonLength = glb.readUInt32LE(12);
if (glb.readUInt32LE(16) !== 0x4e4f534a) throw new Error('Missing glTF JSON chunk');
const manifest = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));
if (manifest.images?.length || manifest.buffers.some((buffer) => buffer.uri)) {
  throw new Error('Character must be self-contained, with no textures or external buffers');
}
if (manifest.nodes.some((node) => /tail|fluke/i.test(node.name ?? '') && node.mesh !== undefined)) {
  throw new Error('The requested character must not contain visible tail geometry');
}
if (!manifest.nodes.some((node) => node.extras?.characterDesignLicense === 'CC BY-NC-SA 4.0')) {
  throw new Error('Character design attribution is missing from the GLB');
}
if (!manifest.extensionsUsed?.includes('KHR_materials_unlit')) {
  throw new Error('Painted anime materials lost their portable unlit representation');
}
// Verify the artifact with a real glTF consumer as well as checking its container.
const imported = await new GLTFLoader().parseAsync(exported, '');
const importedBounds = new Box3().setFromObject(imported.scene);
let importedTriangles = 0;
imported.scene.traverse((object) => {
  if (!object.isMesh) return;
  const position = object.geometry.getAttribute('position');
  if (!Array.from(position.array).every(Number.isFinite))
    throw new Error(`Invalid imported positions: ${object.name}`);
  importedTriangles += (object.geometry.index?.count ?? position.count) / 3;
});
if (importedTriangles !== triangles) throw new Error('The GLB round trip changed triangle count');
if (
  importedBounds.min.distanceTo(bounds.min) > 0.00001 ||
  importedBounds.max.distanceTo(bounds.max) > 0.00001
) {
  throw new Error('Exported geometry changed its bounds during the glTF round trip');
}
for (const joint of Object.values(character.joints)) {
  if (!imported.scene.getObjectByName(joint.name)) {
    throw new Error(`Missing exported animation pivot: ${joint.name}`);
  }
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, glb);
character.dispose();
console.log(
  JSON.stringify(
    {
      output,
      format: 'glTF 2.0 binary',
      bytes: glb.length,
      meshes,
      triangles,
      materials: manifest.materials.length,
      nodes: manifest.nodes.length,
      bounds: {
        min: bounds.min.toArray(),
        max: bounds.max.toArray(),
        size: bounds.getSize(new Vector3()).toArray(),
      },
      textures: manifest.images?.length ?? 0,
      tail: 'omitted by user request',
      characterDesignLicense: 'CC BY-NC-SA 4.0',
      roundTrip: 'GLTFLoader retained bounds and every named animation pivot',
    },
    null,
    2,
  ),
);
