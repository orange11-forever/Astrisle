import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function openStudio(page: Page, viewport = { width: 1440, height: 960 }) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(viewport);
  await page.goto('/');
  await expect(page.locator('.studio-canvas canvas')).toBeVisible();
  return errors;
}

async function cameraAngle(page: Page) {
  return page.evaluate(async () => {
    const moduleUrl = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/@react-three_fiber.js'))?.name;
    if (!moduleUrl) return null;
    const { _roots } = await import(moduleUrl);
    const state = _roots.get(document.querySelector('canvas'))?.store.getState();
    return state?.gl.info.render.frame > 0 ? (state.controls?.getAzimuthalAngle() ?? null) : null;
  });
}
test('animated-mode closeups keep the selected character at its own home across switches', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await page.bringToFront();
  for (const [id, x, z] of [
    ['mori', -3.45, 1.2],
    ['luma', 3.45, 1.2],
    ['user', 0, 3.65],
  ] as const) {
    await page.getByLabel('角色特写').selectOption(id);
    const read = () =>
      page.evaluate(async (id) => {
        const url = performance
          .getEntriesByType('resource')
          .find((entry) => entry.name.includes('/@react-three_fiber.js'))?.name;
        if (!url) return null;
        const { _roots } = await import(url),
          state = _roots.get(document.querySelector('canvas'))?.store.getState();
        return {
          position: state?.scene.getObjectByName(`avatar-${id}`)?.position.toArray(),
          frame: state?.gl.info.render.frame ?? 0,
        };
      }, id);
    const first = await read();
    await expect
      .poll(async () => (await read())?.frame ?? 0)
      .toBeGreaterThan((first?.frame ?? 0) + 1);
    expect((await read())?.position).toEqual([x, 0.02, z]);
  }
});

test('whale companions have selectable closeups and can return to the studio overview', async ({
  page,
}) => {
  const errors = await openStudio(page);
  const focus = page.getByLabel('角色特写');
  await expect(focus).toBeVisible();
  for (const [id, name] of [
    ['mori', 'Mori'],
    ['luma', 'Luma'],
    ['user', '我'],
  ] as const) {
    await focus.selectOption(id);
    await expect(page.getByText(`${name} · 拖动旋转，滚轮缩放`, { exact: true })).toBeVisible();
    await expect(page.locator('.studio-canvas canvas')).toBeVisible();
    const expected =
      id === 'mori' ? [-3.45, 0.02, 1.2] : id === 'luma' ? [3.45, 0.02, 1.2] : [0, 0.02, 3.65];
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const url = performance
            .getEntriesByType('resource')
            .find((entry) => entry.name.includes('/@react-three_fiber.js'))?.name;
          if (!url) return null;
          const { _roots } = await import(url);
          return _roots
            .get(document.querySelector('canvas'))
            ?.store.getState()
            .scene.getObjectByName(`avatar-${id}`)
            ?.position.toArray();
        }, id),
      )
      .toEqual(expected);
  }
  await page.getByRole('button', { name: '回到全景', exact: true }).click();
  await expect(focus).toHaveValue('');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const url = performance
          .getEntriesByType('resource')
          .find((entry) => entry.name.includes('/@react-three_fiber.js'))?.name;
        if (!url) return false;
        const { _roots } = await import(url);
        return !!_roots
          .get(document.querySelector('canvas'))
          ?.store.getState()
          .scene.getObjectByName('island-landscape');
      }),
    )
    .toBe(true);
  await page.screenshot({ path: 'test-results/whale-girl-studio.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('a whale closeup responds to real orbit drags and renders the changed view', async ({
  page,
}) => {
  const errors = await openStudio(page);
  const focus = page.getByLabel('角色特写');
  await focus.selectOption('luma');
  await expect.poll(() => cameraAngle(page)).toBeCloseTo(0, 2);
  await page.screenshot({ path: 'test-results/whale-girl-closeup.png', fullPage: true });
  const canvas = page.locator('.studio-canvas canvas');
  const beforeRotation = await canvas.screenshot();
  const viewport = (await canvas.boundingBox())!;
  await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    viewport.x + viewport.width / 2 + viewport.height * 0.1,
    viewport.y + viewport.height / 2,
    // Each interpolated event can require a software-rendered frame on Windows CI.
    { steps: 4 },
  );
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await cameraAngle(page)) ?? 0)).toBeGreaterThan(0.5);
  expect((await canvas.screenshot()).equals(beforeRotation)).toBe(false);
  await page.screenshot({ path: 'test-results/whale-girl-three-quarter.png', fullPage: true });
  await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    viewport.x + viewport.width / 2 + viewport.height * 0.4,
    viewport.y + viewport.height / 2,
    { steps: 4 },
  );
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await cameraAngle(page)) ?? 0)).toBeGreaterThan(2.8);
  await page.screenshot({ path: 'test-results/whale-girl-back.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('narrow character controls remain accessible across 2D and 3D mode changes', async ({
  page,
}) => {
  const errors = await openStudio(page, { width: 390, height: 844 });
  const focus = page.getByLabel('角色特写');
  await expect(focus).toBeVisible();
  await focus.selectOption('mori');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/whale-girl-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '2D 模式', exact: true }).click();
  await expect(page.locator('canvas')).toHaveCount(0);
  await expect(focus).toBeHidden();
  await page.getByRole('button', { name: '3D 场景', exact: true }).click();
  await expect(page.locator('.studio-canvas canvas')).toBeVisible();
  await expect(focus).toBeVisible();
  expect(errors).toEqual([]);
});
