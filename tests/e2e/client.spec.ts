import { test, expect } from '@playwright/test';

test.use({ channel: 'msedge', viewport: { width: 1440, height: 960 } });
const url = process.env.ASTRISLE_CLIENT_URL || 'http://127.0.0.1:5173';
test('browser preview is honest, 3D renders, panels and 2D remain accessible', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  await page.goto(url);
  await expect(page.getByText('桌面连接未就绪')).toBeVisible();
  await expect(page.getByRole('complementary', { name: '目标与计划' })).toBeHidden();
  await page.getByRole('button', { name: '打开工作面板', exact: true }).click();
  await expect(page.getByRole('heading', { name: '在桌面版开始协作' })).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: '新建岛屿', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '收起工作面板', exact: true }).first().click();
  await page.getByRole('button', { name: '2D 模式' }).click();
  await expect(page.getByRole('heading', { name: '工作概览' })).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
  await page.getByRole('button', { name: '工作室设置', exact: true }).click();
  await page.getByLabel('API 协议').selectOption('anthropic');
  await expect(page.getByLabel('API 基础地址')).toHaveValue('https://api.anthropic.com');
  await page.getByLabel('API 协议').selectOption('gemini');
  await expect(page.getByLabel('API 基础地址')).toHaveValue(
    'https://generativelanguage.googleapis.com',
  );
  expect(errors).toEqual([]);
});
test('desktop and narrow layouts show scene plus useful panels without overflow', async ({
  page,
}) => {
  await page.goto(url);
  await expect(page.locator('canvas')).toBeVisible();
  await page.waitForTimeout(1000);
  const stage = await page.getByTestId('island-stage').boundingBox();
  expect((stage!.width * stage!.height) / (1440 * 960)).toBeGreaterThan(0.8);
  await page.screenshot({
    path: 'docs/development/screenshots/studio-preview.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('complementary', { name: '目标与计划' })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: process.env.TEMP + '/astrisle-client-mobile.png', fullPage: true });
});

test('persistent Workspace islands can be created without a model and selected in the actual 3D overview', async ({
  page,
}) => {
  // Island labels float with their scene. Use the supported accessible mode so
  // real pointer clicks stay deterministic on low-frame-rate CI runners.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // This isolated HostAPI fixture tests UI persistence wiring. It never ships in the application.
  await page.addInitScript(() => {
    const initial = [
      {
        id: 'fixture-coast',
        name: '海风岛',
        sourcePath: '',
        workPath: 'test-fixture/coast',
        createdAt: '2026-11-11',
      },
      {
        id: 'fixture-study',
        name: '调研岛',
        sourcePath: '',
        workPath: 'test-fixture/study',
        createdAt: '2026-11-11',
      },
    ];
    const read = () =>
      JSON.parse(localStorage.getItem('astrisle-test-islands') || JSON.stringify(initial));
    window.astrisle = {
      bootstrap: async () => ({
        workspaces: read(),
        commissions: [],
        provider: {
          kind: 'openai-compatible',
          baseUrl: '',
          model: '',
          hasApiKey: false,
          configured: false,
        },
        capabilities: [],
        version: 'test-fixture',
      }),
      createWorkspace: async (input: { name: string; sourcePath?: string }) => {
        const items = read();
        const created = {
          id: 'fixture-' + (items.length + 1),
          name: input.name,
          sourcePath: input.sourcePath || '',
          workPath: 'test-fixture/new',
          createdAt: new Date().toISOString(),
        };
        items.push(created);
        localStorage.setItem('astrisle-test-islands', JSON.stringify(items));
        return created;
      },
      chooseDirectory: async () => null,
      onSnapshot: () => () => {},
    } as unknown as NonNullable<Window['astrisle']>;
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await expect(page.getByLabel('切换岛屿')).toHaveValue('fixture-coast');
  await page.getByRole('button', { name: '群岛总览', exact: true }).click();
  await expect(page.getByRole('heading', { name: '你的群岛' })).toBeVisible();
  await expect(page.locator('.archipelago-canvas canvas')).toBeVisible();
  await page.getByRole('button', { name: '选择岛屿 调研岛', exact: true }).click();
  await expect(page.getByLabel('切换岛屿')).toHaveValue('fixture-study');
  await page.getByRole('button', { name: '进入岛屿', exact: true }).click();
  await expect(page.getByRole('heading', { name: '调研岛', exact: true })).toBeVisible();
  await expect(page.locator('.studio-canvas canvas')).toBeVisible();
  await page.getByRole('button', { name: '新建岛屿', exact: true }).click();
  await page.getByLabel('岛屿名称').fill('办公花园');
  await page.getByRole('button', { name: '创建岛屿', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '你的群岛' })).toBeVisible();
  await expect(page.getByRole('button', { name: '选择岛屿 办公花园', exact: true })).toBeVisible();
  await expect(page.getByLabel('切换岛屿')).toHaveValue('fixture-3');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/archipelago-fixture.png', fullPage: true });
  await page.reload();
  await expect(page.getByLabel('切换岛屿').getByRole('option')).toHaveCount(4);
  await page.getByRole('button', { name: '群岛总览', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择岛屿 办公花园', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '进入岛屿', exact: true }).click();
  await page.getByRole('button', { name: '新委托', exact: true }).click();
  await page.getByText('权限与工作预算', { exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: '允许受信任的本机命令（测试、构建及工具）' }),
  ).not.toBeChecked();
  await expect(
    page.getByText('命令会在你的电脑上执行，不在安全沙箱中。', { exact: false }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
