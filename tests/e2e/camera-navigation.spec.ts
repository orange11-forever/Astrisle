import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { OBSERVATORY } from '../../apps/client/src/island-observatory';

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

async function telescopeOnScreen(page: Page) {
  return page.evaluate(async ({ telescope, deck }) => {
    const canvas = document.querySelector('.studio-canvas canvas');
    const moduleUrl = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/@react-three_fiber.js'))?.name;
    if (!canvas || !moduleUrl) return null;
    const { _roots } = await import(moduleUrl);
    const state = _roots.get(canvas)?.store.getState();
    const scope = state?.scene.getObjectByName('observatory-telescope');
    if (!scope || !state.gl.info.render.frame) return null;
    const point = state.camera.position.clone().set(telescope[0], deck.height + 1.02, telescope[1]);
    const screen = scope.localToWorld(point).project(state.camera);
    const box = canvas.getBoundingClientRect();
    return {
      x: box.left + (box.width * (1 + screen.x)) / 2,
      y: box.top + (box.height * (1 - screen.y)) / 2,
    };
  }, OBSERVATORY);
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

test('harbor view frames the waterfront and restores free studio navigation', async ({ page }) => {
  const view = page.getByLabel('场景视角与角色特写');
  await view.selectOption('harbor');
  await expect(page.getByRole('heading', { name: '花港街景' })).toBeVisible();
  await expect
    .poll(async () => (await cameraState(page))?.target.map((value) => +value.toFixed(6)))
    .toEqual([-5.38, 0.65, -11.25]);
  const framed = (await cameraState(page))!;
  await drag(page, 0.12, 0.06, 'right');
  await expect.poll(async () => (await cameraState(page))?.target[0]).not.toBe(framed.target[0]);
  await view.selectOption('garden');
  await expect(page.getByRole('heading', { name: '温室花园' })).toBeVisible();
  await expect.poll(async () => (await cameraState(page))?.target).toEqual([-6.95, 0.62, 5.25]);
  await reset(page);
  await expect(view).toHaveValue('');
  await view.selectOption('mori');
  await expect.poll(async () => (await cameraState(page))?.target).toEqual([-3.45, 0.95, 1.2]);
});

test('visits the observatory at night and keeps free navigation and the sky preference', async ({
  page,
}) => {
  const shaderErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /WebGLProgram|shader error/i.test(message.text()))
      shaderErrors.push(message.text());
  });
  const view = page.getByLabel('场景视角与角色特写');
  await page.getByRole('button', { name: '工作室设置', exact: true }).click();
  const sky = page.getByLabel('岛上天色', { exact: true });
  await expect(sky).toHaveValue('auto');
  await sky.selectOption('night');
  await page.getByRole('banner').getByRole('button', { name: '收起工作面板' }).click();
  await view.selectOption('observatory');
  await expect(page.getByRole('heading', { name: '观星台' })).toBeVisible();
  const observatory = page.locator('.studio-canvas');
  await expect(observatory).toHaveAttribute('data-light-phase', 'night');
  await expect.poll(async () => (await cameraState(page))?.target[2] ?? 0).toBeLessThan(-5);
  const arrived = (await cameraState(page))!;
  await drag(page, 0.1, -0.15);
  await expect
    .poll(async () => Math.abs((await cameraState(page))!.pitch - arrived.pitch))
    .toBeGreaterThan(0.05);
  await reset(page);
  await expect.poll(() => telescopeOnScreen(page)).not.toBeNull();
  const telescope = (await telescopeOnScreen(page))!;
  await page.mouse.click(telescope.x, telescope.y);
  await expect(view).toHaveValue('observatory');
  await page.getByLabel('观星台天色').selectOption('day');
  await expect(observatory).toHaveAttribute('data-light-phase', 'day');
  await page.getByLabel('观星台天色').selectOption('night');
  await page.getByRole('button', { name: '2D 模式', exact: true }).click();
  await expect(observatory).toHaveCount(0);
  await page.getByRole('button', { name: '3D 场景', exact: true }).click();
  await expect(observatory).toHaveAttribute('data-light-phase', 'night');
  await page.reload();
  await expect(observatory).toHaveAttribute('data-light-phase', 'night');
  await page.getByRole('button', { name: '工作室设置', exact: true }).click();
  await expect(sky).toHaveValue('night');
  await sky.selectOption('dusk');
  await expect(observatory).toHaveAttribute('data-light-phase', 'dusk');
  expect(shaderErrors).toEqual([]);
});

test('travels along the boardwalk into the observatory when motion is enabled', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const route = await page.evaluateHandle(async (fov) => {
    const resource = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/@react-three_fiber.js'))!;
    const { _roots, addAfterEffect } = await import(resource.name);
    const { camera } = _roots.get(document.querySelector('.studio-canvas canvas')).store.getState();
    const positions = new Set<number>();
    const stop = addAfterEffect(() => {
      if (camera.fov === fov) positions.add(camera.position.z);
    });
    return { positions, stop };
  }, OBSERVATORY.fieldOfView);
  try {
    await page.getByLabel('场景视角与角色特写').selectOption('observatory');
    await expect.poll(() => route.evaluate(({ positions }) => positions.size)).toBeGreaterThan(2);
    await expect
      .poll(async () => (await cameraState(page))!.position[2])
      .toBeLessThan(OBSERVATORY.deck.entryZ);
    await reset(page);
  } finally {
    await route.evaluate(({ stop }) => stop());
    await route.dispose();
  }
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
