import { dirname, join } from 'node:path';
import { z } from 'zod';
import { runWindowsProcess } from '../../executor/src/windows-process';
import { minimalEnvironment } from '../../executor/src/process';
import { validatePath } from '../../executor/src/path-guard';

const digest = z.string().regex(/^[a-f0-9]{64}$/);

const responseSchema = z
  .object({
    ok: z.boolean(),
    status: z.enum([
      'applied',
      'not_started',
      'interrupted',
      'rolled_back',
      'conflict',
      'busy',
      'unsupported',
      'unknown',
    ]),
    message: z.string().optional().default(''),
    canRollback: z.boolean(),
    inspectionToken: digest
      .nullish()
      .transform((value) => value ?? undefined)
      .optional(),
    conflicts: z.array(z.string()),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(2048),
            action: z.enum(['create', 'modify']),
            state: z.enum(['before', 'after', 'reserved', 'diverged', 'missing', 'unknown']),
            beforeHash: digest.nullable().optional(),
            afterHash: digest.nullable().optional(),
            currentHash: digest.nullable().optional(),
            message: z
              .string()
              .nullish()
              .transform((value) => value ?? undefined)
              .optional(),
          })
          .passthrough(),
      )
      .max(512),
  })
  .passthrough()
  .superRefine((value, context) => {
    let invalid = value.ok !== ['applied', 'rolled_back', 'not_started'].includes(value.status);
    if (value.ok && value.conflicts.length) invalid = true;
    if (['applied', 'rolled_back'].includes(value.status) && !value.files.length) invalid = true;
    if (
      value.canRollback &&
      (!['applied', 'interrupted'].includes(value.status) ||
        value.conflicts.length ||
        !value.files.some((file) => ['after', 'reserved'].includes(file.state)))
    )
      invalid = true;
    if (
      value.status === 'rolled_back' &&
      (value.canRollback || value.files.some((file) => file.state !== 'before'))
    )
      invalid = true;
    if (
      value.status === 'not_started' &&
      (value.canRollback || value.files.some((file) => file.state !== 'before'))
    )
      invalid = true;
    if (
      value.status === 'applied' &&
      value.files.some((file) => !['before', 'after'].includes(file.state))
    )
      invalid = true;
    const paths = new Set<string>();
    for (const file of value.files) {
      try {
        validatePath(file.path);
        if (/^[\\/]|:/.test(file.path)) invalid = true;
      } catch {
        invalid = true;
      }
      const key = file.path.replaceAll('\\', '/').toLowerCase();
      if (paths.has(key)) invalid = true;
      paths.add(key);
    }
    if (invalid) context.addIssue({ code: 'custom', message: 'Inconsistent writeback receipt' });
  });
export type NativeApplyResult = z.infer<typeof responseSchema>;
export const validateWritebackReceipt = (value: unknown): NativeApplyResult =>
  responseSchema.parse(value);
export async function invokeWriteback(
  helperPath: string,
  request: Record<string, unknown>,
): Promise<NativeApplyResult> {
  const unavailable = (message: string): NativeApplyResult => ({
    ok: false,
    status: 'unknown',
    message,
    files: [],
    conflicts: [],
    canRollback: false,
  });
  try {
    const result = await runWindowsProcess(
      helperPath,
      [],
      {
        cwd: dirname(helperPath),
        signal: new AbortController().signal,
        timeoutMs: 60000,
        input: JSON.stringify(request) + '\n',
        outputLimit: 1024 * 1024,
        supervisorPath: join(dirname(helperPath), 'process-supervisor.exe'),
      },
      minimalEnvironment(),
    );
    if (result.reason || result.exitCode !== 0 || result.stopStatus === 'outcome_unknown')
      return unavailable('写回程序没有返回已确认结果，请核查记录后恢复。');
    return validateWritebackReceipt(JSON.parse(result.output));
  } catch {
    return unavailable('无法确认写回结果，请核查记录；不要重复应用。');
  }
}
