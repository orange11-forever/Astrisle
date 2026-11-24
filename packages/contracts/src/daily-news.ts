import { z } from 'zod';

export interface DailyNewsSettings {
  enabled: boolean;
  /** Local wall-clock time, HH:mm. */
  time: string;
  feeds: string[];
  topic: string;
}

export interface DailyNewsItem {
  title: string;
  url: string;
  publishedAt: string;
  summary: string;
}

export interface DailyNewsEntry {
  date: string;
  status: 'queued' | 'running' | 'delivered' | 'empty' | 'failed';
  updatedAt: string;
  message: string;
  itemCount: number;
}

export interface DailyNewsIssue extends DailyNewsEntry {
  items: DailyNewsItem[];
}

export interface DailyNewsMailbox {
  settings: DailyNewsSettings;
  issues: DailyNewsEntry[];
}

export function defaultDailyNewsSettings(): DailyNewsSettings {
  return {
    enabled: false,
    time: '09:00',
    feeds: ['https://news.un.org/feed/subscribe/zh/news/all/rss.xml', 'https://www.nasa.gov/feed/'],
    topic: '',
  };
}

export function isDailyNewsUrl(value: string) {
  if (value.length > 2048 || !/^https?:\/\//i.test(value) || /[\s\\#]/u.test(value)) return false;
  const url = URL.parse(value);
  return !!url?.hostname && !url.username && !url.password;
}

const settingsSchema = z
  .strictObject({
    enabled: z.boolean(),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '请选择有效的本地投递时间。'),
    feeds: z
      .array(z.string().trim().refine(isDailyNewsUrl, '请填写完整的 HTTP 或 HTTPS 订阅地址。'))
      .max(8, '每座岛最多订阅 8 个新闻源。'),
    topic: z.string().trim().max(200, '新闻主题最多 200 字。'),
  })
  .refine((value) => !value.enabled || value.feeds.length > 0, '请至少填写一个新闻订阅地址。');

export function parseDailyNewsSettings(value: unknown): DailyNewsSettings {
  const result = settingsSchema.safeParse(value);
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? '日报设置无效。');
  const settings = result.data;
  return { ...settings, feeds: [...new Set(settings.feeds.map((feed) => new URL(feed).href))] };
}
