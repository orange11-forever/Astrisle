import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ExternalLink, Mailbox, Newspaper } from 'lucide-react';
import {
  isDailyNewsUrl,
  parseDailyNewsSettings,
  type DailyNewsEntry,
  type DailyNewsIssue,
  type DailyNewsMailbox,
  type DailyNewsSettings,
  type HostAPI,
} from '@astrisle/contracts';

type DailyNewsHost = Required<
  Pick<
    HostAPI,
    | 'getDailyNewsMailbox'
    | 'setDailyNewsSettings'
    | 'getDailyNewsIssue'
    | 'retryDailyNews'
    | 'openDailyNewsSource'
  >
>;

export function supportsDailyNews(host?: HostAPI): host is HostAPI & DailyNewsHost {
  return Boolean(
    host?.getDailyNewsMailbox &&
      host.setDailyNewsSettings &&
      host.getDailyNewsIssue &&
      host.retryDailyNews &&
      host.openDailyNewsSource,
  );
}

const statusNames: Record<DailyNewsEntry['status'], string> = {
  queued: '等待生成',
  running: '正在生成',
  delivered: '已投递',
  empty: '暂无新闻',
  failed: '投递失败',
};

const publicationTime = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function localDate(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

type SettingsDraft = Omit<DailyNewsSettings, 'feeds'> & { feeds: string };

function draftFrom(settings: DailyNewsSettings): SettingsDraft {
  return { ...settings, feeds: settings.feeds.join('\n') };
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function IssueDetails({
  host,
  workspaceId,
  date,
}: {
  host: DailyNewsHost;
  workspaceId: string;
  date: string;
}) {
  const [issue, setIssue] = useState<DailyNewsIssue>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    host.getDailyNewsIssue(workspaceId, date).then(
      (result) => {
        if (active) setIssue(result);
      },
      (reason) => {
        if (active) setError(errorText(reason, '暂时无法读取这份日报。'));
      },
    );
    return () => {
      active = false;
    };
  }, [date, host, workspaceId]);

  return (
    <section className="daily-news-issue" aria-label={`${date} 日报`}>
      {error && <p role="alert">{error}</p>}
      {!issue && !error && <p role="status">正在读取日报…</p>}
      {issue?.message && <p>{issue.message}</p>}
      {issue?.items.map((item) => {
        const dateValue = Date.parse(item.publishedAt);
        const source = isDailyNewsUrl(item.url) ? URL.parse(item.url) : null;
        return (
          <article key={item.url}>
            <h4>{item.title}</h4>
            <div className="daily-news-meta">
              {source && <span>{source.hostname}</span>}
              {Number.isFinite(dateValue) && (
                <time dateTime={item.publishedAt}>
                  {/^\d{4}-\d{2}-\d{2}$/.test(item.publishedAt)
                    ? item.publishedAt
                    : publicationTime.format(dateValue)}
                </time>
              )}
            </div>
            {item.summary && <p>{item.summary}</p>}
            {source && (
              <a
                href={item.url}
                onAuxClick={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.preventDefault();
                  setError('');
                  void host.openDailyNewsSource(workspaceId, date, item.url).catch((reason) => {
                    setError(errorText(reason, '暂时无法打开原文。'));
                  });
                }}
              >
                阅读原文 <ExternalLink size={13} aria-hidden="true" />
              </a>
            )}
          </article>
        );
      })}
    </section>
  );
}

export function DailyNewsPanel({
  host,
  workspaceId,
}: {
  host: DailyNewsHost;
  workspaceId: string;
}) {
  const [mailbox, setMailbox] = useState<DailyNewsMailbox>();
  const [draft, setDraft] = useState<SettingsDraft>();
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [activeDate, setActiveDate] = useState('');
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const active = useRef(false);
  const draftDirty = useRef(false);
  const pendingWrite = useRef(false);
  const mailboxVersion = useRef(0);
  const sourcesHint = useId();

  useEffect(() => {
    let mounted = true;
    let reading = false;
    let firstLoad = true;
    active.current = true;
    const refresh = async () => {
      if (reading || pendingWrite.current) return;
      reading = true;
      const version = mailboxVersion.current;
      try {
        const result = await host.getDailyNewsMailbox(workspaceId);
        if (!mounted || version !== mailboxVersion.current) return;
        setMailbox(result);
        setLoadError('');
        if (!draftDirty.current) setDraft(draftFrom(result.settings));
        if (firstLoad) {
          firstLoad = false;
          setSettingsOpen(!result.settings.enabled && result.issues.length === 0);
        }
      } catch (error) {
        if (mounted && version === mailboxVersion.current) {
          setLoadError(errorText(error, '暂时无法读取日报邮箱。'));
        }
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_500);
    return () => {
      mounted = false;
      active.current = false;
      window.clearInterval(timer);
    };
  }, [host, workspaceId]);

  const updateMailbox = async (action: () => Promise<DailyNewsMailbox>, save: boolean) => {
    if (pendingWrite.current) return;
    pendingWrite.current = true;
    mailboxVersion.current++;
    setBusy(true);
    setSaved(false);
    setActionError('');
    try {
      const next = await action();
      if (!active.current) return;
      setMailbox(next);
      setLoadError('');
      if (save) {
        draftDirty.current = false;
        setDraft(draftFrom(next.settings));
        setSaved(true);
      }
    } catch (error) {
      if (active.current) setActionError(errorText(error, '日报操作未完成。'));
    } finally {
      pendingWrite.current = false;
      if (active.current) setBusy(false);
    }
  };

  if (!mailbox || !draft) {
    return loadError ? <p role="alert">{loadError}</p> : <p role="status">正在打开日报邮箱…</p>;
  }

  const today = localDate();
  const issues = [...mailbox.issues].sort((a, b) => b.date.localeCompare(a.date));
  const todayIssue = issues.find((issue) => issue.date === today);
  const feedUrls = draft.feeds
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hosts = [...new Set(feedUrls.filter(isDailyNewsUrl).map((url) => new URL(url).hostname))];
  const editSettings = (patch: Partial<SettingsDraft>) => {
    draftDirty.current = true;
    setDraft({ ...draft, ...patch });
    setSaved(false);
    setActionError('');
  };
  const saveSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const settings = parseDailyNewsSettings({ ...draft, feeds: feedUrls });
      void updateMailbox(() => host.setDailyNewsSettings(workspaceId, settings), true);
    } catch (error) {
      setActionError(errorText(error, '请检查日报设置。'));
    }
  };
  const retryButton = (issue: DailyNewsEntry) => (
    <button
      type="button"
      aria-label={`重试 ${issue.date}`}
      disabled={busy}
      onClick={() => void updateMailbox(() => host.retryDailyNews(workspaceId, issue.date), false)}
    >
      重试
    </button>
  );

  return (
    <div className="daily-news">
      <section className="daily-news-today" aria-label="今日投递">
        <div className="daily-news-row">
          <h3>
            <Mailbox size={19} aria-hidden="true" /> 今日投递
          </h3>
          <time dateTime={today}>{today}</time>
        </div>
        <div role="status" className="daily-news-today-status">
          {todayIssue && (
            <>
              <strong>{statusNames[todayIssue.status]}</strong>
              {todayIssue.message && <p>{todayIssue.message}</p>}
            </>
          )}
          {!mailbox.settings.enabled ? (
            <p>已关闭</p>
          ) : !todayIssue ? (
            <p>等待本机时间 {mailbox.settings.time} 投递。</p>
          ) : null}
        </div>
        {todayIssue?.status === 'failed' && mailbox.settings.enabled && retryButton(todayIssue)}
      </section>
      {loadError && <p role="alert">{loadError}</p>}
      {actionError && (
        <p className="daily-news-error" role="alert">
          {actionError}
        </p>
      )}
      <details
        className="daily-news-settings"
        open={settingsOpen}
        onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
      >
        <summary>日报设置</summary>
        <form onSubmit={saveSettings}>
          <fieldset disabled={busy}>
            <label className="check-label">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => editSettings({ enabled: event.target.checked })}
              />
              开启每日新闻
            </label>
            <p className="quiet">
              首次开启会尝试生成今天的日报，并为当前 Windows 用户注册计划任务。退出 Astrisle
              后，登录期间仍会按本机时间投递。电脑恢复并登录后会尝试补投。关闭订阅会移除这座岛的计划任务。
            </p>
            <label>
              投递时间
              <input
                type="time"
                required
                value={draft.time}
                onChange={(event) => editSettings({ time: event.target.value })}
              />
            </label>
            <label>
              新闻主题
              <input
                type="text"
                value={draft.topic}
                maxLength={200}
                placeholder="留空时收录订阅源内的新闻"
                onChange={(event) => editSettings({ topic: event.target.value })}
              />
            </label>
            <label>
              RSS / Atom 订阅地址
              <textarea
                rows={3}
                aria-describedby={sourcesHint}
                value={draft.feeds}
                onChange={(event) => editSettings({ feeds: event.target.value })}
              />
            </label>
            <div id={sourcesHint} className="daily-news-sources-hint">
              <p className="quiet">每行一个完整地址，最多 8 个。</p>
              {hosts.length > 0 && <p>允许抓取的主机 {hosts.join('、')}</p>}
            </div>
            <div className="daily-news-save">
              <button type="submit" className="primary">
                保存日报设置
              </button>
              {saved && <small role="status">设置已保存</small>}
            </div>
          </fieldset>
        </form>
      </details>
      <section className="daily-news-history" aria-label="日报存档">
        <h3>
          <Newspaper size={17} aria-hidden="true" /> 日报历史
        </h3>
        {issues.length === 0 ? (
          <p className="quiet">
            {mailbox.settings.enabled
              ? '收到的日报会保存在这里。'
              : '开启每日新闻后，可在这里查看往期日报。'}
          </p>
        ) : (
          <ol aria-label="日报历史">
            {issues.map((issue) => (
              <li key={issue.date}>
                <div className="daily-news-row">
                  <div>
                    <time dateTime={issue.date}>{issue.date}</time>
                    <small>
                      {statusNames[issue.status]}
                      {issue.status === 'delivered' && ` · ${issue.itemCount} 条`}
                    </small>
                  </div>
                  {issue.status === 'delivered' && (
                    <button
                      type="button"
                      aria-expanded={activeDate === issue.date}
                      aria-label={`${activeDate === issue.date ? '收起' : '阅读'} ${issue.date}`}
                      onClick={() => setActiveDate(activeDate === issue.date ? '' : issue.date)}
                    >
                      {activeDate === issue.date ? '收起' : '阅读'}
                    </button>
                  )}
                  {issue.status === 'failed' &&
                    issue.date !== today &&
                    mailbox.settings.enabled &&
                    retryButton(issue)}
                </div>
                {issue.date !== today && issue.status !== 'delivered' && issue.message && (
                  <p className="quiet">{issue.message}</p>
                )}
                {activeDate === issue.date && issue.status === 'delivered' && (
                  <IssueDetails host={host} workspaceId={workspaceId} date={issue.date} />
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
