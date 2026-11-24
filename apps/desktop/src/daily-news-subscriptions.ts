import type { DailyNewsMailbox, DailyNewsSettings } from '@astrisle/contracts';

interface SubscriptionServices {
  read(id: string): Promise<DailyNewsMailbox>;
  save(id: string, settings: DailyNewsSettings): Promise<DailyNewsMailbox>;
  schedule(id: string, time: string | null): Promise<void>;
  state(): Promise<{ schedules: { workspaceId: string; time: string }[]; cleanup: string[] }>;
  acknowledgeRemoval(id: string): Promise<void>;
}

/** Store opt-in only after Windows accepts the task. Serialize changes so two windows/events cannot undo each other. */
export class DailyNewsSubscriptions {
  private pending: Promise<void> = Promise.resolve();

  constructor(private services: SubscriptionServices) {}

  private run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work);
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  settle(): Promise<void> {
    return this.pending;
  }

  private async remove(id: string) {
    await this.services.schedule(id, null);
    await this.services.acknowledgeRemoval(id);
  }

  reconcileWake(id: string): Promise<void> {
    return this.run(async () => {
      const { schedules, cleanup } = await this.services.state();
      if (schedules.some((schedule) => schedule.workspaceId === id)) return;
      if (cleanup.includes(id)) await this.remove(id);
      else await this.services.schedule(id, null);
    });
  }

  restore(): Promise<void> {
    return this.run(async () => {
      const { cleanup, schedules } = await this.services.state();
      for (const id of cleanup) {
        await this.remove(id).catch((error) => console.error('日报旧计划清理失败', error));
      }
      for (const { workspaceId, time } of schedules) {
        await this.services
          .schedule(workspaceId, time)
          .catch((error) => console.error('日报唤醒计划恢复失败', error));
      }
    });
  }

  update(id: string, next: DailyNewsSettings): Promise<DailyNewsMailbox> {
    return this.run(async () => {
      const previous = (await this.services.read(id)).settings;
      if (next.enabled) {
        await this.services.schedule(id, next.time);
        try {
          const mailbox = await this.services.save(id, next);
          return mailbox;
        } catch (error) {
          // An IPC reply may have been lost after SQLite committed. Reconcile to the actual saved value.
          const saved = await this.services.read(id).catch(() => undefined);
          if (saved)
            await this.services.schedule(id, saved.settings.enabled ? saved.settings.time : null);
          throw error;
        }
      }
      const mailbox = await this.services.save(id, next);
      if (previous.enabled || (await this.services.state()).cleanup.includes(id))
        await this.remove(id);
      return mailbox;
    });
  }
}
