import { expect, test, type Page } from '@playwright/test';
import { humanoidGlb, seedIslandLife } from '../fixtures/island-life';

async function inspect(
  page: Page,
  seconds = 0,
  until?: { id: string; stage: string; activity?: string },
) {
  return page.evaluate(
    async ({ seconds, until }) => {
      const url = performance
        .getEntriesByType('resource')
        .find((entry) => entry.name.includes('/@react-three_fiber.js'))?.name;
      if (!url) return null;
      const { _roots } = await import(url);
      const state = _roots.get(document.querySelector('canvas'))?.store.getState();
      if (!state) return null;
      // Exercise the mounted useFrame callbacks with deterministic active-time deltas.
      // No production test hook or changed activity speed is needed on software GPUs.
      for (let i = 0; i < Math.round(seconds / 0.05); i++) {
        for (const subscriber of state.internal.subscribers) subscriber.ref.current(state, 0.05);
        if (until) {
          const actor = state.scene.getObjectByName(`avatar-${until.id}`);
          if (
            actor?.userData.activityStage === until.stage &&
            (!until.activity || actor.userData.activity === until.activity)
          )
            break;
        }
      }
      state.scene.updateMatrixWorld(true);
      state.invalidate();
      return {
        actors: ['mori', 'luma', 'user'].map((id) => {
          const actor = state.scene.getObjectByName(`avatar-${id}`);
          const cup = actor?.getObjectByName('held-teacup');
          const hand = actor?.getObjectByName('Right_hand');
          const handle = cup?.getObjectByName('teacup-handle');
          let importedHand: any;
          actor?.traverse((object: any) => {
            if (object.isSkinnedMesh && Number.isInteger(object.userData.gaitRightHandVertex))
              importedHand = object;
          });
          const deformedHand =
            importedHand && handle
              ? importedHand.localToWorld(
                  importedHand.getVertexPosition(
                    importedHand.userData.gaitRightHandVertex,
                    handle.position.clone(),
                  ),
                )
              : undefined;
          return {
            id,
            position: actor?.position.toArray(),
            activity: actor?.userData.activity,
            stage: actor?.userData.activityStage,
            blend: actor?.userData.activityBlend,
            cup: actor?.getObjectByName('held-teacup')?.visible ?? false,
            gripGap:
              hand && handle
                ? hand
                    .getWorldPosition(hand.position.clone())
                    .distanceTo(handle.getWorldPosition(handle.position.clone()))
                : undefined,
            importedGripGap:
              deformedHand && handle
                ? deformedHand.distanceTo(handle.getWorldPosition(handle.position.clone()))
                : undefined,
            knee: actor?.getObjectByName('gait-left-knee')?.rotation.x,
            tilt: actor?.children[0]?.rotation.x,
          };
        }),
        swing: state.scene.getObjectByName('swing-pendulum')?.rotation.x,
        facilities: ['facility-garden-bench', 'facility-tea-chair', 'facility-garden-swing'].every(
          (name) => !!state.scene.getObjectByName(name),
        ),
        draws: state.gl.info.render.calls,
      };
    },
    { seconds, until },
  );
}

async function open(page: Page, imported = false) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 960 });
  await seedIslandLife(page, imported ? [...humanoidGlb()] : undefined);
  await page.goto('/');
  await page.bringToFront();
  await expect.poll(async () => (await inspect(page))?.facilities).toBe(true);
  if (imported) await expect.poll(async () => (await inspect(page))?.actors[0].knee).toBeDefined();
}

test('island companions automatically sit, sip tea and share a synchronized swing', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  const seen = new Set<string>();
  let captured = false;
  for (let i = 0; i < 65 && (seen.size < 3 || !captured); i++) {
    const state = (await inspect(page, 1))!;
    for (const actor of state.actors)
      if (actor.stage === 'enjoying') {
        seen.add(actor.activity);
        expect(actor.blend).toBe(1);
        if (actor.activity === 'tea') {
          expect(actor.cup).toBe(true);
          expect(actor.gripGap).toBeLessThan(0.025);
        }
        if (actor.activity === 'swing') expect(actor.tilt).toBeCloseTo(state.swing!, 6);
      }
    if (!captured && state.actors.filter((a) => a.stage === 'enjoying').length >= 2) {
      await page.screenshot({ path: 'test-results/island-life-overview.png', fullPage: true });
      captured = true;
    }
  }
  expect([...seen].sort()).toEqual(['sit', 'swing', 'tea']);
  expect(captured).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(async () =>
      (await inspect(page))?.actors.every((a) => a.blend === 0 && a.stage === 'roaming'),
    )
    .toBe(true);
  expect((await inspect(page))?.swing).toBe(0);
  expect(errors).toEqual([]);
});

test('an imported seated character stands for real work and stays stationary in closeup', async ({
  page,
}) => {
  await open(page, true);
  const seated = (await inspect(page, 45, { id: 'mori', stage: 'enjoying' }))!.actors[0];
  expect(seated.stage).toBe('enjoying');
  expect((await inspect(page))!.actors[0].knee).toBeGreaterThan(1);
  const tea = (await inspect(page, 100, { id: 'mori', stage: 'enjoying', activity: 'tea' }))!
    .actors[0];
  expect(tea.stage).toBe('enjoying');
  expect(tea.activity).toBe('tea');
  for (let i = 0; i < 5; i++) {
    const actor = (await inspect(page, 0.4))!.actors[0];
    expect(actor.cup).toBe(true);
    expect(actor.importedGripGap).toBeLessThan(0.025);
  }
  await page.getByRole('button', { name: '展开项目与委托' }).click();
  await page.getByRole('button', { name: '场景验收 待验收' }).click();
  await page.evaluate(() => (window as any).setLifeWorking());
  await expect(page.locator('.scene-label').filter({ hasText: 'Mori' })).toContainText('工作中');
  await inspect(page, 0.2);
  expect((await inspect(page))!.actors[0].stage).toBe('leaving');
  await inspect(page, 35);
  const back = (await inspect(page))!.actors[0];
  expect(back.position[0]).toBeCloseTo(-3.45, 2);
  expect(back.position[2]).toBeCloseTo(1.2, 2);
  expect(back.blend).toBe(0);
  expect(back.cup).toBe(false);
  await page.getByLabel('角色特写').selectOption('mori');
  await inspect(page, 15);
  const focus = (await inspect(page))!.actors[0];
  expect(focus.position).toEqual([-3.45, 0.02, 1.2]);
  expect(focus.blend).toBe(0);
  expect(focus.knee).toBeCloseTo(0);
});
