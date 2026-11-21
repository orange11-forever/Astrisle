import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import type { ToolContext } from '../../packages/contracts/src/index';
import { createExecutor } from '../../packages/executor/src/index';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

async function listen(handle: RequestListener) {
  const server = createServer(handle);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function fixture(searchEndpoint: string) {
  const context: ToolContext = {
    commissionId: 'commission',
    taskId: 'task',
    runId: 'run',
    workPath: process.cwd(),
    scope: {
      readRoots: [],
      writeRoots: [],
      allowProcess: false,
      allowNetwork: true,
      allowedHosts: ['Docs.Example', 'manual.example'],
      searchEndpoint,
    },
    signal: new AbortController().signal,
  };
  return { context, executor: createExecutor({ projectRoot: process.cwd() }) };
}

it('queries only the configured service and returns deduplicated authorized source results', async () => {
  const requests: { method?: string; url?: string }[] = [];
  const base = await listen((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        results: [
          { url: 'https://DOCS.EXAMPLE/article#one', title: 'First', content: 'Summary' },
          { url: 'https://docs.example/article#two', title: 'Duplicate' },
          { url: 'https://manual.example/guide', title: 'Guide' },
          { url: 'https://www.docs.example/elsewhere', title: 'Subdomain' },
          { url: 'https://docs.example.bad/elsewhere', title: 'Suffix' },
          { url: 'https://account:secret@docs.example/private', title: 'Credentials' },
          { url: 'ftp://docs.example/download', title: 'Non-HTTP' },
          { url: '/relative', title: 'Relative' },
          { url: `${base}/another`, title: 'Search provider is not a source host' },
        ],
      }),
    );
  });
  const { context, executor } = fixture(`${base}/searxng/search`);
  const result = await executor.execute(
    'web_search',
    { query: '  public release notes  ' },
    context,
  );
  expect(result.ok, result.output).toBe(true);
  expect(JSON.parse(result.output)).toEqual([
    { url: 'https://docs.example/article', title: 'First', snippet: 'Summary' },
    { url: 'https://manual.example/guide', title: 'Guide', snippet: '' },
  ]);
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('GET');
  const request = new URL(requests[0].url!, base);
  expect(request.pathname).toBe('/searxng/search');
  expect(Object.fromEntries(request.searchParams)).toEqual({
    q: '(site:docs.example OR site:manual.example) public release notes',
    format: 'json',
  });
});

it('requires network permission, a configured search endpoint and authorized source hosts', async () => {
  let calls = 0;
  const base = await listen((_req, res) => {
    calls++;
    res.end();
  });
  const endpoint = `${base}/search`;
  const { context, executor } = fixture(endpoint);
  for (const missing of [
    { allowNetwork: false },
    { allowedHosts: [] },
    { allowedHosts: ['Docs.Example:443', 'docs.example/topic', 'user@manual.example'] },
    { searchEndpoint: undefined },
    { searchEndpoint: `${endpoint}?configured=1` },
    { searchEndpoint: `${endpoint}#fragment` },
    { searchEndpoint: endpoint.replace('://', '://account:secret@') },
    { searchEndpoint: endpoint.replace('http:', 'file:') },
  ]) {
    const result = await executor.execute(
      'web_search',
      { query: 'release notes' },
      {
        ...context,
        scope: { ...context.scope, ...missing },
      },
    );
    expect(result.code, result.output).toBe('SCOPE_DENIED');
  }
  expect(calls).toBe(0);
});

it('rejects an endpoint override and out-of-bounds queries before contacting the service', async () => {
  let calls = 0;
  const base = await listen((_req, res) => {
    calls++;
    res.end();
  });
  const { context, executor } = fixture(`${base}/search`);
  for (const args of [
    { query: 'release notes', url: `${base}/override` },
    { query: '  ' },
    { query: 'x'.repeat(2049) },
  ]) {
    const result = await executor.execute('web_search', args, context);
    expect(result.code, result.output).toBe('INVALID_ARGUMENT');
  }
  expect(calls).toBe(0);
});

it('does not follow search redirects even to the same host', async () => {
  const requests: (string | undefined)[] = [];
  const base = await listen((req, res) => {
    requests.push(req.url);
    res.writeHead(307, { location: '/other-service?q=release+notes' }).end();
  });
  const { context, executor } = fixture(`${base}/search`);
  const result = await executor.execute('web_search', { query: 'release notes' }, context);
  expect(result).toMatchObject({ ok: false, code: 'NETWORK_FAILED' });
  expect(result.output).toMatch(/redirect/i);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatch(/^\/search\?/);
});

it('omits the search route from source results even when its host is authorized', async () => {
  const base = await listen((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        results: [
          { url: `${base}/search?q=release+notes` },
          { url: `${base}/search/?q=release+notes` },
          { url: `${base}/news` },
        ],
      }),
    );
  });
  const { context, executor } = fixture(`${base}/search`);
  context.scope.allowedHosts = ['127.0.0.1'];
  const result = await executor.execute('web_search', { query: 'release notes' }, context);
  expect(result.ok, result.output).toBe(true);
  expect(JSON.parse(result.output)).toEqual([{ url: `${base}/news`, title: '', snippet: '' }]);
});

it.each([
  { status: 403, contentType: 'text/html', body: 'Access denied', message: /403.*JSON/i },
  { status: 200, contentType: 'text/html', body: '<html>Login</html>', message: /JSON/i },
  { status: 200, contentType: 'application/json', body: '{broken', message: /JSON/i },
  { status: 200, contentType: 'application/json', body: '{}', message: /results/i },
])('explains an unusable search response ($status $contentType $body)', async (reply) => {
  const base = await listen((_req, res) => {
    res.writeHead(reply.status, { 'content-type': reply.contentType }).end(reply.body);
  });
  const { context, executor } = fixture(`${base}/search`);
  const result = await executor.execute('web_search', { query: 'release notes' }, context);
  expect(result).toMatchObject({ ok: false, code: 'NETWORK_FAILED' });
  expect(result.output).toMatch(reply.message);
});

it('limits result count and field size while keeping the output valid JSON', async () => {
  const base = await listen((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        results: Array.from({ length: 20 }, (_value, index) => ({
          url: `https://docs.example/article-${index}`,
          title: 'x'.repeat(1000),
          content: 'y'.repeat(5000),
        })),
      }),
    );
  });
  const { context, executor } = fixture(`${base}/search`);
  const result = await executor.execute('web_search', { query: 'release notes' }, context);
  expect(result.ok, result.output).toBe(true);
  const results = JSON.parse(result.output);
  expect(results).toHaveLength(8);
  expect(results[0].title.length).toBeLessThan(1000);
  expect(results[0].snippet.length).toBeLessThan(5000);
});

it('bounds bytes read from a streamed response', async () => {
  const base = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('a'.repeat(1024 * 1024));
    res.end('b');
  });
  const { context, executor } = fixture(`${base}/search`);
  const result = await executor.execute('web_search', { query: 'release notes' }, context);
  expect(result).toMatchObject({ ok: false, code: 'SIZE_LIMIT' });
});

it('stops an in-flight search when cancelled', async () => {
  const controller = new AbortController();
  const base = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
    setTimeout(() => controller.abort(), 10);
  });
  const { context, executor } = fixture(`${base}/search`);
  context.signal = controller.signal;
  const result = await executor.execute('web_search', { query: 'release notes' }, context);
  expect(result).toMatchObject({ ok: false, code: 'ABORTED' });
});

it('reports the final authorized URL of a successful web read', async () => {
  const base = await listen((req, res) => {
    if (req.url === '/start') res.writeHead(302, { location: '/article' }).end();
    else res.end('Article text');
  });
  const { context, executor } = fixture(`${base}/search`);
  context.scope.allowedHosts.push('127.0.0.1');
  const result = await executor.execute('web_read', { url: `${base}/start` }, context);
  expect(result).toMatchObject({
    ok: true,
    output: 'Article text',
    metadata: { url: `${base}/article`, status: 200 },
  });
});

it('keeps web_read off the configured search route on every hop', async () => {
  let searchRequests = 0;
  const base = await listen((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/search/?q=release+notes' }).end();
    } else if (req.url?.startsWith('/search')) {
      searchRequests++;
      res.end('{}');
    } else {
      res.end('Article text');
    }
  });
  const { context, executor } = fixture(`${base}/search`);
  context.scope.allowedHosts = ['127.0.0.1'];
  const direct = await executor.execute('web_read', { url: `${base}/search` }, context);
  const viaRedirect = await executor.execute('web_read', { url: `${base}/start` }, context);
  const article = await executor.execute('web_read', { url: `${base}/article` }, context);
  expect(searchRequests).toBe(0);
  expect(direct).toMatchObject({ ok: false, code: 'SCOPE_DENIED' });
  expect(viaRedirect).toMatchObject({ ok: false, code: 'SCOPE_DENIED' });
  expect(article).toMatchObject({ ok: true, output: 'Article text' });
});

it('reads an authorized redirect without exposing its credentials in the final URL', async () => {
  let readSecretLink = false;
  const base = await listen((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/article?access_token=provider-secret' }).end();
    } else {
      readSecretLink = req.url === '/article?access_token=provider-secret';
      res.end('Article text');
    }
  });
  const { context, executor } = fixture(`${base}/search`);
  context.scope.allowedHosts.push('127.0.0.1');
  const result = await executor.execute('web_read', { url: `${base}/start` }, context);
  expect(readSecretLink).toBe(true);
  expect(result).toMatchObject({ ok: true, output: 'Article text', metadata: { status: 200 } });
  expect(result.metadata).not.toHaveProperty('url');
  expect(JSON.stringify(result)).not.toContain('provider-secret');
});
