import { expect, test } from '@playwright/test';

test('whale companions have selectable closeups and preserve the accessible scene controls', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/');
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
  }
  await focus.selectOption('luma');
  await page.waitForTimeout(600); // Let the new camera render before the review artifact.
  await page.screenshot({ path: 'test-results/whale-girl-closeup.png', fullPage: true });
  const canvas = page.locator('.studio-canvas canvas');
  const beforeRotation = await canvas.screenshot();
  const viewport = (await canvas.boundingBox())!;
  await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    viewport.x + viewport.width / 2 + viewport.height * 0.1,
    viewport.y + viewport.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
  await page.waitForTimeout(350);
  expect((await canvas.screenshot()).equals(beforeRotation)).toBe(false);
  await page.screenshot({ path: 'test-results/whale-girl-three-quarter.png', fullPage: true });
  await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    viewport.x + viewport.width / 2 + viewport.height * 0.4,
    viewport.y + viewport.height / 2,
    { steps: 16 },
  );
  await page.mouse.up();
  await page.waitForTimeout(350);
  await page.screenshot({ path: 'test-results/whale-girl-back.png', fullPage: true });
  await page.getByRole('button', { name: '回到全景', exact: true }).click();
  await expect(focus).toHaveValue('');
  await expect(page.getByText('悬浮星岛 · 鲸鱼伙伴', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/whale-girl-studio.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
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
