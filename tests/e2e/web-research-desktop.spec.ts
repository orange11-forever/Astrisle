import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchIsolatedElectron } from '../fixtures/electron';
import { reviewProject, seedReview } from '../fixtures/review-project';
import { RuntimeStore } from '../../packages/persistence/src/index';
import { createWorkspaceStorage } from '../../packages/workspace/src/index';

test('desktop stores the authorized search service and rejects an invalid endpoint', async ({}, testInfo) => {
  const dataRoot = testInfo.outputPath('runtime');
  await mkdir(dataRoot, { recursive: true });
  const workspace = await createWorkspaceStorage({ name: '网页调研岛' }, dataRoot);
  const store = new RuntimeStore(dataRoot);
  try {
    store.addWorkspace(workspace);
  } finally {
    store.close();
  }
  await writeFile(
    join(dataRoot, 'provider.json'),
    JSON.stringify({
      version: 1,
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'isolated-fixture',
    }),
  );
  const app = await launchIsolatedElectron(dataRoot);
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.getByLabel('切换岛屿')).toHaveValue(workspace.id);
    await page.getByRole('button', { name: '2D 模式', exact: true }).click();
    await page.getByRole('button', { name: '新委托', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建委托' });
    await dialog.getByLabel('工作目标').fill('整理网页调研资料');
    await dialog.getByLabel('验收条件（每行一项）').fill('标明资料来源');
    await dialog.getByText('权限与工作预算', { exact: true }).click();
    const grant = dialog.getByLabel('允许访问网络');
    const endpoint = dialog.getByLabel('SearXNG 搜索地址（可选）');
    const hosts = dialog.getByLabel('网页来源域名（英文逗号分隔）');
    await expect(grant).not.toBeChecked();
    await expect(endpoint).toBeDisabled();
    await expect(hosts).toBeDisabled();
    await grant.check();
    await hosts.fill('docs.example.org, archive.example.org');
    await endpoint.fill('https://user@search.example.org/search');
    await dialog.getByRole('button', { name: '提交委托' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(endpoint).toBeFocused();
    expect((await page.evaluate(() => window.astrisle!.bootstrap())).commissions).toEqual([]);

    await endpoint.fill('https://search.example.org/search');
    await hosts.clear();
    await dialog.getByRole('button', { name: '提交委托' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(hosts).toBeFocused();
    await hosts.fill('https://docs.example.org/read');
    await dialog.getByRole('button', { name: '提交委托' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(hosts).toBeFocused();
    await hosts.fill('docs.example.org, archive.example.org');
    await grant.uncheck();
    await expect(endpoint).toBeDisabled();
    await grant.check();
    await dialog.getByRole('button', { name: '提交委托' }).click();
    await expect(dialog).toBeHidden();
    const commission = (await page.evaluate(() => window.astrisle!.bootstrap())).commissions[0];
    expect(commission.scope).toMatchObject({
      allowNetwork: true,
      allowedHosts: ['docs.example.org', 'archive.example.org'],
      searchEndpoint: 'https://search.example.org/search',
    });

    const rejected = await page.evaluate(async (workspaceId) => {
      const submit = (allowNetwork: boolean, searchEndpoint: string, allowedHosts: string[]) => {
        const scope = {
          readRoots: [],
          writeRoots: [],
          allowProcess: false,
          allowNetwork,
          allowedHosts,
          searchEndpoint,
        };
        return window.astrisle!.submit({
          requestId: crypto.randomUUID(),
          workspaceId,
          goal: '无效的调研请求',
          criteria: ['不会执行'],
          planningMode: 'review_first',
          scope,
          budget: { maxSteps: 10, maxMinutes: 1, maxRework: 1 },
        });
      };
      return Promise.allSettled([
        submit(false, 'https://search.example.org/search', ['docs.example.org']),
        submit(true, 'https://user@search.example.org/search', ['docs.example.org']),
        submit(true, 'https://search.example.org/search', []),
        submit(true, 'https://search.example.org/search', ['docs.example.org:80']),
      ]);
    }, workspace.id);
    expect(rejected.every(({ status }) => status === 'rejected')).toBe(true);
    expect((await page.evaluate(() => window.astrisle!.bootstrap())).commissions).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test('historical artifact previews show their own saved web sources and reading evidence', async ({}, testInfo) => {
  const dataRoot = testInfo.outputPath('runtime');
  await mkdir(dataRoot, { recursive: true });
  const { original, current } = await seedReview(dataRoot);
  const oldUrl = 'https://docs.example.org/original';
  const currentUrl = 'https://docs.example.org/revised';
  const oldOutput = 'Saved original webpage content\nOriginal second line';
  const currentOutput = 'Saved revised webpage content\nRevised second line';
  const mismatchedUrl = 'https://docs.example.org/unavailable';
  const store = new RuntimeStore(dataRoot);
  try {
    const project = store.get(reviewProject.commissionId);
    const sources = [
      { artifact: original, url: oldUrl, output: oldOutput },
      { artifact: current, url: currentUrl, output: currentOutput },
    ];
    for (const { artifact, url, output } of sources) {
      const evidenceId = `web-evidence-${artifact.versionId}`;
      project.evidence.push({
        id: evidenceId,
        kind: 'tool',
        summary: 'web_read: success',
        detail: JSON.stringify({
          name: 'web_read',
          args: { url },
          result: { ok: true, output, metadata: { url, status: 200 } },
        }),
        status: 'passed',
        taskId: artifact.taskId,
        artifactVersionIds: [],
        createdAt: artifact.createdAt,
      });
      Object.assign(project.artifacts.find(({ versionId }) => versionId === artifact.versionId)!, {
        webSources: [
          { url, evidenceId },
          ...(artifact === original
            ? [{ url: mismatchedUrl, evidenceId: `web-evidence-${current.versionId}` }]
            : []),
        ],
      });
    }
    store.save(project);
  } finally {
    store.close();
  }

  const app = await launchIsolatedElectron(dataRoot);
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: '2D 模式', exact: true }).click();
    await page.getByRole('button', { name: '展开项目与委托' }).click();
    await page.getByRole('button', { name: '项目说明验收 待验收' }).click();
    await page.getByRole('button', { name: '成果与验收', exact: true }).click();
    const versions = page.getByRole('region', { name: `成果版本 ${reviewProject.file}` });
    const preview = page.getByRole('dialog', { name: reviewProject.file });
    await versions.getByRole('button', { name: `预览第 2 版 ${reviewProject.file}` }).click();
    await preview.getByText('网页来源（1）', { exact: true }).click();
    await preview.getByText(currentUrl, { exact: true }).click();
    await expect(preview.getByLabel('原始读取证据')).toHaveJSProperty('textContent', currentOutput);
    await expect(preview.getByText(oldUrl, { exact: false })).toHaveCount(0);
    await preview.getByRole('button', { name: '关闭对话框' }).click();

    await versions.getByText('版本历史（2）', { exact: true }).click();
    await versions.getByRole('button', { name: `预览第 1 版 ${reviewProject.file}` }).click();
    await preview.getByText('网页来源（2）', { exact: true }).click();
    await preview.getByText(oldUrl, { exact: true }).click();
    await expect(preview.getByLabel('原始读取证据')).toHaveJSProperty('textContent', oldOutput);
    await expect(preview.getByText(`${mismatchedUrl} · 读取证据暂不可用`)).toBeVisible();
    await expect(preview.getByText(currentUrl, { exact: false })).toHaveCount(0);
  } finally {
    await app.close();
  }
});
