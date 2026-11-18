import { expect, test, type Page } from '@playwright/test';
import { seedIslandLife } from '../fixtures/island-life';

async function projectStation(page: Page, meshName: string, position: [number, number, number]) {
  return page.evaluate(
    async ({ meshName, position }) => {
      const resource = performance
        .getEntriesByType('resource')
        .find((entry) => entry.name.includes('/@react-three_fiber.js'));
      const canvas = document.querySelector('.studio-canvas canvas');
      if (!resource || !canvas) return null;
      const { _roots } = await import(resource.name);
      const state = _roots.get(canvas)?.store.getState();
      const mesh = state?.scene.getObjectByName(meshName);
      if (!mesh || !state.gl.info.render.frame || state.controls.target.x === 0) return null;
      const screen = mesh
        .localToWorld(state.camera.position.clone().set(...position))
        .project(state.camera);
      const { left, top, width, height } = canvas.getBoundingClientRect();
      return { x: left + ((screen.x + 1) * width) / 2, y: top + ((1 - screen.y) * height) / 2 };
    },
    { meshName, position },
  );
}

test('the harbor office and dispatch counter open real commission panels', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 960 });
  await seedIslandLife(page);
  await page.goto('/');
  await page.evaluate(() => {
    const fixture = window.astrisle!;
    const readSnapshot = fixture.snapshot;
    fixture.snapshot = async (id) => {
      const project = await readSnapshot(id);
      const artifact = {
        id: 'harbor-delivery',
        versionId: 'harbor-delivery-v2',
        commissionId: id,
        taskId: 'pack-delivery',
        name: '港口交付清单',
        relativePath: 'delivery.txt',
        mediaType: 'text/plain',
        sha256: 'f'.repeat(64),
        size: 24,
        createdAt: project.commission.updatedAt,
        inputVersions: [],
        validity: 'current' as const,
      };
      project.artifacts = [
        artifact,
        { ...artifact, versionId: 'harbor-delivery-v1', validity: 'stale' },
      ];
      return project;
    };
  });

  const viewpoint = page.getByLabel('场景视角与角色特写');
  await viewpoint.selectOption('harbor');
  const office = page.getByRole('button', { name: '港务处 · 目标与计划' });
  const emptyDispatch = page.getByRole('button', { name: '码头柜台 · 等待成果' });
  await expect(office).toHaveCSS('opacity', '0');
  await expect(emptyDispatch).toHaveCSS('opacity', '0');

  const facade: [number, number, number] = [5.4, 2.25, -0.02];
  await expect.poll(() => projectStation(page, 'harbor-office', facade)).not.toBeNull();
  const entry = (await projectStation(page, 'harbor-office', facade))!;
  await page.mouse.move(entry.x, entry.y);
  await expect(office).toHaveCSS('opacity', '1');
  await page.mouse.click(entry.x, entry.y);
  const goal = page.getByRole('complementary', { name: '目标与计划' });
  await expect(goal).toBeVisible();

  await page.getByRole('button', { name: '展开项目与委托' }).click();
  await page.getByRole('button', { name: '场景验收 待验收' }).click();
  const dispatch = page.getByRole('button', { name: '码头柜台 · 1 项成果，待验收' });
  await expect(dispatch).toBeAttached();
  await goal.getByRole('button', { name: '收起工作面板', exact: true }).click();
  const counter: [number, number, number] = [0, 0.71, 0.2];
  await expect.poll(() => projectStation(page, 'harbor-dispatch-counter', counter)).not.toBeNull();
  const delivery = (await projectStation(page, 'harbor-dispatch-counter', counter))!;
  await page.mouse.move(delivery.x, delivery.y);
  await expect(dispatch).toHaveCSS('opacity', '1');
  await page.mouse.move(102, 190);
  await expect(dispatch).toHaveCSS('opacity', '0');
  await dispatch.focus();
  await expect(dispatch).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  const artifacts = page.getByRole('complementary', { name: '成果与验收' });
  await expect(artifacts).toBeVisible();
  await expect(artifacts.getByText('成果已进入待验收阶段。')).toBeVisible();
});
