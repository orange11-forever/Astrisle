import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { collectDailyNews } from '../../packages/runtime/src/daily-news-collector';

const date = '2026-11-23';
const article = (title: string, text: string, published = date) =>
  `<html><head>${published ? `<meta property="article:published_time" content="${published}">` : ''}</head><body><article><h1>${title}</h1><p>${text}</p></article></body></html>`;
const entry = (path: string, day = date) =>
  `<item><title>Feed headline</title><link>${path}</link><pubDate>${day}</pubDate></item>`;
const rss = (...entries: string[]) =>
  `<rss version="2.0"><channel>${entries.join('')}</channel></rss>`;

interface Source {
  id: string;
  url: string;
  title: string;
  publishedAt: string;
  text: string;
  summary?: string;
}

interface ModelInput {
  date: string;
  topic: string;
  sources?: Source[];
  items?: Source[];
}

type Page = string | ((visits: number) => string | { redirect: string });

async function withFixture(
  pages: Record<string, Page>,
  test: (fixture: {
    origin: string;
    requests: string[];
    calls: { tool: string; input: ModelInput }[];
    collect: (
      feeds: string[],
      topic?: string,
      issueDate?: string,
    ) => ReturnType<typeof collectDailyNews>;
  }) => Promise<void>,
  model?: (tool: string, input: ModelInput) => unknown,
) {
  const requests: string[] = [];
  const calls: { tool: string; input: ModelInput }[] = [];
  const errors: unknown[] = [];
  async function runModel(req: IncomingMessage) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { messages, tools } = JSON.parse(raw);
    const input: ModelInput = JSON.parse(
      messages.find((m: { role: string }) => m.role === 'user').content,
    );
    const [tool] = tools.map((t: { function: { name: string } }) => t.function.name);
    calls.push({ tool, input });
    const args = model
      ? model(tool, input)
      : input.sources
        ? { items: input.sources.map(({ id, text }) => ({ id, summary: text })) }
        : { acceptedIds: input.items!.map(({ id }) => id) };
    return {
      choices: [
        {
          message: { tool_calls: [{ function: { name: tool, arguments: JSON.stringify(args) } }] },
        },
      ],
    };
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/v1/chat/completions') {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(await runModel(req)));
        return;
      }
      requests.push(req.url!);
      const page = pages[req.url!];
      if (page === undefined) return void res.writeHead(404).end();
      if (req.url!.startsWith('/feed'))
        expect(req.headers.accept).toContain('application/atom+xml');
      const body =
        typeof page === 'function' ? page(requests.filter((url) => url === req.url).length) : page;
      if (typeof body === 'object')
        return void res.writeHead(302, { location: body.redirect }).end();
      res.end(body);
    } catch (error) {
      errors.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await test({
      origin,
      requests,
      calls,
      collect: (feeds, topic = '', issueDate = date) =>
        collectDailyNews({
          date: issueDate,
          settings: {
            enabled: true,
            time: '08:00',
            feeds: feeds.map((path) => origin + path),
            topic,
          },
          getCredentials: async () => ({
            kind: 'openai-compatible',
            baseUrl: origin + '/v1',
            model: 'scripted',
            apiKey: 'fixture',
          }),
          signal: AbortSignal.timeout(5000),
        }),
    });
    expect(errors).toEqual([]);
  } finally {
    await new Promise<void>((closed) => server.close(() => closed()));
  }
}

it('uses verified original titles, dates and URLs and independently rereads the selected sources', async () => {
  await withFixture(
    {
      '/feed-rss': rss(entry('/redirect'), entry('/older'), entry('/undated'), entry('/outgoing')),
      '/feed-atom': `<a:feed xmlns:a="http://www.w3.org/2005/Atom" xml:base="/articles/"><a:entry><a:title><![CDATA[RSS & Atom]]></a:title><a:link rel="self" href="ignored.xml"/><a:link rel="alternate" type="text/html" href="same?x=1&amp;y=2#section"/><a:published>${date}</a:published></a:entry><a:entry><a:title>Atom title</a:title><a:link href="unique"/><a:updated>2026-11-23T00:00:00Z</a:updated></a:entry></a:feed>`,
      '/redirect': () => ({ redirect: '/articles/same?x=1&y=2' }),
      '/articles/same?x=1&y=2': article(
        'Port &amp; lighthouse',
        'The harbour repaired 37 navigation lights.',
      ),
      '/articles/unique': `<html><script type="application/ld+json">{"@type":"NewsArticle","datePublished":"${date}"}</script><article><h1>Observatory</h1><p>The observatory measured the new comet.</p></article></html>`,
      '/older': article('Older story', 'Facts from an earlier day.', '2026-11-22'),
      '/undated': article('Undated story', 'Facts with no publication date.', ''),
      '/outgoing': () => ({ redirect: 'http://localhost:12345/not-authorized' }),
    },
    async ({ origin, collect, requests, calls }) => {
      const result = await collect(
        ['/feed-rss', '/feed-atom', '/feed-offline'],
        'Ports and observatories',
      );
      expect(result.items).toEqual([
        {
          title: 'Port & lighthouse',
          url: origin + '/articles/same?x=1&y=2',
          publishedAt: date,
          summary: expect.stringContaining('37 navigation lights'),
        },
        {
          title: 'Observatory',
          url: origin + '/articles/unique',
          publishedAt: date,
          summary: expect.stringContaining('new comet'),
        },
      ]);
      expect(requests.filter((path) => path === '/articles/unique')).toHaveLength(2);
      expect(requests).not.toContain('/articles/ignored.xml');
      expect(calls.map(({ tool }) => tool)).toEqual(['submit_daily_news', 'review_daily_news']);
      expect(calls[0].input).toMatchObject({ date, topic: 'Ports and observatories' });
      expect(calls[1].input.items).toHaveLength(2);
    },
  );
});

it('treats a valid feed without verifiable same-day originals differently from unavailable sources', async () => {
  await withFixture(
    {
      '/feed-empty': rss(entry('/stale'), entry('/unknown')),
      '/stale': article('Stale', 'Earlier facts.', '2026-11-20'),
      '/unknown':
        '<article><h1>No date</h1><p>Article travel schedule for 2026-11-23.</p></article>',
      '/feed-broken': rss(entry('/article-missing')),
      '/feed-unsafe': `<!DOCTYPE rss [<!ENTITY local SYSTEM "file:///private">]><rss><channel/></rss>`,
    },
    async ({ collect, calls }) => {
      expect(await collect(['/feed-empty'])).toMatchObject({
        items: [],
        message: expect.any(String),
      });
      await expect(collect(['/feed-invalid', '/feed-unsafe'])).rejects.toMatchObject({
        retryable: true,
      });
      await expect(collect(['/feed-broken'])).rejects.toMatchObject({ retryable: true });
      expect(calls).toEqual([]);
    },
  );
});

it('rejects invented identifiers in both strict model responses', async () => {
  const pages = {
    '/feed-rss': rss(entry('/article')),
    '/article': article('Title', 'Published claims.'),
  };
  await withFixture(
    pages,
    async ({ collect }) => {
      await expect(collect(['/feed-rss'])).rejects.toMatchObject({ retryable: true });
    },
    () => ({ items: [{ id: 'invented-by-writer', summary: 'False claims' }] }),
  );
  await withFixture(
    pages,
    async ({ collect }) => {
      await expect(collect(['/feed-rss'])).rejects.toMatchObject({ retryable: true });
    },
    (_tool, input) =>
      input.sources
        ? { items: [{ id: input.sources[0].id, summary: 'Published claims.' }] }
        : { acceptedIds: ['invented-by-reviewer'] },
  );
});

it('does not publish when the original changes before independent review', async () => {
  await withFixture(
    {
      '/feed-rss': rss(entry('/article')),
      '/article': (visit) =>
        visit === 1
          ? article('Announcement', 'The harbour repaired 37 lights.')
          : article('Announcement', 'The harbour repaired 7 lights.'),
    },
    async ({ collect, calls }) => {
      await expect(collect(['/feed-rss'])).rejects.toMatchObject({ retryable: true });
      expect(calls.map(({ tool }) => tool)).toEqual(['submit_daily_news']);
    },
  );
});

it('keeps feed and original redirects on the configured origin, including the port', async () => {
  const disallowed: string[] = [];
  const other = createServer((req, res) => {
    disallowed.push(req.url!);
    res.end(article('Wrong origin', 'Facts from a different local service.'));
  });
  await new Promise<void>((ready) => other.listen(0, '127.0.0.1', ready));
  const elsewhere = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  try {
    await withFixture(
      {
        '/feed-redirect': () => ({ redirect: `${elsewhere}/feed` }),
        '/feed-rss': rss(entry(elsewhere + '/direct'), entry('/wrong-port'), entry('/correct')),
        '/wrong-port': () => ({ redirect: elsewhere + '/redirected' }),
        '/correct': article('Correct', 'A source on the configured origin.'),
      },
      async ({ collect }) => {
        const result = await collect(['/feed-redirect', '/feed-rss']);
        expect(result.items.map(({ title }) => title)).toEqual(['Correct']);
        expect(result.message).toContain('部分');
        expect(disallowed).toEqual([]);
      },
    );
  } finally {
    await new Promise<void>((closed) => other.close(() => closed()));
  }
});

it('accepts long UTF-8 feeds and requires publication dates on the linked article', async () => {
  await withFixture(
    {
      '/feed-long': rss(
        `<!--${'通讯社'.repeat(24_000)}-->`,
        entry('/explicit', new Date(2026, 10, 23, 12).toUTCString()),
        entry('/displayed'),
        entry('/calendar'),
        entry('/internal-navigation'),
        entry('/updated'),
      ),
      '/explicit':
        '<html><!-- ignored --><script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","headline":"消息","datePublished":"2026-11-23"}]}</script><article><h1>消息</h1><p>科研团队发布了数据。</p></article></html>',
      '/displayed':
        '<article><h1>书展</h1><time datetime="2026-11-23">11 月 23 日</time><p>书展正式开幕。</p></article>',
      '/calendar':
        '<article><h1>日历</h1><p>下一场活动日期</p><time datetime="2026-11-23">11 月 23 日</time></article>',
      '/internal-navigation':
        '<main><h1>入口</h1><time datetime="2026-11-23">The current date</time><p>Browse our news archives.</p></main>',
      '/updated':
        '<article><h1>往期文章</h1><time itemprop="dateModified" datetime="2026-11-23">11 月 23 日更新</time><p>摘要。</p></article>',
    },
    async ({ collect }) => {
      const result = await collect(['/feed-long']);
      expect(result.items.map(({ title }) => title)).toEqual(['消息', '书展']);
    },
  );
});

it('publishes only the IDs independently accepted by the reviewer', async () => {
  await withFixture(
    {
      '/feed-rss': rss(entry('/approved'), entry('/rejected')),
      '/approved': article('Approved', 'The first original confirms the number.'),
      '/rejected': article('Rejected', 'The second original does not include that number.'),
    },
    async ({ collect }) => {
      const result = await collect(['/feed-rss']);
      expect(result.items.map(({ title }) => title)).toEqual(['Approved']);
    },
    (_tool, input) =>
      input.sources
        ? {
            items: input.sources.map(({ id }) => ({
              id,
              summary: 'The source confirms the number.',
            })),
          }
        : {
            acceptedIds: input
              .items!.filter(({ title }) => title === 'Approved')
              .map(({ id }) => id),
          },
  );
});

it('attributes structured publication dates to the main article on the fetched or canonical page', async () => {
  function graph(title: string, nodes: object[], canonical?: string) {
    return `<html><head>${canonical ? `<link rel="canonical" href="${canonical}">` : ''}<script type="application/ld+json">${JSON.stringify({ '@graph': nodes })}</script></head><body><article><h1>${title}</h1><p>The original text describes the announcement.</p></article></body></html>`;
  }
  const schemaArticle = (url: string, properties: object) => ({
    '@type': 'NewsArticle',
    url,
    ...properties,
  });
  await withFixture(
    {
      '/feed-rss': rss(
        entry('/undated'),
        entry('/dated'),
        entry('/alias'),
        entry('/outside'),
        entry('/main-reference'),
        entry('/undated-reference'),
        entry('/unrelated-canonical'),
      ),
      '/undated': graph('Undated primary', [
        schemaArticle('/undated', { headline: 'Undated primary' }),
        schemaArticle('/related', { '@id': '#related', datePublished: date }),
      ]),
      '/dated': graph('Dated primary', [
        schemaArticle('/related', { datePublished: '2026-11-20' }),
        schemaArticle('/dated', { datePublished: date }),
      ]),
      '/alias': graph(
        'Canonical article',
        [schemaArticle('/canonical', { headline: 'Canonical article', datePublished: date })],
        '/canonical',
      ),
      '/outside': graph(
        'Outside canonical',
        [
          schemaArticle('https://external.example/elsewhere', {
            headline: 'Outside canonical',
            datePublished: date,
          }),
        ],
        'https://external.example/elsewhere',
      ),
      '/main-reference': graph('Referenced article', [
        { '@type': 'WebPage', '@id': '/main-reference#page', mainEntity: { '@id': '#original' } },
        { '@type': 'NewsArticle', '@id': '#related', datePublished: '2026-11-20' },
        { '@type': 'NewsArticle', '@id': '#original', datePublished: date },
      ]),
      '/undated-reference': graph('Referenced but undated', [
        { '@type': 'WebPage', '@id': '/undated-reference#page', mainEntity: '#original' },
        { '@type': 'NewsArticle', '@id': '#original' },
        { '@type': 'NewsArticle', '@id': '#related', datePublished: date },
      ]),
      '/unrelated-canonical': graph(
        'A different article',
        [schemaArticle('/canonical', { headline: 'Canonical article', datePublished: date })],
        '/canonical',
      ),
    },
    async ({ collect }) => {
      const result = await collect(['/feed-rss']);
      expect(result.items.map(({ title }) => title)).toEqual([
        'Dated primary',
        'Canonical article',
        'Referenced article',
      ]);
    },
  );
});

it('reports missing historical feed coverage separately from an empty issue', async () => {
  await withFixture(
    {
      '/feed-rss': rss(entry('/december', '2020-12-01'), entry('/january', '2021-01-01')),
      '/feed-atom':
        '<feed xmlns="http://www.w3.org/2005/Atom"><entry><link href="/february"/><published>2021-02-01</published></entry></feed>',
      '/feed-with-history': rss(entry('/old', '2020-01-01')),
    },
    async ({ collect, calls, requests }) => {
      await expect(collect(['/feed-rss', '/feed-atom'], '', '2020-11-30')).rejects.toMatchObject({
        retryable: false,
        message: expect.stringContaining('历史'),
      });
      await expect(
        collect(['/feed-rss', '/feed-with-history'], '', '2020-11-30'),
      ).resolves.toMatchObject({ items: [] });
      expect(requests.every((request) => request.startsWith('/feed'))).toBe(true);
      expect(calls).toEqual([]);
    },
  );
});
