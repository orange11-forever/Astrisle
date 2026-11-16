import { expect, test } from '@playwright/test';
import {
  asciiFbx,
  asciiStl,
  binaryFbx,
  binaryStl,
  formatBundle,
  texturedFbx,
  threeMf,
} from '../fixtures/character-formats';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZFEAAAAASUVORK5CYII=';
const texturedObj = formatBundle(
  'obj',
  'mtllib avatar.mtl\nv 0 0 0\nv 1 0 0\nv 0 2 0\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl blue\nf 1/1 2/2 3/3\n',
  {
    'avatar.mtl': Buffer.from('newmtl blue\nKd 0.1 0.2 0.8\nmap_Kd texture.png\n').toString(
      'base64',
    ),
    'texture.png': png,
  },
);

for (const [name, bytes, animations, textured] of [
  ['ASCII STL', formatBundle('stl', asciiStl), 0, false],
  ['binary STL', formatBundle('stl', binaryStl()), 0, false],
  ['OBJ with MTL and PNG', texturedObj, 0, true],
  ['3MF with base material', formatBundle('3mf', threeMf()), 0, false],
  ['3MF with embedded PNG', formatBundle('3mf', threeMf({ texture: png })), 0, true],
  ['FBX with translation animation', formatBundle('fbx', asciiFbx), 1, false],
  ['binary FBX', formatBundle('fbx', binaryFbx()), 0, false],
  ['FBX with embedded PNG', formatBundle('fbx', texturedFbx(png)), 1, true],
  ['FBX with companion PNG', formatBundle('fbx', texturedFbx(), { 'texture.png': png }), 1, true],
] as const) {
  test(`browser loads ${name} as a shared grounded character`, async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(
      async (raw) => {
        const moduleUrl = '/src/characters/model-cache.ts';
        const { createCharacterModelCache, inspectCharacterImport } = await import(moduleUrl);
        const data = new Uint8Array(raw);
        const inspection = await inspectCharacterImport(data);
        const cache = createCharacterModelCache(async () => data);
        const a = cache.acquire('asset'),
          b = cache.acquire('asset');
        const model = await a.ready;
        const instance = model.instantiate(),
          second = (await b.ready).instantiate();
        const mesh = instance.getObjectByProperty('isMesh', true),
          other = second.getObjectByProperty('isMesh', true);
        const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        const result = {
          inspection,
          shared: mesh.geometry === other.geometry,
          textured: !!material.map?.image,
          color: material.color.getHexString(),
        };
        a.release();
        b.release();
        return result;
      },
      [...bytes],
    );
    expect(result.inspection).toEqual({
      triangleCount: 1,
      animationCount: animations,
      hasSkins: false,
    });
    expect(result.shared).toBe(true);
    expect(result.textured).toBe(textured);
    if (name === '3MF with base material' || name === 'OBJ with MTL and PNG')
      expect(result.color).toBe('1a33cc');
  });
}

test('browser refuses missing or corrupt textures rather than displaying a silent material fallback', async ({
  page,
}) => {
  await page.goto('/');
  const results = await page.evaluate(
    async (raw) => {
      const moduleUrl = '/src/characters/model-cache.ts';
      const { inspectCharacterImport } = await import(moduleUrl);
      const source = JSON.parse(new TextDecoder().decode(new Uint8Array(raw)));
      const errors: string[] = [];
      for (const value of [undefined, 'bm90LWEtcG5n']) {
        if (value) source.files['texture.png'] = value;
        else delete source.files['texture.png'];
        try {
          await inspectCharacterImport(new TextEncoder().encode(JSON.stringify(source)));
        } catch (error) {
          errors.push(String(error));
        }
      }
      return errors;
    },
    [...texturedObj],
  );
  expect(results).toHaveLength(2);
  expect(results[0]).toMatch(/资源缺失/);
  expect(results[1]).toMatch(/贴图读取失败/);
});

test('3MF data-only implicit functions are reported before accepting the remaining mesh', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(
    async (raw) => {
      const url = '/src/characters/model-cache.ts';
      const { inspectCharacterImport } = await import(url);
      try {
        await inspectCharacterImport(new Uint8Array(raw));
        return '';
      } catch (error) {
        return String(error);
      }
    },
    [...formatBundle('3mf', threeMf({ implicit: true }))],
  );
  expect(result).toMatch(/不支持.*Implicit Functions/);
});
test('3MF unsupported resource errors reject a partially retained mesh', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(
    async (raw) => {
      const url = '/src/characters/model-cache.ts';
      const { inspectCharacterImport } = await import(url);
      try {
        await inspectCharacterImport(new Uint8Array(raw));
        return '';
      } catch (error) {
        return String(error);
      }
    },
    [...formatBundle('3mf', threeMf({ unsupportedResource: true }))],
  );
  expect(result).toMatch(/不支持.*Unsupported resource type/);
});

test('settings inspects staged bytes before committing and retains the previous character on failure', async ({
  page,
}) => {
  const broken = JSON.parse(new TextDecoder().decode(texturedObj));
  broken.files['texture.png'] = 'bm90LWEtcG5n';
  await page.addInitScript(
    ({ valid, invalid }) => {
      const profiles = [
        { id: 'mori', displayName: 'Mori' },
        { id: 'luma', displayName: 'Luma' },
        { id: 'user', displayName: '我' },
      ] as import('@astrisle/contracts').CharacterProfile[];
      let selected = 0,
        commits = 0,
        cancels = 0;
      const count = () => {
        localStorage.setItem('import-counts', JSON.stringify({ commits, cancels }));
      };
      window.astrisle = {
        bootstrap: async () => ({
          workspaces: [],
          commissions: [],
          characters: profiles,
          capabilities: [],
          version: 'fixture',
          provider: {
            kind: 'openai-compatible',
            baseUrl: '',
            model: '',
            configured: false,
            hasApiKey: false,
          },
        }),
        prepareCharacterImport: async () => ({
          importId: `token-${selected}`,
          bytes: new Uint8Array(selected++ === 0 ? valid : invalid),
        }),
        completeCharacterImport: async (
          id: import('@astrisle/contracts').CharacterId,
          _token: string,
          inspection: import('@astrisle/contracts').CharacterImportInspection,
        ) => {
          commits++;
          count();
          const profile = profiles.find((profile) => profile.id === id)!;
          profile.model = {
            assetId: 'verified-obj',
            filename: 'verified.obj',
            format: 'obj',
            byteLength: valid.length,
            ...inspection,
          };
          return profile;
        },
        cancelCharacterImport: async () => {
          cancels++;
          count();
        },
        loadCharacterModel: async () => new Uint8Array(valid),
        onSnapshot: () => () => {},
      } as unknown as NonNullable<Window['astrisle']>;
    },
    { valid: [...texturedObj], invalid: [...new TextEncoder().encode(JSON.stringify(broken))] },
  );
  await page.goto('/');
  await page.getByRole('button', { name: '工作室设置', exact: true }).click();
  await page.getByRole('button', { name: '为Mori导入模型', exact: true }).click();
  await expect(page.getByText('verified.obj', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('import-counts')!))).toEqual({
    commits: 1,
    cancels: 1,
  });
  await page.getByRole('button', { name: '为Mori导入模型', exact: true }).click();
  await expect(page.getByText(/模型贴图读取失败/).first()).toBeVisible();
  await expect(page.getByText('verified.obj', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('import-counts')!))).toEqual({
    commits: 1,
    cancels: 2,
  });
});
