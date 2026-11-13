import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, unlink, readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { makeGlb } from '../fixtures/character-model';

test('desktop starts with a real isolated runtime and preserves workspace across renderer reload', async () => {
  await mkdir(resolve('test-results'), { recursive: true });
  const dataRoot = await mkdtemp(resolve('test-results', 'desktop-data-'));
  const modelSource = join(dataRoot, 'source-model.glb');
  await writeFile(modelSource, makeGlb());
  const app = await electron.launch({
    args: [resolve('.')],
    env: { ...process.env, ASTRISLE_DATA_ROOT: dataRoot, ASTRISLE_DEV_URL: '' },
    timeout: 30_000,
  });
  try {
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.hide();
    });
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
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    }, modelSource);
    const imported = await page.evaluate(() => window.astrisle!.importCharacter!('mori'));
    expect(imported?.model?.triangleCount).toBe(1);
    await page.evaluate(() =>
      window.astrisle!.updateCharacter!('mori', { displayName: '测试伙伴' }),
    );
    await unlink(modelSource);
    await page.reload();
    await expect
      .poll(async () => (await page.evaluate(() => window.astrisle!.bootstrap())).workspaces.length)
      .toBe(2);
    const after = await page.evaluate(() => window.astrisle!.bootstrap());
    expect(after.workspaces.map((item) => item.id)).toEqual(
      expect.arrayContaining([workspace.id, second.id]),
    );
    expect(after.commissions).toHaveLength(0);
    const character = after.characters!.find((profile) => profile.id === 'mori')!;
    expect(character.displayName).toBe('测试伙伴');
    expect(character.model!.assetId).toBe(imported!.model!.assetId);
    const header = await page.evaluate(async (assetId) => {
      const bytes = await window.astrisle!.loadCharacterModel!(assetId);
      return Array.from(bytes.subarray(0, 4));
    }, character.model!.assetId);
    expect(header).toEqual([103, 108, 84, 70]);
    await page.waitForTimeout(1500); // Allow static first-frame lighting to settle for a visual artifact.
    await page.screenshot({ path: 'test-results/desktop-studio.png', fullPage: true });
    const rendererNode = await page.evaluate(
      () => typeof (window as unknown as { require?: unknown }).require,
    );
    expect(rendererNode).toBe('undefined');

    // Exercise the delivery routes after moving them inside the runtime's shutdown boundary.
    await writeFile(join(workspace.workPath, 'delivery.txt'), 'Real desktop export');
    const receipt = await page.evaluate(
      (workspaceId) =>
        window.astrisle!.submit({
          requestId: 'desktop-export',
          workspaceId,
          goal: 'Export the current project',
          criteria: ['Preserve the file bytes'],
          planningMode: 'review_first',
          scope: {
            readRoots: [],
            writeRoots: [],
            allowProcess: false,
            allowNetwork: false,
            allowedHosts: [],
          },
          budget: { maxSteps: 10, maxMinutes: 1, maxRework: 1 },
        }),
      workspace.id,
    );
    expect(receipt.ok).toBe(true);
    const exportRoot = join(dataRoot, 'exports');
    await mkdir(exportRoot);
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, exportRoot);
    expect(
      (await page.evaluate((id) => window.astrisle!.exportArtifacts(id), receipt.commissionId!)).ok,
    ).toBe(true);
    const exported = await readdir(exportRoot);
    expect(exported).toHaveLength(1);
    expect(await readFile(join(exportRoot, exported[0], 'delivery.txt'), 'utf8')).toBe(
      'Real desktop export',
    );
    const apply = await page.evaluate(
      (id) => window.astrisle!.prepareApply(id),
      receipt.commissionId!,
    );
    expect(apply.supported).toBe(false);
    expect(apply.changes.some((change) => change.path === 'delivery.txt')).toBe(true);
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
