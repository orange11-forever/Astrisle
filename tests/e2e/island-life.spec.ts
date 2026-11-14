import { expect, test, type Page } from '@playwright/test';
import { humanoidGlb, seedIslandLife } from '../fixtures/island-life';

async function sceneState(page: Page) {
  return page.evaluate(async () => {
    const moduleUrl = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/@react-three_fiber.js'))?.name;
    if (!moduleUrl) return null;
    const { _roots } = await import(moduleUrl),
      state = _roots.get(document.querySelector('canvas'))?.store.getState();
    if (!state) return null;
    const avatar = state.scene.getObjectByName('avatar-mori'),
      thigh = avatar?.getObjectByName('gait-left-thigh');
    return {
      position: avatar?.position.toArray(),
      thigh: thigh?.rotation.x,
      confetti: state.scene.getObjectByName('completion-confetti')?.count ?? 0,
      frame: state.gl.info.render.frame,
    };
  });
}
async function selectCommission(page: Page) {
  await page.getByRole('button', { name: '展开项目与委托' }).click();
  await page.getByRole('button', { name: '场景验收 待验收' }).click();
}
test('idle companions move with real inferred bones and return to work without teleporting', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await seedIslandLife(page, [...humanoidGlb()]);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.bringToFront();
  await expect.poll(async () => (await sceneState(page))?.thigh).not.toBeUndefined();
  const initial = (await sceneState(page))!;
  await expect
    .poll(async () => {
      const p = (await sceneState(page))!.position;
      return Math.hypot(p[0] - initial.position[0], p[2] - initial.position[2]);
    })
    .toBeGreaterThan(0.25);
  await expect.poll(async () => Math.abs((await sceneState(page))!.thigh!)).toBeGreaterThan(0.03);
  await selectCommission(page);
  const before = (await sceneState(page))!.position;
  await page.evaluate(() => (window as any).setLifeWorking());
  const after = (await sceneState(page))!.position;
  expect(Math.hypot(after[0] - before[0], after[2] - before[2])).toBeLessThan(0.3);
  await expect
    .poll(
      async () => {
        const p = (await sceneState(page))!.position;
        return Math.hypot(p[0] + 3.45, p[2] - 1.2);
      },
      { timeout: 20000 },
    )
    .toBeLessThan(0.04);
  expect(errors).toEqual([]);
});
test('reduced motion keeps idle characters still and completed work offers a replayable bounded celebration', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seedIslandLife(page, [...humanoidGlb()]);
  await page.goto('/');
  await expect.poll(async () => (await sceneState(page))?.position).toBeDefined();
  const initial = (await sceneState(page))!;
  await page.waitForTimeout(400);
  expect((await sceneState(page))!.position).toEqual(initial.position);
  await selectCommission(page);
  await expect(page.getByRole('button', { name: '庆祝一下' })).toHaveCount(0);
  await page.evaluate(() => (window as any).setLifeStatus('accepted'));
  await expect(page.getByRole('status').filter({ hasText: '委托已完成' })).toBeVisible();
  expect((await sceneState(page))!.confetti).toBe(0);
  await page.getByRole('button', { name: '庆祝一下' }).click();
  await expect(page.getByRole('status').filter({ hasText: '委托已完成' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '委托已完成' })).toHaveCount(0, {
    timeout: 6000,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '庆祝一下' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('full acceptance launches confetti once and repeated snapshots do not replay it', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await seedIslandLife(page);
  await page.goto('/');
  await page.bringToFront();
  await selectCommission(page);
  await page.evaluate(() => (window as any).setLifeStatus('accepted'));
  await expect.poll(async () => (await sceneState(page))?.confetti).toBe(160);
  await expect.poll(async () => (await sceneState(page))?.confetti, { timeout: 6000 }).toBe(0);
  await page.evaluate(() => (window as any).setLifeStatus('accepted'));
  expect((await sceneState(page))!.confetti).toBe(0);
  await page.getByRole('button', { name: '庆祝一下' }).click();
  await expect.poll(async () => (await sceneState(page))?.confetti).toBe(160);
});
