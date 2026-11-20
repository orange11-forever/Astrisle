import { expect, test, type Page } from '@playwright/test';
import { humanoidGlb, seedIslandLife } from '../fixtures/island-life';

async function inspect(
  page: Page,
  seconds = 0,
  until?: { id?: string; stage: string; activity?: string; count?: number },
  ids = ['mori', 'luma', 'user'],
) {
  return page.evaluate(
    async ({ seconds, until, ids }) => {
      const url = performance
        .getEntriesByType('resource')
        .find((entry) => entry.name.includes('/@react-three_fiber.js'))?.name;
      if (!url) return null;
      const { _roots } = await import(url);
      const state = _roots.get(document.querySelector('canvas'))?.store.getState();
      if (!state) return null;
      const watched = (until?.id ? [until.id] : ids).map((id) =>
        state.scene.getObjectByName(`avatar-${id}`),
      );
      // Exercise the mounted useFrame callbacks with deterministic active-time deltas.
      // No production test hook or changed activity speed is needed on software GPUs.
      for (let i = 0; i < Math.round(seconds / 0.05); i++) {
        for (const subscriber of state.internal.subscribers) subscriber.ref.current(state, 0.05);
        if (until) {
          const matching = watched.filter(
            (actor) =>
              actor?.userData.activityStage === until.stage &&
              (!until.activity || actor.userData.activity === until.activity),
          );
          if (matching.length >= (until.count ?? 1)) break;
        }
      }
      state.scene.updateMatrixWorld(true);
      state.invalidate();
      if (until?.count) state.gl.render(state.scene, state.camera);
      return {
        actors: ids.map((id) => {
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
            working: actor?.userData.working,
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
    { seconds, until, ids },
  );
}

async function open(page: Page, imported = false) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize(
    imported ? { width: 1000, height: 700 } : { width: 1440, height: 960 },
  );
  await seedIslandLife(page, imported ? [...humanoidGlb()] : undefined);
  await page.goto('/');
  await page.bringToFront();
  await expect.poll(async () => (await inspect(page))?.facilities).toBe(true);
  if (imported) await expect.poll(async () => (await inspect(page))?.actors[0].knee).toBeDefined();
}

async function pauseFrames(page: Page) {
  // The mounted scene follows inspect()'s clock so GPU speed cannot skip a transition.
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('/@react-three_fiber.js'))!.name;
    const { _roots } = await import(url);
    _roots.get(document.querySelector('canvas')).store.getState().setFrameloop('never');
  });
}

async function selectCommissionAndPauseFrames(page: Page) {
  await page.getByRole('button', { name: '展开项目与委托' }).click();
  await page.getByRole('button', { name: '场景验收 待验收' }).click();
  await pauseFrames(page);
}

test('island companions automatically sit, sip tea and share a synchronized swing', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await pauseFrames(page);
  for (const activity of ['sit', 'tea', 'swing']) {
    const state = (await inspect(page, 120, { stage: 'enjoying', activity }))!;
    const actor = state.actors.find((a) => a.stage === 'enjoying' && a.activity === activity);
    expect(actor?.blend, activity).toBe(1);
    if (activity === 'tea') {
      expect(actor!.cup).toBe(true);
      expect(actor!.gripGap).toBeLessThan(0.025);
    }
    if (activity === 'swing') {
      const moving = (await inspect(page, 0.25))!;
      expect(Math.abs(moving.swing!)).toBeGreaterThan(0.001);
      expect(moving.actors.find((a) => a.id === actor!.id)?.tilt).toBeCloseTo(moving.swing!, 6);
    }
  }
  const together = (await inspect(page, 120, { stage: 'enjoying', count: 2 }))!;
  expect(together.actors.filter((a) => a.stage === 'enjoying').length).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: 'test-results/island-life-overview.png', fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(async () =>
      (await inspect(page, 0.05))?.actors.every((a) => a.blend === 0 && a.stage === 'roaming'),
    )
    .toBe(true);
  expect((await inspect(page))?.swing).toBe(0);
  expect(errors).toEqual([]);
});

test('additional partners draw their own models and can leave leisure for assigned review work', async ({
  page,
}) => {
  const reviewer = 'partner-03f575ff-5421-488a-aa12-fc5601ccd169';
  const producer = 'partner-448aae6a-5bb2-42e0-826b-126de986ce39';
  const bytes = [...humanoidGlb()];
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 960 });
  await seedIslandLife(page, bytes, [
    { id: reviewer, displayName: '第四位伙伴' },
    {
      id: producer,
      displayName: '第五位伙伴',
      model: {
        assetId: 'custom-partner-fixture',
        filename: 'custom-partner-fixture.glb',
        format: 'glb',
        byteLength: bytes.length,
        triangleCount: 84,
        animationCount: 0,
        hasSkins: false,
      },
    },
  ]);
  await page.goto('/');
  await page.bringToFront();
  const canvas = page.locator('.studio-canvas canvas');
  await expect(canvas).toHaveAttribute(`data-character-${reviewer}`, 'builtin');
  await expect(canvas).toHaveAttribute(`data-character-${producer}`, 'custom-partner-fixture');
  await selectCommissionAndPauseFrames(page);
  const actors = [reviewer, producer];
  const readActors = (seconds: number, stage?: string) =>
    inspect(page, seconds, stage ? { id: reviewer, stage } : undefined, actors);
  const idle = (await readActors(130, 'enjoying'))!.actors[0];
  expect(idle).toMatchObject({ stage: 'enjoying', blend: 1 });

  await page.evaluate((id) => (window as any).setLifeWorking(id, 'review'), reviewer);
  const nameplate = page.locator(`[data-character-id="${reviewer}"]`);
  await expect(nameplate).toHaveAttribute('data-task-id', 'real-task');
  await expect(nameplate).toContainText('工作中');
  expect((await readActors(0.2))!.actors[0]).toMatchObject({ stage: 'leaving', working: false });
  const settled = (await readActors(65))!.actors[0];
  expect(settled).toMatchObject({ position: [0, 0.02, -5.3], working: true });
});

test('an imported seated character stands for real work and stays stationary in closeup', async ({
  page,
}) => {
  await open(page, true);
  await selectCommissionAndPauseFrames(page);
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
  expect((await inspect(page))!.actors[0].stage).toBe('enjoying');
  await page.evaluate(() => (window as any).setLifeWorking());
  await expect(page.locator('.scene-label').filter({ hasText: 'Mori' })).toContainText('工作中');
  const standing = (await inspect(page, 0.25))!.actors[0];
  expect(standing.stage).toBe('leaving');
  expect(standing.blend).toBeGreaterThan(0);
  expect(standing.blend).toBeLessThan(1);
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
