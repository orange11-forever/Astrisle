import { expect, it, vi } from 'vitest';
import { defaultDailyNewsSettings, type DailyNewsSettings } from '../../packages/contracts/src';
import { DailyNewsSubscriptions } from '../../apps/desktop/src/daily-news-subscriptions';
import {
  dailyNewsTaskName,
  dailyNewsWakeArguments,
  DailyNewsWakeHandoff,
} from '../../apps/desktop/src/daily-news-wake';
import { resolve } from 'node:path';

function fixture() {
  let saved = defaultDailyNewsSettings();
  let cleanup: string[] = [];
  const read = async () => ({ settings: saved, issues: [] });
  const save = vi.fn(async (id: string, settings: DailyNewsSettings) => {
    if (saved.enabled && !settings.enabled) cleanup = [id];
    if (settings.enabled) cleanup = [];
    saved = settings;
    return read();
  });
  const schedule = vi.fn(async (_id: string, _time: string | null) => {});
  const services = {
    read,
    save,
    schedule,
    state: async () => ({ schedules: [], cleanup }),
    acknowledgeRemoval: async (id: string) => {
      cleanup = cleanup.filter((value) => value !== id);
    },
  };
  return {
    management: new DailyNewsSubscriptions(services),
    restart: () => new DailyNewsSubscriptions(services),
    read,
    save,
    schedule,
    on: { ...saved, enabled: true },
    off: saved,
  };
}

it('does not enroll when the Windows registration fails, and permits saving again', async () => {
  const f = fixture();
  f.schedule.mockRejectedValueOnce(new Error('scheduler unavailable'));
  await expect(f.management.update('island', f.on)).rejects.toThrow('scheduler unavailable');
  expect(f.save).not.toHaveBeenCalled();
  expect((await f.management.update('island', f.on)).settings.enabled).toBe(true);
});

it('keeps the subscription stopped even if Windows cleanup needs a second attempt', async () => {
  const f = fixture();
  await f.management.update('island', f.on);
  f.schedule.mockRejectedValueOnce(new Error('busy'));
  await expect(f.management.update('island', f.off)).rejects.toThrow();
  expect((await f.read()).settings.enabled).toBe(false);
  await f.restart().restore();
  expect(f.schedule.mock.calls).toEqual([
    ['island', '09:00'],
    ['island', null],
    ['island', null],
  ]);
});

it('hands a scheduled launch to a new hidden process when desktop exit overlaps it', async () => {
  const relaunch = vi.fn();
  const wake = new DailyNewsWakeHandoff(relaunch);
  wake.received('island', false);
  expect(relaunch).not.toHaveBeenCalled();
  await wake.beforeExit(async () => true);
  wake.received('island', true);
  expect(relaunch.mock.calls).toEqual([['island']]);
  const alreadyClosing = new DailyNewsWakeHandoff(relaunch);
  alreadyClosing.received('late', true);
  expect(relaunch).toHaveBeenLastCalledWith('late');
});

it('leaves completed forwarded work at rest when the desktop later exits', async () => {
  const relaunch = vi.fn();
  const wake = new DailyNewsWakeHandoff(relaunch);
  wake.received('island', false);
  await wake.beforeExit(async () => false);
  expect(relaunch).not.toHaveBeenCalled();
});

it('reconciles a failed save with the persisted state', async () => {
  const f = fixture();
  f.save.mockRejectedValueOnce(new Error('sqlite busy'));
  await expect(f.management.update('island', f.on)).rejects.toThrow();
  expect(f.schedule.mock.calls).toEqual([
    ['island', '09:00'],
    ['island', null],
  ]);
});

it('scopes the task name to the user data and island and quotes the desktop launch path', () => {
  const options = {
    dataRoot: resolve('fixture with spaces'),
    workspaceId: 'island-id',
    time: '08:30',
    executable: 'C:\\Program Files\\Astrisle\\Astrisle.exe',
    projectRoot: 'E:\\星岛 工作台',
    packaged: false,
  };
  expect(dailyNewsTaskName(options.dataRoot, 'a')).not.toBe(
    dailyNewsTaskName(options.dataRoot, 'b'),
  );
  expect(dailyNewsTaskName(options.dataRoot, 'a')).not.toBe(
    dailyNewsTaskName(resolve('other'), 'a'),
  );
  expect(dailyNewsWakeArguments(options)).toBe(
    `"${options.projectRoot}" "--daily-news-background" "--daily-news-root=${options.dataRoot}" "--daily-news-island=island-id"`,
  );
  expect(dailyNewsWakeArguments({ ...options, packaged: true })).toMatch(
    /^"--daily-news-background"/,
  );
});
