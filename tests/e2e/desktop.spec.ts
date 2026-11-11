import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

test('desktop starts with a real isolated runtime and preserves workspace across renderer reload', async () => {
  await mkdir(resolve('test-results'), { recursive: true });
  const dataRoot = await mkdtemp(resolve('test-results', 'desktop-data-'));
  const app = await electron.launch({
    args: [resolve('.')],
    env: { ...process.env, ASTRISLE_DATA_ROOT: dataRoot, ASTRISLE_DEV_URL: '' },
    timeout: 30_000,
  });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.astrisle);
    const before = await page.evaluate(() => window.astrisle!.bootstrap());
    expect(before.workspaces).toHaveLength(0);
    expect(before.provider.configured).toBe(false);
    const workspace = await page.evaluate(() =>
      window.astrisle!.createWorkspace({ name: '启动验证项目' }),
    );
    expect(workspace.workPath).toContain(dataRoot);
    const second = await page.evaluate(() =>
      window.astrisle!.createWorkspace({ name: '第二座测试岛屿' }),
    );
    expect(second.id).not.toBe(workspace.id);
    await page.reload();
    await expect
      .poll(async () => (await page.evaluate(() => window.astrisle!.bootstrap())).workspaces.length)
      .toBe(2);
    const after = await page.evaluate(() => window.astrisle!.bootstrap());
    expect(after.workspaces.map((item) => item.id)).toEqual(
      expect.arrayContaining([workspace.id, second.id]),
    );
    expect(after.commissions).toHaveLength(0);
    await page.waitForTimeout(1500); // Allow static first-frame lighting to settle for a visual artifact.
    await page.screenshot({ path: 'test-results/desktop-studio.png', fullPage: true });
    const rendererNode = await page.evaluate(
      () => typeof (window as unknown as { require?: unknown }).require,
    );
    expect(rendererNode).toBe('undefined');
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
