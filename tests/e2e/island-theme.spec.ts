import { expect, test } from '@playwright/test';

test('island themes update the studio and overview and persist separately across reloads', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const workspaces = [
      { id: 'theme-coast', name: '海风岛' },
      { id: 'theme-study', name: '调研岛' },
    ].map((workspace) => ({
      ...workspace,
      sourcePath: '',
      workPath: `theme-fixture/${workspace.id}`,
      createdAt: '2026-11-18',
    }));
    window.astrisle = {
      bootstrap: async () => ({
        workspaces,
        commissions: [],
        capabilities: [],
        version: 'fixture',
      }),
      onSnapshot: () => () => {},
    } as unknown as NonNullable<Window['astrisle']>;
  });

  await page.goto('/');
  const workspace = page.getByLabel('切换岛屿');
  const settings = page.getByRole('button', { name: '工作室设置', exact: true });
  const theme = page.getByLabel('岛屿主题');
  const studio = page.locator('.studio-canvas');
  await expect(workspace).toHaveValue('theme-coast');
  await settings.click();
  await expect(theme).toHaveValue('');
  const seededTheme = await studio.getAttribute('data-island-theme');
  expect(seededTheme).toBeTruthy();

  await theme.selectOption('rose');
  await expect(studio).toHaveAttribute('data-island-theme', 'rose');
  await page.getByRole('button', { name: '群岛总览', exact: true }).click();
  const coast = page.getByRole('button', { name: '选择岛屿 海风岛', exact: true });
  await expect(coast.getByText('蔷薇湾 · 已选中')).toBeVisible();
  await page.getByRole('button', { name: '选择岛屿 调研岛', exact: true }).click();
  await page.getByRole('button', { name: '进入岛屿', exact: true }).click();
  await settings.click();
  await expect(theme).toHaveValue('');
  await theme.selectOption('wisteria');
  await expect(studio).toHaveAttribute('data-island-theme', 'wisteria');

  await page.reload();
  await expect(workspace).toHaveValue('theme-coast');
  await settings.click();
  await expect(theme).toHaveValue('rose');
  await theme.selectOption('');
  await expect(studio).toHaveAttribute('data-island-theme', seededTheme!);

  await page.reload();
  await expect(workspace).toHaveValue('theme-coast');
  await settings.click();
  await expect(theme).toHaveValue('');
  await workspace.selectOption('theme-study');
  await settings.click();
  await expect(theme).toHaveValue('wisteria');
  await expect(studio).toHaveAttribute('data-island-theme', 'wisteria');
  await page.getByRole('button', { name: '群岛总览', exact: true }).click();
  await page.getByRole('button', { name: '2D 模式' }).click();
  await expect(page.getByRole('button', { name: '调研岛 紫藤雾' })).toBeVisible();
});
