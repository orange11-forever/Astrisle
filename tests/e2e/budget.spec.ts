import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

test('a paused commission budget can be edited through the real desktop UI and survives reload', async () => {
  await mkdir(resolve('test-results'), { recursive: true });
  const dataRoot = await mkdtemp(resolve('test-results', 'budget-desktop-'));
  const app = await electron.launch({
    args: [resolve('.')],
    env: { ...process.env, ASTRISLE_DATA_ROOT: dataRoot, ASTRISLE_DEV_URL: '' },
    timeout: 30000,
  });
  try {
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.hide();
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.astrisle);
    const id = await page.evaluate(async () => {
      const host = window.astrisle!;
      const workspace = await host.createWorkspace({ name: '预算验证岛' });
      const response = await host.submit({
        requestId: 'budget-desktop',
        workspaceId: workspace.id,
        goal: '预算续跑验证',
        criteria: ['生成并核对文件'],
        planningMode: 'auto',
        budget: { maxSteps: 10, maxMinutes: 5, maxRework: 2 },
        scope: {
          readRoots: [],
          writeRoots: [],
          allowProcess: false,
          allowNetwork: false,
          allowedHosts: [],
        },
      });
      return response.commissionId!;
    });
    await expect
      .poll(
        async () =>
          (await page.evaluate((id) => window.astrisle!.snapshot(id), id)).commission.status,
      )
      .toBe('paused');
    // The main-process schema must reject malformed commands before the runtime sees them.
    expect(
      await page.evaluate(async (id) => {
        try {
          await window.astrisle!.updateBudget(id, { maxSteps: 0, maxMinutes: 5, maxRework: 2 }, 0);
          return false;
        } catch {
          return true;
        }
      }, id),
    ).toBe(true);
    await page.reload();
    await page.getByRole('button', { name: '2D 模式' }).click();
    await page.getByRole('button', { name: '展开项目与委托' }).click();
    await page.getByRole('button', { name: '预算续跑验证 已暂停' }).click();
    const panel = page.getByRole('region', { name: '委托预算' });
    await expect(panel).toContainText('0 / 10 步');
    await panel.getByRole('button', { name: '调整预算' }).click();
    await panel.getByLabel('总步数上限').fill('40');
    await panel.getByLabel('总运行分钟').fill('15');
    await panel.getByLabel('自动返工上限').fill('5');
    await page.screenshot({ path: 'test-results/budget-desktop.png', fullPage: true });
    await panel.getByRole('button', { name: '保存预算' }).click();
    await expect(panel).toContainText('0 / 40 步');
    await expect(panel.getByLabel('总步数上限')).toHaveCount(0);
    const snapshot = await page.evaluate((id) => window.astrisle!.snapshot(id), id);
    expect(snapshot.commission).toMatchObject({
      status: 'paused',
      revision: 1,
      budgetRevision: 1,
      budget: { maxSteps: 40, maxMinutes: 15, maxRework: 5 },
    });
    expect(
      await page.evaluate(
        (id) =>
          window.astrisle!.updateBudget(id, { maxSteps: 30, maxMinutes: 10, maxRework: 2 }, 0),
        id,
      ),
    ).toMatchObject({ ok: false, code: 'stale_revision' });
    await page.reload();
    const persisted = await page.evaluate((id) => window.astrisle!.snapshot(id), id);
    expect(persisted.commission.budget).toEqual(snapshot.commission.budget);
    expect(persisted.commission.stepsUsed).toBe(0);
    await page.getByRole('button', { name: '2D 模式' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '展开项目与委托' }).click();
    await page.getByRole('button', { name: '预算续跑验证 已暂停' }).click();
    await page.getByRole('button', { name: '调整预算' }).click();
    await expect(page.getByLabel('总步数上限')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: 'test-results/budget-mobile.png', fullPage: true });
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
