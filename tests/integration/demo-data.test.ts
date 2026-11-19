import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_CHARACTERS, type CharacterModel } from '../../packages/contracts/src/index';
import { prepareDemoData } from '../../scripts/demo-data';
import { makeGlb } from '../fixtures/character-model';
import { asciiStl, formatBundle } from '../fixtures/character-formats';

const scratch: string[] = [];
afterEach(async () => {
  for (const root of scratch.splice(0)) {
    const actual = await realpath(root);
    if (actual !== root || dirname(actual) !== (await realpath(tmpdir())))
      throw new Error('Unexpected demo test fixture location');
    await rm(actual, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-demo-test-')));
  scratch.push(root);
  const source = join(root, 'source');
  const assets = join(source, 'character-assets');
  const temp = join(root, 'temp');
  await mkdir(assets, { recursive: true });
  await mkdir(temp);
  const setProfiles = (
    models: Array<CharacterModel | Omit<CharacterModel, 'format'> | undefined>,
  ) =>
    writeFile(
      join(source, 'characters.json'),
      JSON.stringify({
        version: 1,
        characters: DEFAULT_CHARACTERS.map((profile, index) => ({
          ...profile,
          ...(models[index] && { model: models[index] }),
        })),
      }),
    );
  const expectedModel = (bytes: Buffer, format: CharacterModel['format']): CharacterModel => ({
    assetId: createHash('sha256').update(bytes).digest('hex'),
    filename: `character.${format}`,
    format,
    byteLength: bytes.length,
    triangleCount: 1,
    animationCount: 0,
    hasSkins: false,
  });
  return { assets, source, temp, setProfiles, expectedModel };
}

describe('demo character snapshot', () => {
  it('copies only referenced model bytes, preserving original configuration and supported legacy profiles', async () => {
    const f = await fixture();
    const glb = makeGlb();
    const stl = Buffer.from(formatBundle('stl', asciiStl));
    const { format: legacyFormat, ...legacy } = f.expectedModel(glb, 'glb');
    const packaged = f.expectedModel(stl, 'stl');
    const legacyFile = `${legacy.assetId}.${legacyFormat}`;
    const packagedFile = `${packaged.assetId}.${packaged.format}`;
    await f.setProfiles([legacy, packaged]);
    const original = await readFile(join(f.source, 'characters.json'));
    await writeFile(join(f.assets, legacyFile), glb);
    await writeFile(join(f.assets, packagedFile), stl);
    await writeFile(join(f.assets, 'unused.glb'), 'old asset');
    await writeFile(join(f.source, 'provider.json'), 'not copied');
    await writeFile(join(f.source, 'astrisle.sqlite'), 'not copied');
    const demo = await prepareDemoData(f.source, f.temp);
    try {
      expect(demo.expected).toEqual({
        mori: legacy.assetId,
        luma: packaged.assetId,
        user: 'builtin',
      });
      expect((await readdir(demo.root)).sort()).toEqual(['character-assets', 'characters.json']);
      expect((await readdir(join(demo.root, 'character-assets'))).sort()).toEqual(
        [legacyFile, packagedFile].sort(),
      );
      expect(await readFile(join(demo.root, 'character-assets', legacyFile))).toEqual(glb);
      expect(await readFile(join(demo.root, 'character-assets', packagedFile))).toEqual(stl);
      expect(await readFile(join(f.source, 'characters.json'))).toEqual(original);
    } finally {
      await demo.cleanup();
    }
    expect(await readdir(f.temp)).toEqual([]);
    expect(await readFile(join(f.assets, legacyFile))).toEqual(glb);
  });

  it('rejects a missing profile file instead of starting with built-in models', async () => {
    const f = await fixture();
    await expect(prepareDemoData(f.source, f.temp)).rejects.toThrow('characters.json');
    expect(await readdir(f.temp)).toEqual([]);
  });

  it.each(['missing', 'changed', 'mismatched format'])(
    'rejects a configured asset that is %s before launch and cleans its copy',
    async (problem) => {
      const f = await fixture();
      const glb = makeGlb();
      const model = f.expectedModel(glb, problem === 'mismatched format' ? 'stl' : 'glb');
      await f.setProfiles([model]);
      if (problem !== 'missing')
        await writeFile(
          join(f.assets, `${model.assetId}.${model.format}`),
          problem === 'changed' ? Buffer.alloc(glb.length, 0x61) : glb,
        );
      await expect(prepareDemoData(f.source, f.temp)).rejects.toThrow('mori');
      expect(await readdir(f.temp)).toEqual([]);
    },
  );
});
