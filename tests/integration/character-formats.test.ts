import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CharacterStore } from '../../apps/desktop/src/characters';
import { createCharacterModelCache } from '../../apps/client/src/characters/model-cache';
import { inspectCharacterImport } from '../../apps/client/src/characters/model-cache';
import * as THREE from 'three';
import { asciiStl, binaryFbx, binaryStl, threeMf } from '../fixtures/character-formats';

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
const obj = 'mtllib avatar.mtl\nv 0 0 0\nv 1 0 0\nv 0 2 0\nusemtl blue\nf 1 2 3\n';
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'astrisle-formats-'));
  folders.push(folder);
  await writeFile(join(folder, 'avatar.obj'), obj);
  await writeFile(join(folder, 'avatar.mtl'), 'newmtl blue\nKd 0.1 0.2 0.8\n');
  return { folder, store: new CharacterStore(join(folder, 'profile'), inspectCharacterImport) };
}
it('stages a real OBJ with MTL, verifies it through the shared loader, and persists a portable model', async () => {
  const { folder, store } = await fixture();
  const pending = await store.prepareImport('mori', join(folder, 'avatar.obj'));
  expect((await store.profiles())[0].model).toBeUndefined();
  const cache = createCharacterModelCache(async () => pending.bytes);
  const lease = cache.acquire('obj');
  const model = await lease.ready;
  const mesh = model.instantiate().getObjectByProperty('isMesh', true) as THREE.Mesh;
  expect((mesh.material as THREE.MeshPhongMaterial).color.getHexString()).toBe('1a33cc');
  const profile = await store.completeImport('mori', pending.importId, {
    triangleCount: 1,
    animationCount: 0,
    hasSkins: false,
  });
  await rm(join(folder, 'avatar.obj'));
  await rm(join(folder, 'avatar.mtl'));
  const reopened = new CharacterStore(join(folder, 'profile'));
  expect((await reopened.profiles())[0].model).toEqual(profile.model);
  expect(await reopened.loadModel(profile.model!.assetId)).toEqual(pending.bytes);
  await expect(
    store.completeImport('mori', pending.importId, {
      triangleCount: 1,
      animationCount: 0,
      hasSkins: false,
    }),
  ).rejects.toThrow();
  lease.release();
});
it('binds pending imports to their character, cancels without replacement and rejects invalid metadata', async () => {
  const { folder, store } = await fixture();
  const pending = await store.prepareImport('mori', join(folder, 'avatar.obj'));
  await expect(
    store.completeImport('luma', pending.importId, {
      triangleCount: 1,
      animationCount: 0,
      hasSkins: false,
    }),
  ).rejects.toThrow();
  await expect(
    store.completeImport('mori', pending.importId, {
      triangleCount: 0,
      animationCount: 0,
      hasSkins: false,
    }),
  ).rejects.toThrow();
  await store.cancelImport(pending.importId);
  await expect(
    store.completeImport('mori', pending.importId, {
      triangleCount: 1,
      animationCount: 0,
      hasSkins: false,
    }),
  ).rejects.toThrow();
  expect((await store.profiles())[0].model).toBeUndefined();
});
it.each([
  '../outside.mtl',
  '/private.mtl',
  'https://example.com/a.mtl',
  'C:\\secret.mtl',
  '%2e%2e/outside.mtl',
])('rejects OBJ resource traversal or remote references: %s', async (resource) => {
  const { folder, store } = await fixture();
  await writeFile(join(folder, 'avatar.obj'), obj.replace('avatar.mtl', resource));
  await expect(store.prepareImport('mori', join(folder, 'avatar.obj'))).rejects.toThrow(
    /资源|路径/,
  );
});
it('reports a missing MTL or texture before replacing a character', async () => {
  const { folder, store } = await fixture();
  await writeFile(join(folder, 'avatar.mtl'), 'newmtl blue\nmap_Kd missing.png\n');
  await expect(store.prepareImport('mori', join(folder, 'avatar.obj'))).rejects.toThrow(
    /missing.png/,
  );
  expect((await store.profiles())[0].model).toBeUndefined();
});
it('explains unsupported MTL texture channels instead of silently dropping them', async () => {
  const { folder, store } = await fixture();
  await writeFile(join(folder, 'avatar.mtl'), 'newmtl blue\nmap_Pr texture.png\n');
  await writeFile(join(folder, 'texture.png'), 'fixture image bytes');
  await expect(store.prepareImport('mori', join(folder, 'avatar.obj'))).rejects.toThrow(
    /不支持.*map_pr/i,
  );
});
it('rejects 3MF archive resource traversal and unsupported required extensions', async () => {
  const { folder, store } = await fixture();
  const path = join(folder, 'avatar.3mf');
  for (const bytes of [
    threeMf({ resource: '../outside.model' }),
    threeMf({ required: 'unknown' }),
  ]) {
    await writeFile(path, bytes);
    await expect(store.prepareImport('mori', path)).rejects.toThrow(/路径|扩展/);
  }
});
it('rejects a material symlink pointing outside the selected source folder', async () => {
  const { folder, store } = await fixture();
  const models = join(folder, 'models');
  await mkdir(models);
  await writeFile(join(models, 'avatar.obj'), obj.replace('avatar.mtl', 'assets/avatar.mtl'));
  await symlink(folder, join(models, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(store.prepareImport('mori', join(models, 'avatar.obj'))).rejects.toThrow(/路径/);
});
it('bounds FBX binary arrays and rejects broken node offsets before sending bytes to a renderer', async () => {
  const { folder, store } = await fixture();
  const path = join(folder, 'avatar.fbx');
  const oversized = binaryFbx();
  oversized.writeUInt32LE(0xffffffff, oversized.indexOf('Vertices') + 'Vertices'.length + 1);
  const broken = binaryFbx();
  broken.writeUInt32LE(0xffffffff, 27);
  for (const bytes of [oversized, broken]) {
    await writeFile(path, bytes);
    await expect(store.prepareImport('mori', path)).rejects.toThrow(/FBX/);
  }
});
it('rejects binary STL whose declared triangle array does not fit the source', async () => {
  const { folder, store } = await fixture();
  const bytes = binaryStl();
  new DataView(bytes.buffer).setUint32(80, 0xffffffff, true);
  const path = join(folder, 'avatar.stl');
  await writeFile(path, bytes);
  await expect(store.prepareImport('mori', path)).rejects.toThrow(/STL/);
});
it.each([
  ['ASCII STL', 'stl', new TextEncoder().encode(asciiStl)],
  ['binary STL', 'stl', binaryStl()],
  ['binary FBX', 'fbx', binaryFbx()],
  ['3MF', '3mf', threeMf()],
] as const)(
  'persists %s bundles independently of the original source',
  async (_name, format, bytes) => {
    const { folder } = await fixture();
    // This row verifies durable storage transport. 3MF's DOM-dependent inspection
    // runs in the real Electron validator and browser tests instead of Node.
    const store = new CharacterStore(
      join(folder, 'profile'),
      format === '3mf'
        ? async () => ({ triangleCount: 1, animationCount: 0, hasSkins: false })
        : inspectCharacterImport,
    );
    const source = join(folder, `source.${format}`);
    await writeFile(source, bytes);
    const pending = await store.prepareImport('user', source);
    const saved = await store.completeImport('user', pending.importId, {
      triangleCount: 1,
      animationCount: 0,
      hasSkins: false,
    });
    await rm(source);
    const reopened = new CharacterStore(join(folder, 'profile'));
    expect((await reopened.profiles())[2].model).toMatchObject({
      assetId: saved.model!.assetId,
      format,
    });
    expect(await reopened.loadModel(saved.model!.assetId)).toEqual(pending.bytes);
  },
);
