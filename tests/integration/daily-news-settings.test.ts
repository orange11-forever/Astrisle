import { expect, it } from 'vitest';
import {
  defaultDailyNewsSettings,
  isDailyNewsUrl,
  parseDailyNewsSettings,
} from '../../packages/contracts/src/index';

it('starts each island unsubscribed and stores each explicitly selected feed once', () => {
  const defaults = defaultDailyNewsSettings();
  expect(defaults.enabled).toBe(false);
  defaults.feeds.length = 0;
  expect(defaultDailyNewsSettings().feeds.length).toBeGreaterThan(0);
  const input = {
    ...defaults,
    enabled: true,
    feeds: ['https://NEWS.example', ' https://news.example/ '],
    topic: ' 科技 ',
  };
  expect(parseDailyNewsSettings(input)).toEqual({
    enabled: true,
    time: '09:00',
    feeds: ['https://news.example/'],
    topic: '科技',
  });
});

it('rejects malformed schedules and unopenable feed addresses before enrollment', () => {
  const defaults = defaultDailyNewsSettings();
  for (const time of ['9:00', '24:00', '23:61']) {
    expect(() => parseDailyNewsSettings({ ...defaults, time })).toThrow();
  }
  expect(() => parseDailyNewsSettings({ ...defaults, enabled: true, feeds: [] })).toThrow();
  for (const url of [
    'file:///local',
    'javascript:void(0)',
    'https://user:password@example.org/feed',
  ]) {
    expect(isDailyNewsUrl(url)).toBe(false);
    expect(() => parseDailyNewsSettings({ ...defaults, feeds: [url] })).toThrow();
  }
});
