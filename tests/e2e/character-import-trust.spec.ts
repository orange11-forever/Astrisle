import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeGlb, characterBytes, characterDocument } from '../fixtures/character-model';
import { threeMf, texturedFbx } from '../fixtures/character-formats';

test('main rejects invalid staged geometry despite forged metadata and uses its own counts', async () => {
  await mkdir(resolve('test-results'), { recursive: true });
  const dataRoot = await mkdtemp(resolve('test-results', 'character-trust-'));
  const source = join(dataRoot, 'model.glb');
  await writeFile(source, makeGlb());
  const invalid = join(dataRoot, 'invalid.obj');
  await writeFile(invalid, 'not a mesh');
  const valid = join(dataRoot, 'valid.obj');
  await writeFile(valid, 'v 0 0 0\nv 1 0 0\nv 0 2 0\nf 1 2 3\n');
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZFEAAAAASUVORK5CYII=';
  const gltf = characterDocument();
  gltf.buffers[0].uri = `data:application/octet-stream;base64,${characterBytes().toString('base64')}`;
  const embeddedSources = [
    ['embedded.3mf', threeMf({ texture: png }), 0],
    ['embedded.fbx', Buffer.from(texturedFbx(png)), 1],
    ['embedded.gltf', Buffer.from(JSON.stringify(gltf)), 0],
  ] as const;
  for (const [name, bytes] of embeddedSources) await writeFile(join(dataRoot, name), bytes);
  const app = await electron.launch({
    args: [resolve('.')],
    env: { ...process.env, ASTRISLE_DATA_ROOT: dataRoot, ASTRISLE_DEV_URL: '' },
    timeout: 30_000,
  });
  try {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((window) => window.hide()),
    );
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.astrisle);
    const choose = (path: string) =>
      app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, path);
    await choose(source);
    const baseline = await page.evaluate(() => window.astrisle!.importCharacter!('mori'));
    await choose(invalid);
    const failed = await page.evaluate(async () => {
      try {
        const pending = await window.astrisle!.prepareCharacterImport!('mori');
        await window.astrisle!.completeCharacterImport!('mori', pending!.importId, {
          triangleCount: 1,
          animationCount: 0,
          hasSkins: false,
        });
        return false;
      } catch {
        return true;
      }
    });
    expect(failed).toBe(true);
    expect((await page.evaluate(() => window.astrisle!.getCharacters!()))[0].model?.assetId).toBe(
      baseline?.model?.assetId,
    );
    await choose(valid);
    const result = await page.evaluate(async () => {
      const pending = await window.astrisle!.prepareCharacterImport!('mori');
      return window.astrisle!.completeCharacterImport!('mori', pending!.importId, {
        triangleCount: 999,
        animationCount: 777,
        hasSkins: true,
      });
    });
    expect(result.model).toMatchObject({ triangleCount: 1, animationCount: 0, hasSkins: false });
    for (const [name, , animationCount] of embeddedSources) {
      await choose(join(dataRoot, name));
      const result = await page.evaluate(async () => {
        const pending = await window.astrisle!.prepareCharacterImport!('mori');
        return window.astrisle!.completeCharacterImport!('mori', pending!.importId, {
          triangleCount: 999,
          animationCount: 777,
          hasSkins: true,
        });
      });
      expect(result.model).toMatchObject({ triangleCount: 1, animationCount, hasSkins: false });
    }
    const forgedValidator = await app.evaluate(async ({ BrowserWindow }) => {
      const attacker = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
      });
      try {
        await attacker.loadURL('about:blank');
        return await attacker.webContents.executeJavaScript(
          `Promise.all(['read','report'].map(async (method) => {try {await require('electron').ipcRenderer.invoke('astrisle:private-character-validator:'+method,{inspection:{triangleCount:999,animationCount:777,hasSkins:true}});return false;}catch{return true;}}))`,
        );
      } finally {
        attacker.destroy();
      }
    });
    expect(forgedValidator).toEqual([true, true]);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
