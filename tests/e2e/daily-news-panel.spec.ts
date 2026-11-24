import { expect, test, type Page } from '@playwright/test';
import type { DailyNewsIssue, DailyNewsSettings, Workspace } from '@astrisle/contracts';

const timestamp = '2026-11-23T00:00:00.000Z';
const workspaces: Workspace[] = [
  { id: 'east', name: '东岛', createdAt: timestamp, sourcePath: 'east', workPath: 'east-copy' },
  { id: 'west', name: '西岛', createdAt: timestamp, sourcePath: 'west', workPath: 'west-copy' },
];
const original = 'https://news.example.org/harbor';

async function seedMailbox(page: Page, scenario: 'delivery' | 'switch') {
  await page.addInitScript(
    ({ workspaces, timestamp, original, scenario }) => {
      const local = new Date();
      const today = [
        local.getFullYear(),
        String(local.getMonth() + 1).padStart(2, '0'),
        String(local.getDate()).padStart(2, '0'),
      ].join('-');
      const older: DailyNewsIssue = {
        date: '2025-11-22',
        status: 'empty',
        message: '',
        updatedAt: timestamp,
        itemCount: 0,
        items: [],
      };
      const settings: Record<string, DailyNewsSettings> = {
        east: { enabled: false, time: '08:00', feeds: [], topic: '' },
        west: { enabled: false, time: '09:30', feeds: [], topic: '西岛海况' },
      };
      const delivery: DailyNewsIssue = {
        date: today,
        status: 'failed',
        message: '订阅源暂时不可用',
        updatedAt: timestamp,
        itemCount: 0,
        items: [],
      };
      let hasDelivery = false;
      let failedRegistration = false;
      const issues = (id: string) => (id === 'east' && hasDelivery ? [older, delivery] : []);
      const mailbox = (id: string) => ({
        settings: { ...settings[id] },
        issues: issues(id).map(({ date, status, message, updatedAt, itemCount }) => ({
          date,
          status,
          message,
          updatedAt,
          itemCount,
        })),
      });
      let finishSlowRead: (() => void) | undefined;
      (window as Window & { finishSlowRead?: () => void }).finishSlowRead = () =>
        finishSlowRead?.();
      window.astrisle = {
        bootstrap: async () => ({
          workspaces,
          commissions: [],
          provider: {
            kind: 'openai-compatible',
            baseUrl: '',
            model: '',
            configured: false,
            hasApiKey: false,
          },
          capabilities: [],
          version: 'mailbox-fixture',
        }),
        onSnapshot: () => () => {},
        getDailyNewsMailbox: async (id: string) => {
          if (id === 'east' && scenario === 'switch') {
            document.documentElement.dataset.slowMailbox = 'started';
            await new Promise<void>((resolve) => {
              finishSlowRead = resolve;
            });
          }
          return mailbox(id);
        },
        setDailyNewsSettings: async (id: string, next: DailyNewsSettings) => {
          if (id === 'east' && next.enabled && !failedRegistration) {
            failedRegistration = true;
            throw new Error('无法注册 Windows 计划任务');
          }
          settings[id] = { ...next };
          if (id === 'east' && next.enabled) hasDelivery = true;
          return mailbox(id);
        },
        getDailyNewsIssue: async (id: string, date: string) => {
          const issue = issues(id).find((entry) => entry.date === date);
          if (!issue) throw new Error('No such issue');
          return structuredClone(issue);
        },
        retryDailyNews: async (id: string, date: string) => {
          if (id !== 'east' || date !== today) throw new Error('Wrong issue');
          delivery.status = 'running';
          delivery.message = '';
          setTimeout(() => {
            delivery.status = 'delivered';
            delivery.itemCount = 1;
            delivery.items = [
              {
                title: '花港码头重新开放',
                url: original,
                publishedAt: '2026-11-23',
                summary: '维修工作已完成。',
              },
            ];
          }, 500);
          return mailbox(id);
        },
        openDailyNewsSource: async (id: string, date: string, url: string) => {
          if (id !== 'east' || date !== today || url !== original) throw new Error('Wrong source');
          document.documentElement.dataset.openedSource = url;
        },
      } as unknown as NonNullable<Window['astrisle']>;
    },
    { workspaces, timestamp, original, scenario },
  );
}

const mailboxNav = (page: Page) =>
  page.getByRole('navigation', { name: '工作室导航' }).getByRole('button', { name: '日报邮箱' });
const mailboxPanel = (page: Page) => page.getByRole('complementary', { name: '日报邮箱' });

test('a mobile island without commissions can enable, retry and read a daily issue in 2D', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await seedMailbox(page, 'delivery');
  await page.goto('/');
  await page.getByRole('button', { name: '2D 模式' }).click();
  const flatMailbox = page.getByRole('main').getByRole('button', { name: '日报邮箱' });
  await flatMailbox.focus();
  await page.keyboard.press('Enter');
  const panel = mailboxPanel(page);
  const enabled = panel.getByLabel('开启每日新闻');
  await expect(enabled).not.toBeChecked();
  await enabled.check();
  await panel.getByLabel('投递时间').fill('07:45');
  await panel.getByLabel('新闻主题').fill('航运');
  await panel.getByLabel('RSS / Atom 订阅地址').fill('https://news.example.org/rss.xml');
  const save = panel.getByRole('button', { name: '保存日报设置' });
  await save.click();
  await expect(panel.getByRole('alert')).toHaveText('无法注册 Windows 计划任务');
  await expect(panel.getByLabel('新闻主题')).toHaveValue('航运');
  await save.click();

  const today = panel.getByRole('region', { name: '今日投递' });
  await expect(today.getByText('订阅源暂时不可用')).toBeVisible();
  const history = panel.getByRole('list', { name: '日报历史' });
  await expect(history.getByRole('listitem').first()).not.toContainText('2025-11-22');
  await expect(history.getByRole('listitem').last()).toContainText('2025-11-22');
  await today.getByRole('button', { name: /^重试 / }).click();
  await expect(today.getByText('已投递')).toBeVisible();
  await history.getByRole('button', { name: /^阅读 / }).click();
  await expect(panel.getByRole('heading', { name: '花港码头重新开放' })).toBeVisible();
  await expect(panel.locator('time[datetime="2026-11-23"]')).toHaveText('2026-11-23');
  const articleLink = panel.getByRole('link', { name: '阅读原文' });
  await expect(articleLink).toHaveAttribute('href', original);
  await articleLink.click();
  await expect(page.locator('html')).toHaveAttribute('data-opened-source', original);

  await enabled.uncheck();
  await panel.getByRole('button', { name: '保存日报设置' }).click();
  await expect(today.getByText('已关闭')).toBeVisible();
  await expect(panel.getByRole('heading', { name: '花港码头重新开放' })).toBeVisible();
});

test('a late read after switching islands does not overwrite the newly opened mailbox', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seedMailbox(page, 'switch');
  await page.goto('/');
  await page.getByRole('button', { name: '2D 模式' }).click();
  await mailboxNav(page).click();
  await expect(page.locator('html')).toHaveAttribute('data-slow-mailbox', 'started');
  await mailboxPanel(page).getByRole('button', { name: '收起工作面板' }).click();
  await page.getByRole('button', { name: '展开项目与委托' }).click();
  await page.getByLabel('选择工作空间').selectOption('west');
  await mailboxNav(page).click();
  await expect(mailboxPanel(page).getByLabel('新闻主题')).toHaveValue('西岛海况');
  await page.evaluate(() =>
    (window as Window & { finishSlowRead?: () => void }).finishSlowRead?.(),
  );
  await expect(mailboxPanel(page).getByLabel('新闻主题')).toHaveValue('西岛海况');
});

test('the standalone browser preview has no active mailbox', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(mailboxNav(page)).toHaveCount(0);
  await page.getByRole('button', { name: '2D 模式' }).click();
  await expect(page.getByRole('button', { name: '日报邮箱' })).toHaveCount(0);
});

test('the island postbox moves keyboard focus to the mailbox, then returns it when closed', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seedMailbox(page, 'delivery');
  await page.goto('/');
  const station = page.getByRole('main').getByRole('button', { name: '日报邮箱' });
  await expect(station).toHaveCSS('opacity', '0');
  await station.focus();
  await expect(station).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  const panel = mailboxPanel(page);
  await expect(panel.getByRole('heading', { name: '日报邮箱' })).toBeFocused({ timeout: 2_000 });
  await panel.getByRole('button', { name: '收起工作面板' }).focus();
  await page.keyboard.press('Enter');
  await expect(station).toBeFocused();
});
