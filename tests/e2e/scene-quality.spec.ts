import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function rendererState(page: Page) {
  return page.evaluate(async () => {
    const moduleUrl = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/@react-three_fiber.js'))?.name;
    if (!moduleUrl) return null;
    const { _roots } = await import(moduleUrl);
    const canvas = document.querySelector('canvas');
    const state = _roots.get(canvas)?.store.getState();
    if (!state || !canvas) return null;
    return {
      dpr: state.viewport.dpr,
      pixels: canvas.width * canvas.height,
      antialias: state.gl.getContext().getContextAttributes().antialias,
      frameloop: state.frameloop,
      frame: state.gl.info.render.frame,
    };
  });
}

test('scene quality persists across views, caps large buffers, and leaves reduced motion idle', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 960 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect
    .poll(() => rendererState(page))
    .toMatchObject({ dpr: 1.5, antialias: true, frameloop: 'demand' });
  await page.getByRole('button', { name: '工作室设置', exact: true }).click();
  await expect(page.getByLabel('场景画质')).toHaveValue('clear');
  await page.getByLabel('场景画质').selectOption('balanced');
  await expect.poll(async () => (await rendererState(page))?.dpr).toBe(1);
  await page.reload();
  await expect.poll(async () => (await rendererState(page))?.dpr).toBe(1);
  await page.getByRole('button', { name: '工作室设置', exact: true }).click();
  await expect(page.getByLabel('场景画质')).toHaveValue('balanced');
  await page.getByRole('button', { name: '群岛总览', exact: true }).click();
  await expect(page.locator('.archipelago-canvas canvas')).toBeVisible();
  await expect.poll(async () => (await rendererState(page))?.dpr).toBe(1);
  await page.getByRole('button', { name: '工作室设置', exact: true }).click();
  await page.getByLabel('场景画质').selectOption('clear');
  await expect.poll(async () => (await rendererState(page))?.dpr).toBe(1.5);
  await page.getByRole('banner').getByRole('button', { name: '收起工作面板', exact: true }).click();

  await page.setViewportSize({ width: 3840, height: 2160 });
  await expect
    .poll(async () => (await rendererState(page))?.pixels ?? Infinity)
    .toBeLessThanOrEqual(4_000_000);
  await expect
    .poll(async () => (await rendererState(page))?.pixels ?? 0)
    .toBeGreaterThan(3_990_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await rendererState(page))?.dpr).toBe(1.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.waitForTimeout(700);
  const frame = (await rendererState(page))!.frame;
  await page.waitForTimeout(500);
  expect((await rendererState(page))!.frame).toBe(frame);
  expect(errors).toEqual([]);
});
