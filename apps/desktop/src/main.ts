import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  shell,
  Tray,
} from 'electron';
import { mkdir, copyFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type {
  ArtifactPreview,
  ApplyPreview,
  Bootstrap,
  ProjectSnapshot,
} from '@astrisle/contracts';
import { CredentialStore } from './credentials';
import { isTrustedSender, canOpenExternally } from './security';
import { RuntimeBridge } from './runtime-bridge';
import { CharacterStore } from './characters';

app.setName('Astrisle');
const projectRoot = app.getAppPath();
const dataRoot =
  process.env.ASTRISLE_DATA_ROOT ||
  (app.isPackaged ? app.getPath('userData') : join(projectRoot, '.astrisle-dev'));
app.setPath('userData', dataRoot);
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let bridge: RuntimeBridge;
let closing = false;
const preparedApplies = new Map<string, ApplyPreview>();
const identifier = z.string().min(1).max(200);
const bool = z.boolean();
const budgetSchema = z
  .object({
    maxSteps: z.number().int().min(1).max(10000),
    maxMinutes: z.number().min(1).max(1440),
    maxRework: z.number().int().min(0).max(20),
  })
  .strict();
const scope = z
  .object({
    readRoots: z.array(z.string().max(4096)).max(64),
    writeRoots: z.array(z.string().max(4096)).max(64),
    allowProcess: bool,
    allowNetwork: bool,
    allowedHosts: z.array(z.string().max(255)).max(100),
  })
  .strict();
const submitSchema = z
  .object({
    requestId: identifier,
    workspaceId: identifier,
    goal: z.string().trim().min(1).max(32000),
    criteria: z.array(z.string().min(1).max(2000)).min(1).max(100),
    scope,
    budget: budgetSchema,
    planningMode: z.enum(['auto', 'review_first']),
  })
  .strict();

async function start() {
  await mkdir(dataRoot, { recursive: true });
  const characters = new CharacterStore(dataRoot);
  const vault = new CredentialStore(join(dataRoot, 'provider.json'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  });
  bridge = new RuntimeBridge(join(__dirname, 'runtime.cjs'));
  await bridge.call('initialize', {
    projectRoot,
    dataRoot,
    credentials: await vault.credentials(),
  });
  const devURL = process.env.ASTRISLE_DEV_URL;
  if (devURL && devURL !== 'http://127.0.0.1:5173')
    throw new Error('Unsupported development origin');
  const expectedURL = devURL || pathToFileURL(join(__dirname, '../client/index.html')).href;

  const register = (name: string, handler: (...args: unknown[]) => unknown) =>
    ipcMain.handle(`astrisle:${name}`, async (event, ...args: unknown[]) => {
      if (
        !window ||
        event.sender.id !== window.webContents.id ||
        !isTrustedSender(
          event.senderFrame?.url || '',
          expectedURL,
          event.senderFrame === event.sender.mainFrame,
        )
      )
        throw new Error('Blocked untrusted desktop caller');
      return handler(...args);
    });
  register('bootstrap', async () => ({
    ...(await bridge.call<Bootstrap>('bootstrap')),
    provider: await vault.publicSettings(),
    characters: await characters.profiles(),
  }));
  register('getCharacters', () => characters.profiles());
  register('updateCharacter', (id, patch) => characters.update(id, patch));
  register('loadCharacterModel', (assetId) => characters.loadModel(assetId));
  register('importCharacter', async (rawId) => {
    const id = z.enum(['mori', 'luma', 'user']).parse(rawId);
    const result = await dialog.showOpenDialog(window!, {
      title: '导入角色模型（GLB / 自包含 glTF 2）',
      properties: ['openFile'],
      filters: [{ name: 'GLB / glTF 2 模型', extensions: ['glb', 'gltf'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return characters.importFile(id, result.filePaths[0]);
  });
  register('createWorkspace', (input) =>
    bridge.call(
      'createWorkspace',
      z
        .object({
          name: z.string().trim().min(1).max(100),
          sourcePath: z.string().max(4096).optional(),
        })
        .strict()
        .parse(input),
    ),
  );
  register('chooseDirectory', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: '选择项目目录',
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  register('submit', (input) => bridge.call('submit', submitSchema.parse(input)));
  register('snapshot', (id) => bridge.call('snapshot', identifier.parse(id)));
  register('updateBudget', (id, budget, revision) =>
    bridge.call(
      'updateBudget',
      identifier.parse(id),
      budgetSchema.parse(budget),
      z.number().int().nonnegative().parse(revision),
    ),
  );
  register('control', (id, action) =>
    bridge.call(
      'control',
      identifier.parse(id),
      z.enum(['pause', 'resume', 'cancel']).parse(action),
    ),
  );
  register('answer', (id, answer, approve) =>
    bridge.call(
      'answer',
      identifier.parse(id),
      z.string().max(32000).parse(answer),
      z.boolean().optional().parse(approve),
    ),
  );
  register('revise', (id, instruction, revision) =>
    bridge.call(
      'revise',
      identifier.parse(id),
      z.string().trim().min(1).max(32000).parse(instruction),
      z.number().int().nonnegative().parse(revision),
    ),
  );
  register('accept', (id, artifacts) =>
    bridge.call(
      'accept',
      identifier.parse(id),
      z.array(identifier).min(1).max(500).parse(artifacts),
    ),
  );
  register('artifact', (id) => bridge.call('artifact', identifier.parse(id)));
  register('openArtifact', async (id) => {
    const artifactId = identifier.parse(id);
    const preview = await bridge.call<ArtifactPreview>('artifact', artifactId);
    if (!canOpenExternally(preview.artifact.name))
      return {
        ok: false,
        code: 'unsafe_open',
        message: '该文件类型请在成果面板查看或导出，不直接执行',
      };
    const source = await bridge.call<string>('resolveArtifactPath', artifactId);
    const directory = join(dataRoot, 'open-previews', preview.artifact.versionId);
    await mkdir(directory, { recursive: true });
    const target = join(directory, basename(preview.artifact.name));
    await copyFile(source, target); // Never let an external editor mutate the immutable artifact.
    const error = await shell.openPath(target);
    return error
      ? { ok: false, message: error }
      : { ok: true, message: '已在默认应用打开可编辑副本；此操作不等于验证通过' };
  });
  register('exportArtifacts', async (id) => {
    const commissionId = identifier.parse(id);
    const selected = await dialog.showOpenDialog(window!, {
      title: '选择导出位置（将创建新文件夹）',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (selected.canceled) return { ok: false, code: 'cancelled', message: '已取消导出' };
    const target = join(
      selected.filePaths[0],
      `Astrisle-${commissionId.slice(0, 8)}-${Date.now()}`,
    );
    const result = await bridge.call('exportWorkspace', commissionId, target);
    return result;
  });
  register('prepareApply', async (id) => {
    const preview = await bridge.call<ApplyPreview>('prepareApply', identifier.parse(id));
    preparedApplies.set(preview.operationId, preview);
    return preview;
  });
  register('apply', async (id) => {
    const operationId = identifier.parse(id);
    const preview = preparedApplies.get(operationId);
    if (!preview?.supported || preview.conflicts.length)
      return {
        ok: false,
        code: 'apply_unavailable',
        message: preview?.reason || '请先取得无冲突且支持的写回预览',
      };
    const result = await dialog.showMessageBox(window!, {
      type: 'question',
      title: '应用到原项目',
      message: `将写入原项目的 ${preview.changes.length} 个文件变更`,
      detail: '此操作独立于接受交付。写入前会再次检查原文件版本。',
      buttons: ['取消', '应用此版本'],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response !== 1) return { ok: false, code: 'cancelled', message: '已取消写回' };
    preparedApplies.delete(operationId);
    return bridge.call('apply', operationId);
  });
  register('saveProvider', async (input) => {
    const settings = await vault.save(input);
    await bridge.call('setCredentials', await vault.credentials());
    return settings;
  });
  register('testProvider', () => bridge.call('testProvider'));

  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#e7eef0',
    title: 'Astrisle · 星岛工作室',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedSender(url, expectedURL, true)) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  bridge.on('snapshot', (snapshot: ProjectSnapshot) => {
    if (window && !window.isDestroyed()) window.webContents.send('astrisle:snapshot', snapshot);
  });
  bridge.on('exit', () => {
    if (!closing && window && !window.isDestroyed())
      dialog
        .showMessageBox(window, {
          type: 'error',
          message: '工作运行时已停止',
          detail: '已保存的数据会保留。请重新启动 Astrisle 核查未完成的工作。',
        })
        .catch(() => {});
  });
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  );
  tray = new Tray(icon);
  tray.setToolTip('Astrisle · 星岛工作室');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开星岛工作室', click: () => window?.show() },
      { label: '退出 Astrisle', click: () => app.quit() },
    ]),
  );
  tray.on('double-click', () => window?.show());
  window.on('close', (event) => {
    if (!closing) {
      event.preventDefault();
      window?.hide();
      tray?.displayBalloon({
        title: 'Astrisle 仍在运行',
        content: '伙伴会继续工作。可从托盘打开，或选择退出 Astrisle。',
      });
    }
  });
  await window.loadURL(expectedURL);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  app.on('before-quit', (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    if (!bridge) {
      app.quit();
      return;
    }
    bridge
      .close()
      .catch((error) => console.error('Shutdown incomplete:', error.message))
      .finally(() => {
        tray?.destroy();
        app.quit();
      });
  });
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      dialog.showErrorBox('Astrisle 启动失败', error.message);
      closing = true;
      app.quit();
    });
}
