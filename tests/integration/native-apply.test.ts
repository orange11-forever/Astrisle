import { afterEach, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import * as windows from '../../packages/executor/src/windows-process';
import { invokeWriteback } from '../../packages/workspace/src/native-apply';

afterEach(() => vi.restoreAllMocks());
it.each([
  { ok: false, status: 'applied', canRollback: false, conflicts: ['file.txt'], files: [] },
  { ok: true, status: 'applied', canRollback: false, conflicts: [], files: [] },
  { ok: true, status: 'rolled_back', canRollback: true, conflicts: [], files: [] },
])('rejects contradictory supervised writeback receipts %#', async (receipt) => {
  vi.spyOn(windows, 'runWindowsProcess').mockResolvedValue({
    output: JSON.stringify({ ...receipt, message: 'test' }),
    exitCode: 0,
    stopStatus: 'not_requested',
  });
  const result = await invokeWriteback(resolve('dist/helpers/safe-apply.exe'), {
    version: 1,
    action: 'inspect',
    operationDirectory: 'fixture',
  });
  expect(result.status).toBe('unknown');
  expect(result.ok).toBe(false);
});
