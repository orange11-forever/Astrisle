import { expect, test, type ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, realpath } from 'node:fs/promises';
import { launchIsolatedElectron } from '../fixtures/electron';

test('enabling the island mailbox collects and reviews local news, delivers once, and survives restart', async ({}, testInfo) => {
  test.setTimeout(150_000);
  const dataPath = testInfo.outputPath('daily-news-runtime');
  await mkdir(dataPath, { recursive: true });
  const root = await realpath(dataPath);
  const stamp = new Date();
  const date = [
    stamp.getFullYear(),
    String(stamp.getMonth() + 1).padStart(2, '0'),
    String(stamp.getDate()).padStart(2, '0'),
  ].join('-');
  const title = '花港灯塔完成修缮';
  const summary = '花港完成灯塔修缮，傍晚将重新亮灯。';
  const bodyText = '花港今天完成灯塔修缮，工作人员验收后确认傍晚重新亮灯。';
  const calls: string[] = [];
  let reads = 0;
  let origin = '';
  const server = createServer(async (req, res) => {
    if (req.url === '/feed') {
      res
        .writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
        .end(
          `<rss version="2.0"><channel><title>花港新闻</title><item><title>${title}</title><link>${origin}/article</link><pubDate>${stamp.toUTCString()}</pubDate></item></channel></rss>`,
        );
    } else if (req.url === '/article') {
      reads++;
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          `<html><head><title>${title}</title><meta property="article:published_time" content="${stamp.toISOString()}"></head><body><article><h1>${title}</h1><p>${bodyText}</p></article></body></html>`,
        );
    } else if (req.url === '/v1/chat/completions') {
      try {
        let body = '';
        for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        const prompt = JSON.parse(
          request.messages.find((message: { role: string }) => message.role === 'user').content,
        );
        const name = request.tools[0].function.name;
        calls.push(name);
        const args =
          name === 'submit_daily_news'
            ? { items: [{ id: prompt.sources[0].id, summary }] }
            : name === 'review_daily_news'
              ? { acceptedIds: [prompt.items[0].id] }
              : undefined;
        if (!args) throw new Error('Unexpected provider tool');
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'local-' + calls.length,
                      type: 'function',
                      function: { name, arguments: JSON.stringify(args) },
                    },
                  ],
                },
              },
            ],
          }),
        );
      } catch {
        res.writeHead(400).end();
      }
    } else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let app: ElectronApplication | undefined;
  try {
    app = await launchIsolatedElectron(root);
    let page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: '新建岛屿', exact: true }).first().click();
    await page.getByLabel('岛屿名称').fill('日报验收岛');
    await page
      .getByRole('dialog', { name: '创建一座新岛屿' })
      .getByRole('button', { name: '创建岛屿', exact: true })
      .click();
    await expect(page.getByLabel('切换岛屿')).not.toHaveValue('');
    const id = await page.getByLabel('切换岛屿').inputValue();
    await page.evaluate(async (baseUrl) => {
      const host = window.astrisle!;
      await host.saveProvider({
        kind: 'openai-compatible',
        baseUrl,
        model: 'daily-news-test',
        apiKey: 'test-only-key',
      });
    }, origin + '/v1');
    await expect(page.getByLabel('切换岛屿')).toHaveValue(id);
    await page.getByRole('button', { name: '2D 模式', exact: true }).click();
    await page
      .getByRole('navigation', { name: '工作室导航' })
      .getByRole('button', { name: '日报邮箱' })
      .click();
    const mailbox = page.getByRole('complementary', { name: '日报邮箱' });
    await expect(mailbox.getByLabel('开启每日新闻')).not.toBeChecked();
    await mailbox.getByLabel('开启每日新闻').check();
    await mailbox.getByLabel('RSS / Atom 订阅地址').fill(origin + '/feed');
    await mailbox.getByRole('button', { name: '保存日报设置' }).click();
    await expect(mailbox.getByRole('region', { name: '今日投递' })).toContainText('已投递', {
      timeout: 45_000,
    });
    await expect(mailbox.getByRole('button', { name: '阅读 ' + date, exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await mailbox.getByRole('button', { name: '阅读 ' + date, exact: true }).click();
    await expect(mailbox.getByText(summary, { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('daily-news-delivered.png') });
    expect(calls).toEqual(['submit_daily_news', 'review_daily_news']);
    expect(reads).toBeGreaterThanOrEqual(2);
    await expect(
      page.evaluate(
        ({ id, date, origin }) =>
          window.astrisle!.openDailyNewsSource!(id, date, origin + '/unarchived'),
        { id, date, origin },
      ),
    ).rejects.toThrow();
    await app.close();
    app = await launchIsolatedElectron(root);
    page = await app.firstWindow();
    await page
      .getByRole('navigation', { name: '工作室导航' })
      .getByRole('button', { name: '日报邮箱' })
      .click();
    const restored = page.getByRole('complementary', { name: '日报邮箱' });
    await restored.getByRole('button', { name: '阅读 ' + date, exact: true }).click();
    await expect(restored.getByText(summary, { exact: true })).toBeVisible();
    const issue = await page.evaluate(
      ({ id, date }) => window.astrisle!.getDailyNewsIssue!(id, date),
      { id, date },
    );
    expect(issue.status).toBe('delivered');
    expect(issue.items).toMatchObject([{ title, url: origin + '/article', summary }]);
    const second = await page.evaluate(async () => {
      const host = window.astrisle!;
      const island = await host.createWorkspace({ name: '另一座岛' });
      return host.getDailyNewsMailbox!(island.id);
    });
    expect(second.issues).toHaveLength(0);
    expect(second.settings.enabled).toBe(false);
    expect(calls).toHaveLength(2);
    await page.evaluate(async (id) => {
      const host = window.astrisle!;
      const { settings } = await host.getDailyNewsMailbox!(id);
      await host.setDailyNewsSettings!(id, { ...settings, enabled: false });
    }, id);
  } finally {
    await app?.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});
