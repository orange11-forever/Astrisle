import { test, expect } from '@playwright/test';
import { makeGlb } from '../fixtures/character-model';

test('character names update current labels and survive reload; imports expose static model details', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(
    (bytes) => {
      const defaults = [
        { id: 'mori', displayName: 'Mori' },
        { id: 'luma', displayName: 'Luma' },
        { id: 'user', displayName: '我' },
      ];
      const read = () =>
        JSON.parse(localStorage.getItem('test-character-profiles') || JSON.stringify(defaults));
      const write = (profiles: unknown) =>
        localStorage.setItem('test-character-profiles', JSON.stringify(profiles));
      window.astrisle = {
        bootstrap: async () => ({
          workspaces: [],
          commissions: [],
          characters: read(),
          provider: {
            kind: 'openai-compatible',
            baseUrl: '',
            model: '',
            configured: false,
            hasApiKey: false,
          },
          capabilities: [],
          version: 'fixture',
        }),
        updateCharacter: async (
          id: string,
          patch: { displayName?: string; resetModel?: boolean; rotationY?: number },
        ) => {
          const profiles = read();
          const profile = profiles.find((item: { id: string }) => item.id === id);
          if (patch.displayName) profile.displayName = patch.displayName;
          if (patch.resetModel) delete profile.model;
          if (patch.rotationY !== undefined) profile.rotationY = patch.rotationY;
          write(profiles);
          return profile;
        },
        importCharacter: async (id: string) => {
          const profiles = read();
          const profile = profiles.find((item: { id: string }) => item.id === id);
          profile.model = {
            assetId: 'fixture-asset',
            filename: 'embedded-avatar.glb',
            format: 'glb',
            byteLength: bytes.length,
            triangleCount: 1,
            animationCount: 0,
            hasSkins: false,
          };
          write(profiles);
          return profile;
        },
        loadCharacterModel: async () => new Uint8Array(bytes),
        onSnapshot: () => () => {},
      } as unknown as NonNullable<Window['astrisle']>;
    },
    [...makeGlb()],
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: '工作室设置', exact: true }).click();
  await page.getByLabel('Mori 的显示名称').fill('小蓝');
  await page.getByRole('button', { name: '保存 Mori 的名称', exact: true }).click();
  await expect(page.getByLabel('小蓝 的显示名称')).toHaveValue('小蓝');
  await page.getByLabel('角色特写').selectOption('mori');
  await expect(page.getByRole('heading', { name: '小蓝的角色特写' })).toBeVisible();
  await page.getByRole('button', { name: '为小蓝导入模型', exact: true }).click();
  await expect(page.getByText('embedded-avatar.glb', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('静态模型：角色整体移动，不包含骨骼动画。')).toBeVisible();
  await expect(page.getByText(/角色加载失败/)).toHaveCount(0);
  for (const [rotationY, radians] of [
    ['90', Math.PI / 2],
    ['270', Math.PI * 1.5],
  ] as const) {
    await page.getByLabel('小蓝 的模型朝向').selectOption(rotationY);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const moduleUrl = performance
            .getEntriesByType('resource')
            .find((entry) => entry.name.includes('/@react-three_fiber.js'))?.name;
          if (!moduleUrl) return null;
          const { _roots } = await import(moduleUrl);
          const scene = _roots.get(document.querySelector('canvas'))?.store.getState().scene;
          const imported = scene?.getObjectByName('Imported_character_normalized');
          return imported?.parent?.parent?.rotation.y ?? null;
        }),
      )
      .toBeCloseTo(radians);
  }
  await page.reload();
  await page.getByRole('button', { name: '工作室设置', exact: true }).click();
  await expect(page.getByLabel('小蓝 的显示名称')).toHaveValue('小蓝');
  await expect(page.getByLabel('小蓝 的模型朝向')).toHaveValue('270');
  await page.getByRole('button', { name: '重置小蓝的模型', exact: true }).click();
  await expect(page.getByText('embedded-avatar.glb', { exact: false })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('reimporting the same asset recovers a failed character without reloading or switching views', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(
    (bytes) => {
      const profiles = [
        {
          id: 'mori',
          displayName: 'Mori',
          model: {
            assetId: 'same-asset',
            filename: 'avatar.glb',
            format: 'glb',
            byteLength: bytes.length,
            triangleCount: 1,
            animationCount: 0,
            hasSkins: false,
          },
        },
        { id: 'luma', displayName: 'Luma' },
        { id: 'user', displayName: '我' },
      ];
      let repaired = false;
      window.astrisle = {
        bootstrap: async () => ({
          workspaces: [],
          commissions: [],
          characters: structuredClone(profiles),
          provider: {
            kind: 'openai-compatible',
            baseUrl: '',
            model: '',
            configured: false,
            hasApiKey: false,
          },
          capabilities: [],
          version: 'fixture',
        }),
        importCharacter: async (id: string) => {
          const profile = profiles.find((item) => item.id === id)! as (typeof profiles)[number] & {
            modelRevision?: number;
          };
          repaired = true;
          profile.modelRevision = (profile.modelRevision || 0) + 1;
          return structuredClone(profile);
        },
        loadCharacterModel: async () => {
          if (!repaired) throw new Error('missing private asset');
          return new Uint8Array(bytes);
        },
        onSnapshot: () => () => {},
      } as unknown as NonNullable<Window['astrisle']>;
    },
    [...makeGlb()],
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(
    page.getByText('角色加载失败：missing private asset', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '工作室设置', exact: true }).click();
  await page.getByRole('button', { name: '为Mori导入模型', exact: true }).click();
  await expect(page.getByText(/角色加载失败/)).toHaveCount(0);
  // Read the already loaded development renderer, without adding a production test hook.
  // A mounted real three-vertex mesh proves recovery beyond merely hiding the error text.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const moduleUrl = performance
          .getEntriesByType('resource')
          .find((entry) => entry.name.includes('/@react-three_fiber.js'))?.name;
        if (!moduleUrl) return null;
        const { _roots } = await import(moduleUrl);
        const scene = _roots.get(document.querySelector('canvas'))?.store.getState().scene;
        const imported = scene?.getObjectByName('Imported_character_normalized');
        return (
          imported?.getObjectByProperty('isMesh', true)?.geometry.getAttribute('position').count ??
          null
        );
      }),
    )
    .toBe(3);
  await expect(page.getByRole('button', { name: '为Mori导入模型', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});
