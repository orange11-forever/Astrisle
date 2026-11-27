import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  safeStorage,
  shell,
  Tray,
} from 'electron';
import { mkdir, copyFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  findArtifactVersion,
  isSearchEndpoint,
  isSourceHostname,
  isDailyNewsUrl,
  parseDailyNewsSettings,
  PARTNER_DIALOGUE_ERRORS,
  PARTNER_DIALOGUE_LIMITS,
  sourceExportFormats,
} from '@astrisle/contracts';
import type {
  ArtifactPreview,
  ApplyPreview,
  Bootstrap,
  DailyNewsIssue,
  DailyNewsMailbox,
  ProjectSnapshot,
} from '@astrisle/contracts';
import { CredentialStore } from './credentials';
import { isTrustedSender, canOpenExternally } from './security';
import { RuntimeBridge } from './runtime-bridge';
import { comparePage, readPublishedPullRequest } from './git-pr-status';
import type { GitDeliveryReceipt } from '@astrisle/contracts';
import { CharacterStore } from './characters';
import { syncDailyNewsTask, dailyNewsWakeArgv, DailyNewsWakeHandoff } from './daily-news-wake';
import { DailyNewsSubscriptions } from './daily-news-subscriptions';
import type { DailyNewsWakeState } from '../../../packages/runtime/src/daily-news-scheduler';
import { createCharacterInspector } from './character-validator';
import { agentsFromCharacters } from '../../../packages/domain/src/index';

app.setName('Astrisle');
const automation = process.env.ASTRISLE_AUTOMATION === '1';
const modelDemo = process.env.ASTRISLE_MODEL_DEMO === '1';
const initiallyHidden = automation || modelDemo;
const wakeFlag = '--daily-news-background';
const wakeLaunch = process.argv.includes(wakeFlag);
let backgroundOnly = wakeLaunch;
const wakeArgument = (name: string) =>
  process.argv.find((arg) => arg.startsWith(name + '='))?.slice(name.length + 1);
const wakeRoot = wakeLaunch ? wakeArgument('--daily-news-root') : undefined;
const wakeIsland = wakeLaunch ? wakeArgument('--daily-news-island') : undefined;
if (wakeLaunch && (!wakeRoot || !isAbsolute(wakeRoot) || !wakeIsland))
  throw new Error('无效的日报后台启动参数。');
const studioTitle = automation
  ? 'Astrisle · 自动化测试'
  : modelDemo
    ? 'Astrisle · 当前角色演示'
    : 'Astrisle · 星岛工作室';
const projectRoot = app.getAppPath();
const dataRoot =
  wakeRoot ||
  process.env.ASTRISLE_DATA_ROOT ||
  (app.isPackaged ? app.getPath('userData') : join(projectRoot, '.astrisle-dev'));
app.setPath('userData', dataRoot);
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let bridge: RuntimeBridge;
let closing = false;
const wakeHandoff = new DailyNewsWakeHandoff((workspaceId) => {
  app.relaunch({
    args: dailyNewsWakeArgv({ workspaceId, dataRoot, projectRoot, packaged: app.isPackaged }),
  });
});
let subscriptions: DailyNewsSubscriptions | undefined;
const preparedApplies = new Map<string, ApplyPreview>();
const identifier = z.string().min(1).max(200);
const issueDate = z.iso.date();
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
    searchEndpoint: z
      .string()
      .refine(isSearchEndpoint, 'Invalid SearXNG search endpoint')
      .optional(),
  })
  .strict()
  .refine(
    ({ searchEndpoint, allowNetwork, allowedHosts }) =>
      !searchEndpoint ||
      (allowNetwork && allowedHosts.length > 0 && allowedHosts.every(isSourceHostname)),
    {
      path: ['searchEndpoint'],
      message: 'A search endpoint requires network permission and valid source hostnames',
    },
  );
const submitSchema = z
  .object({
    requestId: identifier,
    workspaceId: identifier,
    goal: z.string().trim().min(1).max(32000),
    criteria: z.array(z.string().min(1).max(2000)).min(1).max(100),
    scope,
    budget: budgetSchema,
    planningMode: z.enum(['auto', 'review_first']),
    gitDeliveryRequested: z.boolean().optional(),
  })
  .strict();

async function start() {
  const schedule = (workspaceId: string, time: string | null) => {
    if (modelDemo || (automation && process.env.ASTRISLE_TEST_DAILY_NEWS_TASKS !== '1'))
      return Promise.resolve();
    return syncDailyNewsTask({
      dataRoot,
      workspaceId,
      time,
      executable: process.execPath,
      projectRoot,
      packaged: app.isPackaged,
    });
  };
  if (
    wakeLaunch &&
    !(await stat(join(dataRoot, 'astrisle.sqlite')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }))
  ) {
    await schedule(wakeIsland!, null);
    if (backgroundOnly) {
      app.quit();
      return;
    }
  }
  await mkdir(dataRoot, { recursive: true });
  const characters = new CharacterStore(dataRoot, createCharacterInspector(__dirname));
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
  const wakeState = () => bridge.call<DailyNewsWakeState>('getDailyNewsWakeState');
  subscriptions = new DailyNewsSubscriptions({
    read: (id) => bridge.call<DailyNewsMailbox>('getDailyNewsMailbox', id),
    save: (id, settings) => bridge.call<DailyNewsMailbox>('setDailyNewsSettings', id, settings),
    schedule,
    state: wakeState,
    acknowledgeRemoval: (id) => bridge.call('ackDailyNewsTaskCleanup', id),
  });
  powerMonitor.on('resume', () => {
    if (!closing) void bridge.call('resumeDailyNews').catch(() => {});
  });
  if (wakeLaunch) {
    await bridge.call('resumeDailyNews');
    await subscriptions.reconcileWake(wakeIsland!);
    let state = await wakeState();
    while (backgroundOnly && !closing && state.pending) {
      await delay(1000);
      if (!closing) state = await wakeState();
    }
    if (backgroundOnly || closing) {
      if (!closing) app.quit();
      return;
    }
  }
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
  register('getDailyNewsMailbox', (id) => bridge.call('getDailyNewsMailbox', identifier.parse(id)));
  register('setDailyNewsSettings', (id, settings) =>
    subscriptions!.update(identifier.parse(id), parseDailyNewsSettings(settings)),
  );
  register('getDailyNewsIssue', (id, date) =>
    bridge.call('getDailyNewsIssue', identifier.parse(id), issueDate.parse(date)),
  );
  register('retryDailyNews', (id, date) =>
    bridge.call('retryDailyNews', identifier.parse(id), issueDate.parse(date)),
  );
  register('openDailyNewsSource', async (id, date, rawUrl) => {
    const url = z.string().refine(isDailyNewsUrl).parse(rawUrl);
    const issue = await bridge.call<DailyNewsIssue>(
      'getDailyNewsIssue',
      identifier.parse(id),
      issueDate.parse(date),
    );
    if (issue.status !== 'delivered' || !issue.items.some((item) => item.url === url))
      throw new Error('找不到这期日报中的原文。');
    await shell.openExternal(url);
  });
  register('createCharacter', (displayName) => characters.create(displayName));
  register('updateCharacter', (id, patch) => characters.update(id, patch));
  register('loadCharacterModel', (assetId) => characters.loadModel(assetId));
  register('completeCharacterImport', (id, token, inspection) =>
    characters.completeImport(id, token, inspection),
  );
  register('cancelCharacterImport', (token) => characters.cancelImport(token));
  register('prepareCharacterImport', async (rawId) => {
    const id = await characters.registeredId(rawId);
    const result = await dialog.showOpenDialog(window!, {
      title: '导入角色模型',
      properties: ['openFile'],
      filters: [
        {
          name: '角色模型（GLB / glTF / 3MF / STL / OBJ / FBX）',
          extensions: ['glb', 'gltf', '3mf', 'stl', 'obj', 'fbx'],
        },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return characters.prepareImport(id, result.filePaths[0]);
  });
  register('importCharacter', async (rawId) => {
    const id = await characters.registeredId(rawId);
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
  register('submit', async (input) =>
    bridge.call(
      'submit',
      submitSchema.parse(input),
      agentsFromCharacters(await characters.profiles()),
    ),
  );
  register('snapshot', (id) => bridge.call('snapshot', identifier.parse(id)));
  register('askPartner', async (raw) => {
    const question = z.string().trim().min(1).max(PARTNER_DIALOGUE_LIMITS.question);
    const parsed = z
      .strictObject({
        commissionId: identifier,
        partnerId: identifier,
        question,
        history: z
          .array(
            z.strictObject({
              question,
              answer: z.string().trim().min(1).max(PARTNER_DIALOGUE_LIMITS.answer),
            }),
          )
          .max(PARTNER_DIALOGUE_LIMITS.history)
          .optional(),
      })
      .safeParse(raw);
    if (!parsed.success) throw new Error(PARTNER_DIALOGUE_ERRORS.invalid_partner_dialogue);
    const input = parsed.data;
    const profiles = await characters.profiles();
    return bridge.call(
      'askPartner',
      input,
      Object.fromEntries(profiles.map(({ id, displayName }) => [id, displayName])),
    );
  });
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
  register('exportSourceArtifact', async (raw) => {
    const input = z
      .object({
        commissionId: identifier,
        versionId: identifier,
        format: z.enum(['docx', 'pptx', 'xlsx']),
      })
      .strict()
      .parse(raw);
    const snapshot = await bridge.call<ProjectSnapshot>('snapshot', input.commissionId);
    const source = findArtifactVersion(snapshot, input.versionId);
    if (!source || source.validity === 'missing')
      return { ok: false, code: 'source_unavailable', message: '源稿版本不可用' };
    if (!sourceExportFormats(source.relativePath).includes(input.format))
      return { ok: false, code: 'unsupported_format', message: '该源稿不支持所选格式' };
    const selected = await dialog.showSaveDialog(window!, {
      title: '从所选源稿生成文件',
      defaultPath: basename(source.relativePath, extname(source.relativePath)) + '.' + input.format,
      filters: [{ name: input.format.toUpperCase(), extensions: [input.format] }],
      properties: ['showOverwriteConfirmation'],
    });
    if (selected.canceled || !selected.filePath)
      return { ok: false, code: 'cancelled', message: '已取消生成' };
    return bridge.call('exportSourceArtifact', input, selected.filePath);
  });
  register('compareArtifacts', (input) =>
    bridge.call(
      'compareArtifacts',
      z
        .object({
          commissionId: identifier,
          fromVersionId: identifier,
          toVersionId: identifier,
        })
        .strict()
        .parse(input),
    ),
  );
  register('requestArtifactRework', (input) =>
    bridge.call(
      'requestArtifactRework',
      z
        .object({
          commissionId: identifier,
          artifactId: identifier,
          versionId: identifier,
          revision: z.number().int().nonnegative(),
          instruction: z.string().trim().min(1).max(4000),
          requestId: identifier,
        })
        .strict()
        .parse(input),
    ),
  );
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
  register('prepareGitDelivery', (id) => bridge.call('prepareGitDelivery', identifier.parse(id)));
  register('latestGitDelivery', (id) => bridge.call('latestGitDelivery', identifier.parse(id)));
  const gitReceipt = async (id: string, op: string) => {
    const receipt = await bridge.call<GitDeliveryReceipt | null>('latestGitDelivery', id);
    if (!receipt || receipt.preview.operationId !== op || receipt.preview.commissionId !== id)
      throw new Error('Git 预览已变更，请重新打开交付记录。');
    return receipt;
  };
  register('inspectGitDelivery', (rawId, rawOp) =>
    bridge.call('inspectGitDelivery', identifier.parse(rawId), z.uuid().parse(rawOp)),
  );
  register('publishGitDelivery', async (rawId, rawOp) => {
    const id = identifier.parse(rawId),
      op = z.uuid().parse(rawOp);
    let receipt = await gitReceipt(id, op);
    if (receipt.status === 'unknown')
      receipt = await bridge.call<GitDeliveryReceipt>('inspectGitDelivery', id, op);
    if (receipt.status === 'published' || receipt.status === 'blocked') return receipt;
    const { remote, baseBranch, baseCommit, targetBranch, changes } = receipt.preview;
    const choice = await dialog.showMessageBox(window!, {
      type: 'question',
      title: '确认 Git 推送',
      message:
        receipt.status === 'unknown'
          ? '重新核查远端，并用原交付编号重试推送？'
          : `推送已验收的 ${changes.length} 个文件变更？`,
      detail: `远端：${remote}\n基线：${baseBranch} · ${baseCommit}\n新分支：${targetBranch}`,
      buttons: ['取消', '推送新分支'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice.response !== 1) return null;
    await gitReceipt(id, op);
    return bridge.call('publishGitDelivery', id, op);
  });
  register('getGitPullRequestStatus', async (rawId, rawOp) =>
    readPublishedPullRequest(await gitReceipt(identifier.parse(rawId), z.uuid().parse(rawOp))),
  );
  register('openGitDeliveryOnGitHub', async (rawId, rawOp, rawTarget) => {
    const target = z.enum(['compare', 'pr']).parse(rawTarget);
    const receipt = await gitReceipt(identifier.parse(rawId), z.uuid().parse(rawOp));
    if (
      target === 'compare' &&
      !(await bridge.call<boolean>(
        'matchesPublishedGitHead',
        receipt.preview.commissionId,
        receipt.preview.operationId,
      ))
    )
      throw new Error('远端分支已移动或已删除，请先核查交付记录。');
    const url =
      target === 'compare' ? comparePage(receipt) : (await readPublishedPullRequest(receipt))?.url;
    if (!url) throw new Error('还没有关联到这次提交的 PR。');
    await shell.openExternal(url);
  });
  register('prepareApply', async (id) => {
    const preview = await bridge.call<ApplyPreview>('prepareApply', identifier.parse(id));
    preparedApplies.set(preview.operationId, preview);
    return preview;
  });
  register('inspectApply', (id) => bridge.call('inspectApply', identifier.parse(id)));
  register('prepareRollback', async (id) => {
    const preview = await bridge.call<ApplyPreview>('prepareRollback', identifier.parse(id));
    preparedApplies.set(preview.operationId, preview);
    return preview;
  });
  register('openApplyBackups', async (id) => {
    const directory = await bridge.call<string>('resolveApplyDirectory', identifier.parse(id));
    const error = await shell.openPath(directory);
    return error
      ? { ok: false, message: error }
      : { ok: true, message: '已打开备份与恢复记录目录' };
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
      title: preview.mode === 'rollback' ? '恢复写回前的文件' : '应用到原项目',
      message:
        preview.mode === 'rollback'
          ? `将恢复本次写回涉及的 ${preview.changes.length} 个文件`
          : `将写入原项目的 ${preview.changes.length} 个文件变更`,
      detail: `${preview.sourcePath ?? ''}\n${preview.mode === 'rollback' ? '恢复会重新核对文件身份与内容，后续修改不会被覆盖。' : '此操作独立于接受交付。写入前会再次检查原文件版本。'}`,
      buttons: ['取消', preview.mode === 'rollback' ? '恢复这些文件' : '应用此版本'],
      defaultId: 0,
      cancelId: 0,
    });
    if (result.response !== 1)
      return {
        ok: false,
        code: 'cancelled',
        message: preview.mode === 'rollback' ? '已取消恢复' : '已取消写回',
      };
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
    title: studioTitle,
    autoHideMenuBar: true,
    show: !initiallyHidden,
    ...(automation ? { skipTaskbar: true, focusable: false } : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: !initiallyHidden,
    },
  });
  if (initiallyHidden) {
    window.accessibleTitle = studioTitle;
    window.on('page-title-updated', (event) => event.preventDefault());
  }
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
    if (closing || !window || window.isDestroyed()) return;
    if (automation || (modelDemo && !window.isVisible())) {
      console.error(`${studioTitle} runtime stopped`);
      return;
    }
    dialog
      .showMessageBox(window, {
        type: 'error',
        message: '工作运行时已停止',
        detail: '已保存的数据会保留。请重新启动 Astrisle 核查未完成的工作。',
      })
      .catch(() => {});
  });
  if (!initiallyHidden) {
    const icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    );
    tray = new Tray(icon);
    tray.setToolTip(studioTitle);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开星岛工作室', click: () => window?.show() },
        { label: '退出 Astrisle', click: () => app.quit() },
      ]),
    );
    tray.on('double-click', () => window?.show());
  }
  window.on('close', (event) => {
    if (closing) return;
    event.preventDefault();
    if (modelDemo) {
      app.quit();
      return;
    }
    window?.hide();
    tray?.displayBalloon({
      title: 'Astrisle 仍在运行',
      content: '伙伴会继续工作。可从托盘打开，或选择退出 Astrisle。',
    });
  });
  await window.loadURL(expectedURL);
  void subscriptions.restore().catch((error) => console.error('无法恢复日报唤醒计划', error));
}

if (!automation && !app.requestSingleInstanceLock()) app.quit();
else {
  if (!initiallyHidden)
    app.on('second-instance', (_event, argv) => {
      if (argv.includes(wakeFlag)) {
        const id = argv
          .find((arg) => arg.startsWith('--daily-news-island='))
          ?.slice('--daily-news-island='.length);
        if (!id || id.length > 200) return;
        wakeHandoff.received(id, closing);
        if (!closing && subscriptions)
          void subscriptions
            .reconcileWake(id)
            .then(() => bridge.call('resumeDailyNews'))
            .catch((error) => console.error('日报唤醒失败', error));
        return;
      }
      backgroundOnly = false;
      if (closing) {
        app.relaunch({ args: app.isPackaged ? [] : [projectRoot] });
        return;
      }
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
    Promise.resolve(subscriptions?.settle())
      .then(() =>
        wakeHandoff.beforeExit(
          async () => (await bridge.call<DailyNewsWakeState>('getDailyNewsWakeState')).pending,
        ),
      )
      .then(() => bridge.close())
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
      if (initiallyHidden || backgroundOnly)
        console.error(`${studioTitle} startup failed:`, error.message);
      else dialog.showErrorBox('Astrisle 启动失败', error.message);
      if (backgroundOnly) {
        closing = true;
        void Promise.resolve(bridge?.close())
          .catch(() => {})
          .finally(() => app.exit(1));
      } else {
        closing = true;
        app.quit();
      }
    });
}
