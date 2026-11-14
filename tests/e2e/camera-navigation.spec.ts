import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function cameraState(page: Page) {
  return page.evaluate(async () => {
    const moduleUrl = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/@react-three_fiber.js'))?.name;
    if (!moduleUrl) return null;
    const { _roots } = await import(moduleUrl);
    const state = _roots.get(document.querySelector('.studio-canvas canvas'))?.store.getState();
    if (!state?.controls || !state.gl.info.render.frame) return null;
    return {
      angle: state.controls.getAzimuthalAngle(),
      pitch: state.controls.getPolarAngle(),
      distance: state.camera.position.distanceTo(state.controls.target),
      target: state.controls.target.toArray() as number[],
      position: state.camera.position.toArray() as number[],
    };
  });
}

async function drag(page: Page, x: number, y = 0, button: 'left' | 'right' = 'left') {
  const box = (await page.locator('.studio-canvas canvas').boundingBox())!;
  const start = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.45 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button });
  // One actual drag event preserves its full displacement without four software-rendered frames.
  await page.mouse.move(start.x + box.height * x, start.y + box.height * y);
  await page.mouse.up({ button });
}

async function reset(page: Page) {
  await page.getByRole('button', { name: '回到全景', exact: true }).click();
  await expect.poll(async () => (await cameraState(page))?.target).toEqual([0, 0.35, 0]);
  await expect
    .poll(async () => (await cameraState(page))?.position.map((value) => +value.toFixed(6)))
    .toEqual([13.5, 13.5, 20.3]);
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/');
  await expect.poll(() => cameraState(page)).not.toBeNull();
});

test('overview reaches both rear views and the full above-ground pitch range with real drags', async ({
  page,
}) => {
  await drag(page, 0.4);
  await expect.poll(async () => (await cameraState(page))?.position[2] ?? Infinity).toBeLessThan(0);
  await expect.poll(async () => (await cameraState(page))?.angle ?? 0).toBeLessThan(-1.6);
  await page.screenshot({ path: 'test-results/island-rear-view.png' });
  await reset(page);
  await drag(page, -0.4);
  await expect.poll(async () => (await cameraState(page))?.position[2] ?? Infinity).toBeLessThan(0);
  await expect.poll(async () => (await cameraState(page))?.angle ?? 0).toBeGreaterThan(1.6);
  await drag(page, 0, 0.4);
  await expect.poll(async () => (await cameraState(page))?.pitch ?? Infinity).toBeLessThan(0.15);
  await drag(page, 0, -0.4);
  await expect.poll(async () => (await cameraState(page))?.pitch ?? 0).toBeGreaterThan(1.45);
  expect((await cameraState(page))!.position[1]).toBeGreaterThan(0.35);
});

test('overview pans on the island plane and bounds the target', async ({ page }) => {
  await drag(page, 0.14, 0.1, 'right');
  await expect
    .poll(async () => Math.hypot(...(await cameraState(page))!.target.filter((_, i) => i !== 1)))
    .toBeGreaterThan(1);
  expect((await cameraState(page))!.target[1]).toBeCloseTo(0.35, 5);
  for (let i = 0; i < 3; i++) await drag(page, 0.35, 0.2, 'right');
  const panned = (await cameraState(page))!;
  expect(Math.hypot(panned.target[0], panned.target[2])).toBeLessThanOrEqual(7.001);
  await reset(page);
});

test('overview zooms closer and preserves orbit on resize with accessible narrow controls', async ({
  page,
}) => {
  const box = (await page.locator('.studio-canvas canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.45);
  for (let i = 0; i < 25; i++) await page.mouse.wheel(0, -180);
  await expect.poll(async () => (await cameraState(page))?.distance ?? Infinity).toBeLessThan(8);
  await drag(page, 0.12);
  await page.waitForTimeout(600);
  const before = (await cameraState(page))!;
  await page.setViewportSize({ width: 1200, height: 850 });
  await page.waitForTimeout(500);
  const after = (await cameraState(page))!;
  expect(after.angle).toBeCloseTo(before.angle, 2);
  expect(after.distance).toBeCloseTo(before.distance, 2);
  expect(after.target).toEqual(before.target);
  await page.setViewportSize({ width: 390, height: 844 });
  const closePanel = page
    .getByRole('banner')
    .getByRole('button', { name: '收起工作面板', exact: true });
  if (await closePanel.isVisible()) await closePanel.click();
  await expect(page.locator('.scene-caption')).toBeVisible();
  const hint = (await page.locator('.camera-hint').boundingBox())!;
  const dock = (await page.locator('.commission-dock').boundingBox())!;
  expect(hint.y + hint.height).toBeLessThan(dock.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/island-camera-mobile.png' });
});

test('fixed camera blocks orbit pan and zoom; closeups and overview restore their targets', async ({
  page,
}) => {
  await drag(page, 0.1, 0.06, 'right');
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '固定镜头', exact: true }).click();
  const locked = (await cameraState(page))!;
  await drag(page, 0.15);
  await drag(page, 0.15, 0.1, 'right');
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(400);
  expect(await cameraState(page)).toEqual(locked);
  await page.getByRole('button', { name: '固定镜头', exact: true }).click();
  for (const [id, target] of [
    ['mori', [-3.45, 0.95, 1.2]],
    ['luma', [3.45, 0.95, 1.2]],
    ['user', [0, 0.95, 3.65]],
  ] as const) {
    await page.getByLabel('角色特写').selectOption(id);
    await expect.poll(async () => (await cameraState(page))?.target).toEqual([...target]);
    await expect.poll(async () => (await cameraState(page))?.angle ?? 1).toBeCloseTo(0, 3);
    await drag(page, 0.12, 0.08, 'right');
    expect((await cameraState(page))!.target).toEqual([...target]);
  }
  await reset(page);
  await drag(page, 0.1, 0, 'right');
  await expect
    .poll(async () => Math.abs((await cameraState(page))?.target[0] ?? 0))
    .toBeGreaterThan(0.1);
  await reset(page);
});
