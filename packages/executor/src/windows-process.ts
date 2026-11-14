import { spawn } from 'node:child_process';
import path from 'node:path';
import { ToolError } from './path-guard';
import type { ProcessOptions, ProcessResult } from './process';

/** A receipt describes job membership, never rollback of the executable's effects. */
export function runWindowsProcess(
  command: string,
  args: string[],
  options: ProcessOptions,
  env: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  const limit = options.outputLimit ?? 128 * 1024;
  return new Promise((resolve, reject) => {
    const helper = spawn(
      options.supervisorPath ?? path.resolve('dist/helpers/process-supervisor.exe'),
      [],
      { cwd: options.cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = Buffer.alloc(0),
      pending = '',
      rootPid: number | undefined;
    let reason: string | undefined,
      settled = false,
      failed = false;
    let startError: string | undefined;
    let receipt:
      | { exitCode: number | null; activeProcesses: number; confirmed: boolean; reason?: string }
      | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const termination: NonNullable<ProcessResult['termination']> = {
      mechanism: 'windows_job',
      supervisorPid: helper.pid,
      confirmed: false,
    };
    const finish = (helperCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(drainTimer);
      options.signal.removeEventListener('abort', abort);
      helper.stdin.destroy();
      helper.stdout.destroy();
      helper.stderr.destroy();
      if (startError) {
        reject(new ToolError('PROCESS_START_FAILED', startError));
        return;
      }
      const confirmed =
        !failed && helperCode === 0 && receipt?.confirmed === true && receipt.activeProcesses === 0;
      if (confirmed) {
        termination.confirmed = true;
        termination.activeProcesses = 0;
        termination.confirmedAt = new Date().toISOString();
      } else if (receipt) termination.activeProcesses = receipt.activeProcesses;
      reason ??= receipt?.reason;
      if (!confirmed) reason ??= 'supervisor_failed';
      resolve({
        output: output.toString('utf8'),
        exitCode: confirmed ? receipt!.exitCode : null,
        stopStatus: confirmed ? (reason ? 'stopped' : 'not_requested') : 'outcome_unknown',
        reason,
        termination,
      });
    };
    const forceUnknown = () => {
      if (settled) return;
      failed = true;
      // Closing the supervisor's last job handle stops members, but is not a receipt.
      helper.kill();
      if (settled) return;
      clearTimeout(drainTimer);
      // Normally close arrives promptly. Do not return while a terminated helper still
      // holds the working directory; retain a bounded unknown fallback if it cannot exit.
      drainTimer = setTimeout(() => {
        helper.unref();
        finish(null);
      }, 1000);
    };
    const stop = (why: string) => {
      if (settled || reason) return;
      reason = why;
      helper.stdin.write('stop\n', () => {});
      drainTimer = setTimeout(forceUnknown, 5000);
    };
    const abort = () => stop('aborted');
    const timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
    options.signal.addEventListener('abort', abort, { once: true });
    const append = (bytes: Buffer) => {
      const available = limit - output.length;
      if (available > 0) output = Buffer.concat([output, bytes.subarray(0, available)]);
      if (bytes.length > available) stop('output_limit');
    };
    const validPid = (value: unknown): value is number =>
      Number.isSafeInteger(value) && Number(value) > 0;
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', (chunk: string) => {
      if (settled) return;
      pending += chunk;
      try {
        let newline: number;
        while ((newline = pending.indexOf('\n')) !== -1) {
          if (newline > 16384 || receipt || startError)
            throw new Error('Invalid supervisor stream');
          const message = JSON.parse(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          if (message.version !== 1) throw new Error('Unknown supervisor protocol');
          if (message.type === 'started' && rootPid === undefined && validPid(message.pid)) {
            rootPid = message.pid;
            termination.rootPid = rootPid;
          } else if (
            message.type === 'output' &&
            rootPid !== undefined &&
            typeof message.data === 'string' &&
            message.data.length <= 5464 &&
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)
          ) {
            append(Buffer.from(message.data, 'base64'));
          } else if (
            message.type === 'receipt' &&
            rootPid !== undefined &&
            message.pid === rootPid &&
            typeof message.confirmed === 'boolean' &&
            Number.isSafeInteger(message.activeProcesses) &&
            message.activeProcesses >= 0 &&
            (message.confirmed
              ? message.activeProcesses === 0 &&
                Number.isSafeInteger(message.exitCode) &&
                message.exitCode >= 0 &&
                message.exitCode <= 0xffffffff
              : message.exitCode === null) &&
            (message.reason === null ||
              ['aborted', 'timeout', 'output_limit'].includes(message.reason))
          ) {
            receipt = { ...message, reason: message.reason ?? undefined };
          } else if (message.type === 'error' && typeof message.message === 'string') {
            if (rootPid === undefined && message.started === false && message.created === false)
              startError = message.message;
            else failed = true;
          } else throw new Error('Invalid supervisor message');
        }
        if (pending.length > 16384) throw new Error('Supervisor message exceeds limit');
      } catch {
        forceUnknown();
      }
    });
    helper.stderr.on('data', (bytes: Buffer) => {
      if (!settled) append(bytes);
    });
    helper.on('error', (error) => {
      startError = rootPid === undefined ? error.message : undefined;
      failed = true;
      finish(null);
    });
    helper.on('close', (code) => {
      if (pending.trim()) failed = true;
      finish(code);
    });
    helper.stdin.on('error', () => {
      /* close without a valid receipt remains unknown */
    });
    helper.stdin.write(
      `${JSON.stringify({
        version: 1,
        command,
        args,
        cwd: options.cwd,
        input: Buffer.from(options.input ?? '', 'utf8').toString('base64'),
        timeoutMs: options.timeoutMs,
        outputLimit: limit,
      })}\n`,
    );
    // Keep stdin open: EOF is the supervisor's owner-death signal.
    if (options.signal.aborted) stop('aborted');
  });
}
