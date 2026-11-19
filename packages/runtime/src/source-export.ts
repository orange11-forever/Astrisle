import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readVerifiedFile, readVersionBytes } from '../../artifacts/src/index';
import { sourceExportFormats } from '../../contracts/src/index';
import type {
  Artifact,
  CommandResult,
  SourceExportFormat,
  ToolExecutor,
  Workspace,
} from '../../contracts/src/index';
import { assertPlainPath, contained, validatePath } from '../../executor/src/path-guard';

async function destinationStamp(path: string): Promise<string | undefined> {
  try {
    const file = await lstat(path, { bigint: true });
    if (!file.isFile()) throw new Error('请选择普通文件作为导出位置');
    return [file.dev, file.ino, file.size, file.ctimeNs].join('/');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Only the main process obtains the destination from the native save dialog. */
export async function saveSourceExport(
  dataRoot: string,
  executor: ToolExecutor,
  source: Artifact | undefined,
  format: SourceExportFormat,
  destination: string,
  workspaces: Workspace[],
): Promise<CommandResult> {
  if (!source || source.validity === 'missing')
    return { ok: false, code: 'source_unavailable', message: '找不到所选源稿版本' };
  if (!sourceExportFormats(source.relativePath).includes(format))
    return { ok: false, code: 'unsupported_format', message: '该源稿不支持所选格式' };
  validatePath(destination);
  if (!isAbsolute(destination) || extname(destination).toLowerCase() !== '.' + format)
    return {
      ok: false,
      code: 'invalid_destination',
      message: `请选择 .${format} 文件作为保存目标`,
    };
  const protectedRoots = [
    dataRoot,
    ...workspaces.flatMap((w) => [w.sourcePath, w.workPath]).filter(Boolean),
  ];
  if (protectedRoots.some((root) => contained(root, destination)))
    return {
      ok: false,
      code: 'managed_destination',
      message: '请在原项目和应用工作区之外保存导出副本',
    };

  const bytes = await readVersionBytes(dataRoot, source, 1024 * 1024);
  if (bytes === 'input-limit')
    return { ok: false, code: 'input_limit', message: '源稿超过 1 MiB，无法生成文件' };
  if (!Buffer.isBuffer(bytes))
    return { ok: false, code: 'source_unavailable', message: '源稿副本缺失或内容校验失败' };
  await assertPlainPath(destination, true);
  const original = await destinationStamp(destination);
  const scratch = await realpath(await mkdtemp(join(dirname(destination), '.astrisle-export-')));
  try {
    const input = 'source' + extname(source.relativePath).toLowerCase();
    const output = 'delivery.' + format;
    await writeFile(join(scratch, input), bytes, { flag: 'wx' });
    const result = await executor.execute(
      'render_source',
      { source: input, output },
      {
        commissionId: source.commissionId,
        taskId: source.taskId,
        runId: randomUUID(),
        workPath: scratch,
        scope: {
          readRoots: [],
          writeRoots: [scratch],
          allowProcess: false,
          allowNetwork: false,
          allowedHosts: [],
        },
        signal: AbortSignal.timeout(70_000),
      },
    );
    if (!result.ok) {
      const detail =
        typeof result.metadata?.output === 'string' ? result.metadata.output : result.output;
      const message =
        result.code === 'WORKER_UNAVAILABLE'
          ? '本机缺少源稿发布依赖。请按 README 更新项目的 Python 环境后重试。'
          : `生成 ${format.toUpperCase()} 失败：${detail.slice(0, 500)}`;
      return { ok: false, code: 'render_failed', message };
    }
    const generated = join(scratch, output);
    await assertPlainPath(generated);
    if (
      result.metadata?.sourceSha256 !== source.sha256 ||
      !Buffer.isBuffer(
        await readVerifiedFile(generated, result.metadata?.outputSha256, 32 * 1024 * 1024),
      )
    )
      return { ok: false, code: 'render_failed', message: '生成文件与源稿的校验结果不一致' };
    await assertPlainPath(destination, true);
    if (original !== (await destinationStamp(destination)))
      return {
        ok: false,
        code: 'destination_changed',
        message: '生成期间保存目标发生了变化，请重新选择位置',
      };
    if (original === undefined) {
      try {
        await link(generated, destination);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST')
          return {
            ok: false,
            code: 'destination_changed',
            message: '同名文件已被创建，请重新选择位置',
          };
        // Some removable media do not support hard links. Exclusive copy still protects existing files.
        if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS', 'EINVAL'].includes(code ?? ''))
          throw error;
        await copyFile(generated, destination, constants.COPYFILE_EXCL);
      }
    } else await rename(generated, destination);
    return { ok: true, message: `已生成 ${destination}` };
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 75 });
  }
}
