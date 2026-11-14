import { spawn } from 'node:child_process';
import { ToolError } from './path-guard';
import { runWindowsProcess } from './windows-process';

export type ProcessResult = {
  output: string;
  exitCode: number | null;
  stopStatus: 'not_requested' | 'stopped' | 'outcome_unknown';
  reason?: string;
  termination?: {
    mechanism: 'windows_job';
    supervisorPid?: number;
    rootPid?: number;
    activeProcesses?: number;
    confirmed: boolean;
    confirmedAt?: string;
  };
};
export type ProcessOptions = {
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  input?: string;
  outputLimit?: number;
  supervisorPath?: string;
};
export function minimalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP', 'LANG'])
    if (process.env[name]) env[name] = process.env[name];
  env.PATH =
    process.platform === 'win32'
      ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32;${process.env.SystemRoot || 'C:\\Windows'}`
      : '/usr/local/bin:/usr/bin:/bin';
  env.PYTHONUTF8 = '1';
  env.PYTHONDONTWRITEBYTECODE = '1';
  return env;
}
export function redact(text: string): string {
  return text
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '$1[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
    .replace(
      /((?:api[_-]?key|password|secret|access[_-]?token)\s*[=:]\s*["']?)[^\s"',;]+/gi,
      '$1[REDACTED]',
    );
}
/** Trusted host execution. This is deliberately not an OS isolation boundary. */
export async function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  if (options.signal.aborted)
    throw new ToolError('ABORTED', 'Operation cancelled before process start');
  if (
    !command ||
    command.length > 2048 ||
    /[\x00\r\n]/.test(command) ||
    args.length > 100 ||
    args.some((a) => a.length > 32768 || a.includes('\0'))
  )
    throw new ToolError('INVALID_ARGUMENT', 'Invalid executable or argument size');
  const limit = options.outputLimit ?? 128 * 1024;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 4 * 1024 * 1024 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    Buffer.byteLength(options.input ?? '') > 4 * 1024 * 1024
  )
    throw new ToolError('INVALID_ARGUMENT', 'Invalid process limits');
  if (process.platform === 'win32') {
    const result = await runWindowsProcess(command, args, options, minimalEnvironment());
    return { ...result, output: redact(result.output) };
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: minimalEnvironment(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = Buffer.alloc(0),
      reason: string | undefined,
      settled = false,
      killTimer: ReturnType<typeof setTimeout> | undefined;
    let stopStatus: ProcessResult['stopStatus'] = 'not_requested';
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener('abort', aborted);
      resolve({ output: redact(buffer.toString('utf8')), exitCode, stopStatus, reason });
    };
    const stop = (why: string) => {
      if (reason || settled) return;
      reason = why;
      stopStatus = 'outcome_unknown';
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* disappearance is checked after close */
        }
      }
      killTimer = setTimeout(() => finish(null), 4000);
    };
    const aborted = () => stop('aborted');
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
    options.signal.addEventListener('abort', aborted, { once: true });
    const append = (chunk: Buffer) => {
      const available = limit - buffer.length;
      if (available > 0) buffer = Buffer.concat([buffer, chunk.subarray(0, available)]);
      if (chunk.length > available) stop('output_limit');
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', aborted);
      reject(new ToolError('PROCESS_START_FAILED', e.message));
    });
    child.on('close', (code) => {
      if (reason && process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ESRCH') stopStatus = 'stopped';
        }
      }
      finish(code);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
    if (options.signal.aborted) stop('aborted');
  });
}
