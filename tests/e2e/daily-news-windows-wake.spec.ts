import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { dailyNewsTaskName, syncDailyNewsTask } from '../../apps/desktop/src/daily-news-wake';
import { launchIsolatedElectron } from '../fixtures/electron';

test.skip(
  process.platform !== 'win32' || process.env.ASTRISLE_TEST_DAILY_NEWS_TASKS !== '1',
  'Validate a real scheduled wake only when explicitly opted in on Windows.',
);

const run = promisify(execFile);
const powershell = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

interface TaskProbe {
  time: string;
  days: number;
  signInTrigger: boolean;
  interactiveOwner: boolean;
  executable: string;
  arguments: string;
  directory: string;
  lastRun: string;
  lastResult: number;
  state: string;
  processes: { id: number; mainWindowHandle: number }[];
}

async function probeTask(name: string, root: string): Promise<TaskProbe | null> {
  const payload = Buffer.from(JSON.stringify({ name, root }), 'utf8').toString('base64');
  const script = `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
    $task = Get-ScheduledTask -TaskPath '\\' -TaskName $payload.name -ErrorAction SilentlyContinue
    if (!$task) { 'null'; exit 0 }
    $info = $task | Get-ScheduledTaskInfo
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = $task.Principal.UserId
    $interactiveOwner = ($task.Principal.LogonType -eq 'Interactive') -and
      ($principal -in @($identity.Name, $identity.User.Value, $env:USERNAME))
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" | ForEach-Object {
      $line = $_.CommandLine
      if ($line -and $line.Contains('--daily-news-root=' + $payload.root) -and !$line.Contains('--type=')) {
        $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        if ($process) { @{ id = $process.Id; mainWindowHandle = $process.MainWindowHandle.ToInt64() } }
      }
    })
    @{
      time = $task.Triggers[0].StartBoundary
      days = $task.Triggers[0].DaysInterval
      signInTrigger = $task.Triggers[1].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger'
      interactiveOwner = $interactiveOwner
      executable = $task.Actions[0].Execute
      arguments = $task.Actions[0].Arguments
      directory = $task.Actions[0].WorkingDirectory
      lastRun = $info.LastRunTime.ToUniversalTime().ToString('o')
      lastResult = $info.LastTaskResult
      state = [string]$task.State
      processes = $processes
    } | ConvertTo-Json -Compress
  `;
  const { stdout } = await run(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, timeout: 15_000 },
  );
  return JSON.parse(stdout) as TaskProbe | null;
}

function archive(root: string, island: string, date: string) {
  const db = new DatabaseSync(join(root, 'astrisle.sqlite'), { readOnly: true });
  try {
    return db
      .prepare('SELECT status, items FROM daily_news_issues WHERE workspace_id = ? AND date = ?')
      .get(island, date);
  } finally {
    db.close();
  }
}

function wallTime(date: Date) {
  const two = (value: number) => String(value).padStart(2, '0');
  return {
    day: `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`,
    time: `${two(date.getHours())}:${two(date.getMinutes())}`,
  };
}

test('the Windows clock starts a hidden daily-news process after Electron quits', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const profile = testInfo.outputPath('windows-wake-profile');
  await mkdir(profile, { recursive: true });
  const root = await realpath(profile);
  expect(root.toLowerCase()).not.toBe(resolve('.astrisle-dev').toLowerCase());
  const title = '花港灯塔完成修缮';
  const text = '花港完成灯塔修缮，傍晚恢复亮灯。';
  const tools: string[] = [];
  const errors: unknown[] = [];
  let phase: 'enrollment' | 'wake' | 'serve' = 'enrollment';
  let firstRead = false;
  let wakeReadAt = 0;
  let pendingFeed: ServerResponse | undefined;
  let articleReads = 0;
  let origin = '';
  let scheduled = new Date();
  const feed = (response: ServerResponse) =>
    response
      .writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
      .end(
        `<rss version="2.0"><channel><item><title>${title}</title><link>${origin}/article</link><pubDate>${scheduled.toUTCString()}</pubDate></item></channel></rss>`,
      );
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/feed') {
        if (phase === 'enrollment') firstRead = true;
        else if (phase === 'wake') {
          wakeReadAt = Date.now();
          pendingFeed = res;
        } else feed(res);
      } else if (req.url === '/article') {
        articleReads++;
        res
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end(
            `<meta property="article:published_time" content="${scheduled.toISOString()}"><article><h1>${title}</h1><p>${text}</p></article>`,
          );
      } else if (req.url === '/v1/chat/completions') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const request = JSON.parse(raw);
        const context = JSON.parse(
          request.messages.find((entry: { role: string }) => entry.role === 'user').content,
        );
        const name = request.tools[0].function.name;
        tools.push(name);
        const args =
          name === 'submit_daily_news'
            ? { items: [{ id: context.sources[0].id, summary: text }] }
            : name === 'review_daily_news'
              ? { acceptedIds: [context.items[0].id] }
              : undefined;
        if (!args) throw new Error('Unexpected model request');
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            choices: [
              {
                message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] },
              },
            ],
          }),
        );
      } else res.writeHead(404).end();
    } catch (error) {
      errors.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let app: ElectronApplication | undefined;
  let taskName: string | undefined;
  let island: string | undefined;
  let executable = '';
  let removed = false;
  try {
    app = await launchIsolatedElectron(root);
    executable = await app.evaluate(() => process.execPath);
    const manualProcess = app.process();
    const page = await app.firstWindow();
    island = await page.evaluate(async (baseUrl) => {
      const api = window.astrisle!;
      await api.saveProvider({
        kind: 'openai-compatible',
        baseUrl,
        model: 'clock-smoke-local',
        apiKey: 'fixture-only-key',
      });
      return (await api.createWorkspace({ name: '独立 Windows 唤醒验收岛' })).id;
    }, origin + '/v1');
    taskName = dailyNewsTaskName(root, island);
    scheduled = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 120_000);
    const { day, time } = wallTime(scheduled);
    const settings = { enabled: true, time, feeds: [origin + '/feed'], topic: '' };
    await page.evaluate(
      ({ island, settings }) => window.astrisle!.setDailyNewsSettings!(island, settings),
      { island, settings },
    );
    await expect.poll(() => firstRead).toBe(true);
    const registered = await probeTask(taskName, root);
    expect(registered).toMatchObject({
      days: 1,
      signInTrigger: true,
      interactiveOwner: true,
      executable,
      directory: resolve('.'),
      time: expect.stringMatching(new RegExp(`T${time}:00`)),
    });
    expect(registered!.arguments).toContain('"--daily-news-background"');
    expect(registered!.arguments).toContain(`"--daily-news-root=${root}"`);
    expect(registered!.arguments).toContain(`"--daily-news-island=${island}"`);
    expect(registered!.arguments).not.toContain('.astrisle-dev');

    await app.close();
    app = undefined;
    expect(manualProcess.exitCode).not.toBeNull();
    expect(Date.now()).toBeLessThan(scheduled.getTime());
    const enrollmentDay = wallTime(new Date()).day;
    expect(archive(root, island, enrollmentDay)?.status).toBe('queued');
    expect(tools).toEqual([]);
    phase = 'wake';
    await expect
      .poll(() => wakeReadAt, {
        timeout: Math.max(30_000, scheduled.getTime() - Date.now() + 40_000),
      })
      .toBeGreaterThanOrEqual(scheduled.getTime() - 1000);
    const awakened = await probeTask(taskName, root);
    expect(awakened).toMatchObject({ state: 'Running', processes: [{ mainWindowHandle: 0 }] });
    expect(Date.parse(awakened!.lastRun)).toBeGreaterThanOrEqual(scheduled.getTime() - 1000);

    phase = 'serve';
    feed(pendingFeed!);
    await expect.poll(() => archive(root, island!, day)?.status).toBe('delivered');
    expect(JSON.parse(archive(root, island, day)!.items as string)).toMatchObject([
      { title, url: origin + '/article', summary: text },
    ]);
    expect(tools).toEqual(['submit_daily_news', 'review_daily_news']);
    expect(articleReads).toBe(2);
    expect(errors).toEqual([]);
    await expect
      .poll(() => probeTask(taskName!, root), { timeout: 30_000 })
      .toMatchObject({ state: 'Ready', lastResult: 0, processes: [] });

    app = await launchIsolatedElectron(root);
    const reopen = await app.firstWindow();
    await reopen.evaluate(
      ({ island, settings }) =>
        window.astrisle!.setDailyNewsSettings!(island, { ...settings, enabled: false }),
      { island, settings },
    );
    expect(await probeTask(taskName, root)).toBeNull();
    removed = true;
    await testInfo.attach('windows-task-clock-wake.json', {
      body: JSON.stringify(
        {
          plannedLocalTime: `${day} ${time}`,
          lastRunUtc: awakened!.lastRun,
          verifiedRequestUtc: new Date(wakeReadAt).toISOString(),
          hiddenProcess: awakened!.processes[0].mainWindowHandle === 0,
          issue: 'delivered',
          removed,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        if (!removed && island)
          await syncDailyNewsTask({
            dataRoot: root,
            workspaceId: island,
            time: null,
            executable,
            projectRoot: resolve('.'),
            packaged: false,
          });
      } finally {
        await new Promise<void>((closed) => {
          server.close(() => closed());
          server.closeAllConnections();
        });
      }
    }
  }
});
