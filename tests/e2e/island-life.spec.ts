import { expect, test, type Page } from '@playwright/test';
import { humanoidGlb, seedIslandLife } from '../fixtures/island-life';

async function sceneState(
  page: Page,
  advance?: 'walk' | 'firstWorkFrame' | 'desk',
  fiberUrl?: string,
) {
  return page.evaluate(
    async ({ advance, fiberUrl }) => {
      const moduleUrl =
        fiberUrl ??
        performance
          .getEntriesByType('resource')
          .find((entry) => entry.name.includes('/@react-three_fiber.js'))?.name;
      if (!moduleUrl) return null;
      const { _roots } = await import(moduleUrl),
        state = _roots.get(document.querySelector('canvas'))?.store.getState();
      if (!state) return null;
      const avatar = state.scene.getObjectByName('avatar-mori'),
        thigh = avatar?.getObjectByName('gait-left-thigh');
      const start = avatar?.position.clone();
      let maxStep = 0,
        maxThighAngle = 0;
      if (advance && avatar) {
        // Advance the mounted character at its usual maximum delta. Render each sampled
        // pose once so software GPU throughput does not determine the elapsed walk time.
        state.setFrameloop('never');
        const frames = { walk: 40, firstWorkFrame: 1, desk: 700 }[advance];
        for (let frame = 0; frame < frames; frame++) {
          const { x, z } = avatar.position;
          for (const subscriber of state.internal.subscribers) subscriber.ref.current(state, 0.05);
          maxStep = Math.max(maxStep, Math.hypot(avatar.position.x - x, avatar.position.z - z));
          maxThighAngle = Math.max(maxThighAngle, Math.abs(thigh?.rotation.x ?? 0));
          if (
            advance === 'desk' &&
            Math.hypot(avatar.position.x + 3.45, avatar.position.z - 1.2) < 0.04
          )
            break;
        }
        state.gl.render(state.scene, state.camera);
      }
      return {
        position: avatar?.position.toArray(),
        maxStep,
        maxThighAngle,
        displacement: start
          ? Math.hypot(avatar.position.x - start.x, avatar.position.z - start.z)
          : 0,
        thigh: thigh?.rotation.x,
        confetti: state.scene.getObjectByName('completion-confetti')?.count ?? 0,
        frame: state.gl.info.render.frame,
      };
    },
    { advance, fiberUrl },
  );
}
async function selectCommission(page: Page) {
  await page.getByRole('button', { name: '展开项目与委托' }).click();
  await page.getByRole('button', { name: '场景验收 待验收' }).click();
}
test('idle companions move with real inferred bones and return to work without teleporting', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1000, height: 700 });
  await seedIslandLife(page, [...humanoidGlb()]);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.bringToFront();
  await expect.poll(async () => (await sceneState(page))?.thigh).not.toBeUndefined();
  const walking = (await sceneState(page, 'walk'))!;
  expect(walking.displacement).toBeGreaterThan(0.25);
  expect(walking.maxThighAngle).toBeGreaterThan(0.03);
  expect(walking.frame).toBeGreaterThan(0);
  await selectCommission(page);
  const before = (await sceneState(page))!.position;
  await page.evaluate(() => (window as any).setLifeWorking());
  await expect(page.locator('.scene-label').filter({ hasText: 'Mori' })).toContainText('工作中');
  const after = (await sceneState(page, 'firstWorkFrame'))!.position;
  expect(Math.hypot(after[0] - before[0], after[2] - before[2])).toBeLessThan(0.3);
  const returned = (await sceneState(page, 'desk'))!;
  expect(returned.maxStep).toBeLessThan(0.07);
  expect(Math.hypot(returned.position[0] + 3.45, returned.position[2] - 1.2)).toBeLessThan(0.04);
  const activity = page.getByRole('region', { name: '委托动态' });
  await activity.locator('summary', { hasText: '伙伴开始工作' }).click();
  await activity.getByRole('button', { name: '查看任务 · 处理文件' }).click();
  await expect(page.locator('.task-detail')).toContainText('workspace_read');
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
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await seedIslandLife(page);
  const fiber = page.waitForResponse((response) =>
    response.url().includes('/@react-three_fiber.js'),
  );
  await page.goto('/');
  const fiberUrl = (await fiber).url();
  const particleCount = async () => (await sceneState(page, undefined, fiberUrl))?.confetti;
  await page.bringToFront();
  await selectCommission(page);
  // Keep both bursts observable even when an input or a GPU read takes longer than the burst.
  // pauseAt fires outstanding timers once; reach this checkpoint before accepting the commission.
  const clockTime = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(clockTime + 60_000);
  await page.evaluate(() => (window as any).setLifeStatus('accepted'));
  await page.clock.runFor(32);
  await expect.poll(particleCount).toBe(160);
  // Expiry is an application timer; advance it independently of the runner's GPU frame rate.
  await page.clock.fastForward(4_000);
  await expect.poll(particleCount).toBe(0);
  await page.evaluate(() => (window as any).setLifeStatus('accepted'));
  await page.clock.runFor(32);
  expect(await particleCount()).toBe(0);
  await page.getByRole('button', { name: '庆祝一下' }).click();
  await page.clock.runFor(32);
  await expect.poll(particleCount).toBe(160);
});
