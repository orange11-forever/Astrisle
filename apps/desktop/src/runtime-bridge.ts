import { utilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export class RuntimeBridge extends EventEmitter {
  private child: Electron.UtilityProcess;
  private pending = new Map<string, Pending>();
  private exited = false;
  constructor(path: string) {
    super();
    this.child = utilityProcess.fork(path, [], { serviceName: 'Astrisle Runtime', stdio: 'pipe' });
    this.child.stdout?.on('data', (chunk) => process.stdout.write(`[runtime] ${chunk}`));
    this.child.stderr?.on('data', (chunk) => process.stderr.write(`[runtime] ${chunk}`));
    this.child.on(
      'message',
      (message: { id?: string; event?: string; value?: unknown; error?: string }) => {
        if (message.event) {
          this.emit(message.event, message.value);
          return;
        }
        const pending = message.id ? this.pending.get(message.id) : undefined;
        if (!pending || !message.id) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.value);
      },
    );
    this.child.on('exit', (code) => {
      this.exited = true;
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error(`运行时已退出 (${code})`));
      }
      this.pending.clear();
      this.emit('exit', code);
    });
  }
  call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.exited) return Promise.reject(new Error('运行时连接已断开，请重启应用恢复任务'));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('运行时回执超时，请查询原请求状态，不要重复提交'));
      }, 120_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.child.postMessage({ id, method, args });
    });
  }
  async close(): Promise<void> {
    if (!this.exited) await this.call('close');
  }
}
