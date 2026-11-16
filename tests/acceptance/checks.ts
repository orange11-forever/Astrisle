import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ToolContext, ToolExecutor } from '../../packages/contracts/src/index';
import { guardPath, assertPlainPath } from '../../packages/executor/src/path-guard';
import { runProcess } from '../../packages/executor/src/process';
import type { CheckRecord, DeliverableCheck } from './schema';

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function checkContext(root: string, signal: AbortSignal): ToolContext {
  return {
    commissionId: 'acceptance',
    taskId: 'independent-check',
    runId: 'check',
    workPath: root,
    signal,
    scope: {
      readRoots: [],
      writeRoots: [],
      allowProcess: false,
      allowNetwork: false,
      allowedHosts: [],
    },
  };
}
export async function fileHashes(root: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  let total = 0;
  async function visit(directory: string, prefix: string) {
    await assertPlainPath(directory);
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, item.name);
      const name = prefix + item.name;
      await assertPlainPath(file);
      if (item.isDirectory()) await visit(file, name + '/');
      else if (item.isFile()) {
        const size = (await stat(file)).size;
        total += size;
        if (
          size > 32 * 1024 * 1024 ||
          total > 256 * 1024 * 1024 ||
          Object.keys(hashes).length >= 2000
        )
          throw new Error('Acceptance files exceed bounds');
        hashes[name] = sha256(await readFile(file));
      } else throw new Error('Unsupported acceptance file');
    }
  }
  await visit(root, '');
  return hashes;
}
export async function checkDeliverables(options: {
  checks: DeliverableCheck[];
  root: string;
  projectRoot: string;
  executor: ToolExecutor;
  allowProcess: boolean;
  signal: AbortSignal;
  nodePath?: string;
}): Promise<CheckRecord[]> {
  const context = checkContext(options.root, options.signal);
  const records: CheckRecord[] = [];
  for (const check of options.checks) {
    options.signal.throwIfAborted();
    let detail = 'Independent check passed';
    let passed = false;
    try {
      const path = await guardPath(check.path, context, false);
      if (check.kind === 'text' || check.kind === 'json') {
        if ((await stat(path)).size > 1024 * 1024) throw new Error('Checked text exceeds 1 MiB');
        const text = await readFile(path, 'utf8');
        passed = isDeepStrictEqual(check.kind === 'json' ? JSON.parse(text) : text, check.equals);
        if (!passed) detail = 'File content differs from independent expectation';
      } else if (check.kind === 'node') {
        if (!options.allowProcess)
          throw new Error('Node checks require explicit host-process permission');
        const result = await runProcess(options.nodePath ?? process.execPath, [path], {
          cwd: options.root,
          input: check.input,
          signal: options.signal,
          timeoutMs: 10000,
          outputLimit: 65536,
          supervisorPath: join(options.projectRoot, 'dist/helpers/process-supervisor.exe'),
        });
        passed =
          !result.reason &&
          result.exitCode === check.exitCode &&
          result.stopStatus !== 'outcome_unknown';
        if (passed && check.exitCode === 0)
          passed = isDeepStrictEqual(JSON.parse(result.output), check.json);
        detail = `Node exit=${result.exitCode}; stop=${result.stopStatus}; ${passed ? 'output matched' : 'check failed'}${result.reason ? `; ${result.reason}` : ''}`;
      } else {
        const result = await options.executor.execute(
          'office_verify',
          { source: check.path, checks: check.sums },
          context,
        );
        if (!result.ok) throw new Error(result.code ?? 'Office verification failed');
        const output = result.metadata ?? JSON.parse(result.output);
        passed = check.assertions.every((a) => {
          let value: unknown = output.document;
          for (const part of a.at)
            value =
              value && typeof value === 'object'
                ? (value as Record<string | number, unknown>)[part]
                : undefined;
          return isDeepStrictEqual(value, a.equals);
        });
        detail = `Office structure${check.sums.length ? ' and source-cell sums' : ''}: ${passed ? 'matched' : 'mismatch'}; application rendering and formula recalculation not performed`;
      }
    } catch (error) {
      detail = error instanceof Error ? error.message : 'Independent check failed';
    }
    records.push({
      name: `${check.kind}:${check.path}`,
      status: passed ? 'passed' : 'failed',
      detail,
    });
  }
  return records;
}
