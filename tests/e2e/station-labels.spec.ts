import { expect, test, type Page } from '@playwright/test';

async function projectTool(page: Page, position: [number, number, number]) {
  return page.evaluate(async (world) => {
    const moduleUrl = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/@react-three_fiber.js'))?.name;
    const canvas = document.querySelector('.studio-canvas canvas');
    if (!moduleUrl || !canvas) return null;
    const { _roots } = await import(moduleUrl);
    const state = _roots.get(canvas)?.store.getState();
    if (!state?.gl.info.render.frame) return null;
    const projected = state.camera.position
      .clone()
      .set(...world)
      .project(state.camera);
    const { left, top, width, height } = canvas.getBoundingClientRect();
    return { x: left + ((projected.x + 1) * width) / 2, y: top + ((1 - projected.y) * height) / 2 };
  }, position);
}

test('tool labels follow real scene hover and preserve mesh and keyboard activation', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/');
  const evidence = page.getByRole('button', { name: '对照架 · 检查记录' });
  const requests = page.getByRole('button', { name: '回信匣 · 输入与审批' });
  const artifacts = page.getByRole('button', { name: '交付港 · 等待成果' });
  const tools = [evidence, requests, artifacts];
  for (const tool of tools) await expect(tool).toHaveCSS('opacity', '0');
  await expect(page.locator('.scene-label').filter({ hasText: 'Mori' })).toBeVisible();

  const evidenceWorld: [number, number, number] = [0.3, 1.65, -3.38];
  const requestsWorld: [number, number, number] = [-4.2, 1.18, 2.85];
  const artifactsWorld: [number, number, number] = [4.25, 0.54, 3.11];
  await expect.poll(() => projectTool(page, evidenceWorld)).not.toBeNull();
  const point = (await projectTool(page, evidenceWorld))!;
  await page.mouse.move(point.x, point.y);
  await expect(evidence).toHaveCSS('opacity', '1');
  await expect(requests).toHaveCSS('opacity', '0');
  await expect(artifacts).toHaveCSS('opacity', '0');
  await page.mouse.move(100, 190);
  await expect(evidence).toHaveCSS('opacity', '0');

  const mailPoint = (await projectTool(page, requestsWorld))!;
  await page.mouse.move(mailPoint.x, mailPoint.y);
  await expect(requests).toHaveCSS('opacity', '1');
  const artifactPoint = (await projectTool(page, artifactsWorld))!;
  await page.mouse.move(artifactPoint.x, artifactPoint.y);
  await expect(requests).toHaveCSS('opacity', '0');
  await expect(artifacts).toHaveCSS('opacity', '1');

  const viewpoint = page.locator('select:has(option[value="harbor"])');
  await viewpoint.selectOption('harbor');
  await expect(artifacts).toHaveCSS('opacity', '0');
  await viewpoint.selectOption('');
  const reopenedPoint = (await projectTool(page, evidenceWorld))!;
  await page.mouse.click(reopenedPoint.x, reopenedPoint.y);
  const evidencePanel = page.getByRole('complementary', { name: '检查与证据' });
  await expect(evidencePanel).toBeVisible();

  await evidencePanel.getByRole('button', { name: '收起工作面板' }).click();
  await requests.focus();
  await expect(requests).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: '输入与审批' })).toBeVisible();
});

test.describe('touch input', () => {
  test.use({ hasTouch: true });

  test('a tap opens the tool panel without revealing a hover label', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto('/');
    const artifacts = page.getByRole('button', { name: '交付港 · 等待成果' });
    const position: [number, number, number] = [4.25, 0.54, 3.11];
    await expect.poll(() => projectTool(page, position)).not.toBeNull();
    const hit = (await projectTool(page, position))!;
    await page.touchscreen.tap(hit.x, hit.y);
    await expect(page.getByRole('complementary', { name: '成果与验收' })).toBeVisible();
    await expect(artifacts).toHaveCSS('opacity', '0');
  });
});
