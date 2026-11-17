import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createWorkspaceStorage } from '../../packages/workspace/src/index';
import { RuntimeStore } from '../../packages/persistence/src/index';
import { publishArtifact } from '../../packages/artifacts/src/index';
import type { ProjectSnapshot } from '../../packages/contracts/src/index';

test('desktop requires native confirmation, writes accepted files and restores with durable history', async () => {
  await mkdir(resolve('test-results'), { recursive: true });
  const root = await realpath(await mkdtemp(resolve('test-results/safe-writeback-')));
  const source = join(root, 'source'),
    dataRoot = join(root, 'data');
  await mkdir(join(source, '.git'), { recursive: true });
  await writeFile(join(source, '.git/HEAD'), 'preserve git');
  await writeFile(join(source, 'dirty.txt'), 'unsaved original');
  const workspace = await createWorkspaceStorage(
    { name: '写回验证', sourcePath: source },
    dataRoot,
  );
  await writeFile(join(workspace.workPath, 'dirty.txt'), 'accepted update');
  await mkdir(join(workspace.workPath, 'new'));
  await writeFile(join(workspace.workPath, 'new/result.txt'), 'new accepted file');
  const artifacts = await Promise.all(
    ['dirty.txt', 'new/result.txt'].map((path) =>
      publishArtifact(dataRoot, workspace.workPath, path, {
        commissionId: 'writeback-ui',
        taskId: 'author',
        name: path,
        mediaType: 'text/plain',
        inputVersions: [],
      }),
    ),
  );
  const snapshot: ProjectSnapshot = {
    workspace,
    agents: [],
    tasks: [],
    artifacts,
    evidence: artifacts.map((a) => ({
      id: a.id,
      kind: 'review',
      summary: 'Verified fixture',
      detail: '{}',
      status: 'passed',
      artifactVersionIds: [a.versionId],
      createdAt: new Date().toISOString(),
    })),
    events: [],
    requests: [],
    lastSequence: 0,
    commission: {
      id: 'writeback-ui',
      workspaceId: workspace.id,
      title: '写回测试',
      goal: '写回测试',
      status: 'accepted',
      criteria: [{ id: 'c1', description: 'Updated files' }],
      scope: {
        readRoots: [],
        writeRoots: [],
        allowProcess: false,
        allowNetwork: false,
        allowedHosts: [],
      },
      budget: { maxSteps: 10, maxMinutes: 1, maxRework: 1 },
      revision: 1,
      planningMode: 'auto',
      stepsUsed: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      acceptedArtifactIds: artifacts.map((a) => a.id),
      summary: 'Accepted',
    },
  };
  const store = new RuntimeStore(dataRoot);
  store.addWorkspace(workspace);
  store.save(snapshot);
  store.close();
  const app = await electron.launch({
    args: [resolve('.')],
    env: { ...process.env, ASTRISLE_DATA_ROOT: dataRoot, ASTRISLE_DEV_URL: '' },
    timeout: 30000,
  });
  try {
    await app.evaluate(({ BrowserWindow, dialog }) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.setTitle('Astrisle · 自动化写回测试');
        window.hide();
      }
      (globalThis as any).confirmation = 0;
      dialog.showMessageBox = async (first: any, options?: any) => {
        (globalThis as any).lastConfirmation = options ?? first;
        return { response: (globalThis as any).confirmation, checkboxChecked: false };
      };
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.waitForFunction(() => !!window.astrisle);
    await page.getByRole('button', { name: '展开项目与委托' }).click();
    await page.getByRole('button', { name: '写回测试 已接受' }).click();
    await page.getByRole('button', { name: '成果与验收', exact: true }).click();
    await page.getByRole('button', { name: '预览写回原项目' }).click();
    const dialog = page.getByRole('dialog', { name: '确认写回原项目' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(source);
    await dialog.getByText('查看内容对比', { exact: true }).first().click();
    await expect(dialog).toContainText('unsaved original');
    await expect(dialog).toContainText('accepted update');
    await page.screenshot({ path: 'test-results/safe-writeback-preview.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: 'test-results/safe-writeback-preview-narrow.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 960 });
    await dialog.getByRole('button', { name: '确认写回 2 项更改' }).click();
    await expect(page.getByRole('status')).toContainText('已取消写回');
    expect(await readFile(join(source, 'dirty.txt'), 'utf8')).toBe('unsaved original');
    await app.evaluate(() => {
      (globalThis as any).confirmation = 1;
    });
    await dialog.getByRole('button', { name: '确认写回 2 项更改' }).click();
    await expect(dialog).not.toBeVisible();
    expect(await readFile(join(source, 'dirty.txt'), 'utf8')).toBe('accepted update');
    expect(await readFile(join(source, 'new/result.txt'), 'utf8')).toBe('new accepted file');
    expect(await readFile(join(source, '.git/HEAD'), 'utf8')).toBe('preserve git');
    const history = page.getByRole('region', { name: '写回记录' });
    await expect(history).toContainText('写回完成');
    await history.locator('summary').first().click();
    await history.getByRole('button', { name: '准备恢复' }).click();
    const rollback = page.getByRole('dialog', { name: '确认恢复写回前的文件' });
    await expect(rollback).toBeVisible();
    await rollback.getByRole('button', { name: '确认恢复 2 项更改' }).click();
    await expect(rollback).not.toBeVisible();
    expect(await readFile(join(source, 'dirty.txt'), 'utf8')).toBe('unsaved original');
    await expect(readFile(join(source, 'new/result.txt'))).rejects.toThrow();
    const confirmation = await app.evaluate(() => (globalThis as any).lastConfirmation);
    expect(confirmation.title).toBe('恢复写回前的文件');
    expect(confirmation.defaultId).toBe(0);
    expect(confirmation.detail).toContain(source);
    await expect(history).toContainText('已恢复');
    await page.reload();
    await page.getByRole('button', { name: '展开项目与委托' }).click();
    await page.getByRole('button', { name: '写回测试 已接受' }).click();
    await page.getByRole('button', { name: '成果与验收', exact: true }).click();
    await expect(page.getByRole('region', { name: '写回记录' })).toContainText('已恢复');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
