import { BrowserWindow, ipcMain, session } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CharacterImportInspection } from '@astrisle/contracts';
import { MAX_CHARACTER_STORED_BYTES } from '../../../packages/contracts/src/character-asset';
import { isTrustedSender } from './security';

const READ = 'astrisle:private-character-validator:read';
const REPORT = 'astrisle:private-character-validator:report';

/** A parser owned by main, isolated from the UI renderer and from network/filesystem access. */
export function createCharacterInspector(assetRoot: string, timeoutMs = 30_000) {
  const expectedURL = pathToFileURL(join(assetRoot, 'character-validator.html')).href;
  const scriptURL = pathToFileURL(join(assetRoot, 'character-validator.js')).href;
  type Active = { bytes: Uint8Array; window: BrowserWindow; finish: (result: unknown) => void };
  const active = new Map<number, Active>();
  const entry = (event: IpcMainInvokeEvent) => {
    const entry = active.get(event.sender.id);
    if (
      !entry ||
      event.sender !== entry.window.webContents ||
      !isTrustedSender(
        event.senderFrame?.url ?? '',
        expectedURL,
        event.senderFrame === event.sender.mainFrame,
      )
    )
      throw new Error('Blocked untrusted character validator caller');
    return entry;
  };
  ipcMain.handle(READ, (event) => entry(event).bytes);
  ipcMain.handle(REPORT, (event, result: unknown) => {
    entry(event).finish(result);
  });
  let admitted = 0;
  let queue: Promise<unknown> = Promise.resolve();
  return (bytes: Uint8Array): Promise<CharacterImportInspection> => {
    if (bytes.length < 1 || bytes.length > MAX_CHARACTER_STORED_BYTES || admitted >= 3)
      return Promise.reject(new Error('模型验证资源已满或文件过大，请稍后重试'));
    admitted++;
    const validate = async (): Promise<CharacterImportInspection> => {
      const partition = session.fromPartition(`character-validator-${randomUUID()}`, {
        cache: false,
      });
      partition.setPermissionRequestHandler((_webContents, _permission, callback) =>
        callback(false),
      );
      partition.setPermissionCheckHandler(() => false);
      partition.webRequest.onBeforeRequest((details, callback) => {
        callback({
          cancel:
            ![expectedURL, scriptURL].includes(details.url) &&
            !/^(?:data:|blob:)/.test(details.url),
        });
      });
      const validator = new BrowserWindow({
        show: false,
        width: 1,
        height: 1,
        webPreferences: {
          preload: join(assetRoot, 'character-validator-preload.cjs'),
          session: partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          backgroundThrottling: false,
          webgl: false,
          spellcheck: false,
        },
      });
      const validatorId = validator.webContents.id;
      validator.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      validator.webContents.on('will-navigate', (event) => event.preventDefault());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<CharacterImportInspection>((resolve, reject) => {
          const fail = (message: string) => reject(new Error(message));
          active.set(validatorId, {
            bytes,
            window: validator,
            finish: (raw) => {
              if (!raw || typeof raw !== 'object') return fail('模型验证器返回无效结果');
              const result = raw as { inspection?: CharacterImportInspection; error?: string };
              if (result.error) return fail(`模型验证失败：${String(result.error).slice(0, 2000)}`);
              if (!result.inspection) return fail('模型验证器未返回检查结果');
              resolve(result.inspection);
            },
          });
          timer = setTimeout(
            () => fail('模型验证超时，原角色保持不变；请简化模型后重试'),
            timeoutMs,
          );
          validator.webContents.once('render-process-gone', () =>
            fail('模型验证进程已退出，原角色保持不变'),
          );
          validator.webContents.once('did-fail-load', () => fail('无法加载本地模型验证器'));
          validator.once('closed', () => fail('模型验证窗口已关闭'));
          void validator
            .loadFile(join(assetRoot, 'character-validator.html'))
            .catch(() => fail('无法启动本地模型验证器'));
        });
      } finally {
        if (timer) clearTimeout(timer);
        active.delete(validatorId);
        if (!validator.isDestroyed()) {
          validator.destroy();
        }
        partition.webRequest.onBeforeRequest(null);
        await partition.clearStorageData().catch(() => {});
      }
    };
    const pending = queue.then(validate);
    queue = pending.catch(() => {});
    return pending.finally(() => {
      admitted--;
    });
  };
}
