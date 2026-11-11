import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CharacterStore, validateCharacterModel } from '../../apps/desktop/src/characters';
import { characterBytes, characterDocument, makeGlb } from '../fixtures/character-model';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'astrisle-characters-'));
  directories.push(directory);
  const source = join(directory, 'my-avatar.glb');
  const bytes = makeGlb();
  await writeFile(source, bytes);
  return { directory, source, bytes, store: new CharacterStore(join(directory, 'profile')) };
}

describe('private local character profiles', () => {
  it('copies an import durably and loads it after the original is moved', async () => {
    const { directory, source, bytes, store } = await fixture();
    const profile = await store.importFile('mori', source);
    expect(profile.model).toMatchObject({
      filename: 'my-avatar.glb',
      format: 'glb',
      byteLength: bytes.length,
      triangleCount: 1,
      animationCount: 0,
      hasSkins: false,
    });
    expect(await readFile(source)).toEqual(bytes);
    await rename(source, join(directory, 'moved.glb'));
    const reopened = new CharacterStore(join(directory, 'profile'));
    expect((await reopened.profiles())[0].model).toEqual(profile.model);
    expect(Buffer.from(await reopened.loadModel(profile.model!.assetId))).toEqual(bytes);
    const saved = await readFile(join(directory, 'profile', 'characters.json'), 'utf8');
    expect(saved).not.toContain(source);
    expect(saved.length).toBeLessThan(2000);
  });

  it('shares content-addressed assets while retaining independent names and reset choices', async () => {
    const { directory, source, store } = await fixture();
    const a = await store.importFile('mori', source);
    const b = await store.importFile('luma', source);
    expect(a.model!.assetId).toBe(b.model!.assetId);
    await Promise.all([
      store.update('mori', { displayName: '  小蓝  ' }),
      store.update('user', { displayName: '我自己', rotationY: 180 }),
    ]);
    const profiles = await new CharacterStore(join(directory, 'profile')).profiles();
    expect(profiles.map((p) => [p.id, p.displayName])).toEqual([
      ['mori', '小蓝'],
      ['luma', 'Luma'],
      ['user', '我自己'],
    ]);
    expect(profiles[2].rotationY).toBe(180);
    const reset = await store.update('mori', { resetModel: true });
    expect(reset.model).toBeUndefined();
    expect(reset.displayName).toBe('小蓝');
    expect(await store.loadModel(b.model!.assetId)).toHaveLength(makeGlb().length);
    expect(await readdir(join(directory, 'profile', 'character-assets'))).toEqual([
      `${a.model!.assetId}.glb`,
    ]);
  });

  it('rejects unknown IDs, invalid names, arbitrary paths, and unregistered hashes', async () => {
    const { source, store } = await fixture();
    await expect(store.importFile('../mori', source)).rejects.toThrow();
    await expect(store.update('other', { displayName: 'Test' })).rejects.toThrow();
    for (const displayName of ['', '  ', 'a'.repeat(41), 'bad\nname', 'bad\u0000name']) {
      await expect(store.update('mori', { displayName })).rejects.toThrow();
    }
    await expect(store.loadModel('../../outside')).rejects.toThrow();
    await expect(store.loadModel('a'.repeat(64))).rejects.toThrow();
  });

  it('persists quarter-turn orientations without changing the model and rejects other angles', async () => {
    const { directory, source, bytes, store } = await fixture();
    const imported = await store.importFile('mori', source);
    for (const rotationY of [0, 90, 180, 270]) {
      await store.update('mori', { rotationY });
      const saved = (await new CharacterStore(join(directory, 'profile')).profiles())[0];
      expect(saved.rotationY).toBe(rotationY);
      expect(saved.model).toEqual(imported.model);
      expect(saved.modelRevision).toBe(imported.modelRevision);
    }
    await expect(store.update('mori', { rotationY: 91 })).rejects.toThrow();
    expect((await store.profiles())[0].rotationY).toBe(270);
    expect(Buffer.from(await store.loadModel(imported.model!.assetId))).toEqual(bytes);
    expect(await readFile(source)).toEqual(bytes);
  });

  it('retains the previous model when replacement validation fails', async () => {
    const { directory, source, store } = await fixture();
    const first = await store.importFile('mori', source);
    const broken = join(directory, 'broken.glb');
    await writeFile(broken, 'not a model');
    await expect(store.importFile('mori', broken)).rejects.toThrow();
    expect((await store.profiles())[0]).toEqual(first);
  });

  it('does not load a private asset that was modified after import', async () => {
    const { directory, source, store } = await fixture();
    const profile = await store.importFile('mori', source);
    await writeFile(
      join(directory, 'profile', 'character-assets', `${profile.model!.assetId}.glb`),
      'changed',
    );
    await expect(store.loadModel(profile.model!.assetId)).rejects.toThrow(/校验/);
  });

  it('persists a new import revision when the same source repairs a damaged cached copy', async () => {
    const { directory, source, bytes, store } = await fixture();
    const first = await store.importFile('mori', source);
    const profilePath = join(directory, 'profile', 'characters.json');
    // Existing profiles predate the retry token and must remain readable.
    const legacy = JSON.parse(await readFile(profilePath, 'utf8'));
    delete legacy.characters[0].modelRevision;
    await writeFile(profilePath, JSON.stringify(legacy));
    const reopened = new CharacterStore(join(directory, 'profile'));
    expect((await reopened.profiles())[0].modelRevision).toBeUndefined();
    await writeFile(
      join(directory, 'profile', 'character-assets', `${first.model!.assetId}.glb`),
      'damaged',
    );
    await expect(reopened.loadModel(first.model!.assetId)).rejects.toThrow(/校验/);
    const repaired = await reopened.importFile('mori', source);
    expect(repaired.model!.assetId).toBe(first.model!.assetId);
    expect(repaired.modelRevision).toBe(1);
    expect(Buffer.from(await reopened.loadModel(first.model!.assetId))).toEqual(bytes);
    const next = await reopened.importFile('mori', source);
    expect(next.modelRevision).toBe(2);
    await reopened.update('mori', { displayName: '小蓝' });
    expect((await new CharacterStore(join(directory, 'profile')).profiles())[0]).toMatchObject({
      id: 'mori',
      displayName: '小蓝',
      modelRevision: 2,
    });
  });
});

describe('embedded glTF 2 validation', () => {
  it('accepts GLB and self-contained JSON glTF without external requests', () => {
    expect(validateCharacterModel(makeGlb(), 'avatar.glb').triangleCount).toBe(1);
    const document = characterDocument();
    document.buffers[0].uri = `data:application/octet-stream;base64,${characterBytes().toString('base64')}`;
    expect(
      validateCharacterModel(Buffer.from(JSON.stringify(document)), 'avatar.gltf').format,
    ).toBe('gltf');
  });

  it.each([
    'https://example.com/a.bin',
    '../outside.bin',
    '/private/a.bin',
    'C:\\secret.bin',
    'file:///etc/passwd',
    '//server/image.png',
    'data:text/html;base64,PHNjcmlwdD4=',
  ])('rejects a non-embedded resource: %s', (uri) => {
    const document = { ...characterDocument(), images: [{ uri }] };
    expect(() => validateCharacterModel(makeGlb(document), 'avatar.glb')).toThrow(/内嵌|embedded/);
  });

  it.each([
    'KHR_draco_mesh_compression',
    'EXT_meshopt_compression',
    'KHR_meshopt_compression',
    'KHR_texture_basisu',
  ])('explains unsupported compression: %s', (extension) => {
    const document = { ...characterDocument(), extensionsUsed: [extension] };
    expect(() => validateCharacterModel(makeGlb(document), 'avatar.glb')).toThrow(
      /压缩|compression/,
    );
  });

  it('rejects malformed binaries, unsupported versions, and out-of-bounds buffers', () => {
    const truncated = makeGlb().subarray(0, -4);
    expect(() => validateCharacterModel(truncated, 'avatar.glb')).toThrow();
    expect(() => validateCharacterModel(makeGlb(), 'avatar.fbx')).toThrow(/GLB|glTF/);
    expect(() =>
      validateCharacterModel(
        makeGlb({ ...characterDocument(), asset: { version: '1.0' } }),
        'avatar.glb',
      ),
    ).toThrow();
    const invalid = characterDocument();
    invalid.bufferViews[0].byteLength = 9999;
    expect(() => validateCharacterModel(makeGlb(invalid), 'avatar.glb')).toThrow();
    expect(() =>
      validateCharacterModel(
        makeGlb({ ...characterDocument(), extensionsRequired: ['UNKNOWN_extension'] }),
        'avatar.glb',
      ),
    ).toThrow(/扩展|extension/);
  });
});
