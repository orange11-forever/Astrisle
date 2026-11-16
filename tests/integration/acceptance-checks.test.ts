import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutor } from '../../packages/executor/src/index';
import { checkContext, checkDeliverables } from '../acceptance/checks';
import { checkSchema } from '../acceptance/schema';
import { parseAcceptanceArgs, providerFromEnvironment } from '../acceptance/config';
import { sanitize } from '../acceptance/report';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-checks-')));
  roots.push(root);
  const executor = createExecutor({ projectRoot: process.cwd() });
  const signal = new AbortController().signal;
  return { root, executor, signal, projectRoot: process.cwd(), allowProcess: true };
}
it('executes candidate Node output with bounded processes and independent expectations', async () => {
  const options = await setup();
  await writeFile(join(options.root, 'result.mjs'), 'console.log(JSON.stringify({total: 42}))');
  const good = checkSchema.parse({ kind: 'node', path: 'result.mjs', json: { total: 42 } });
  if (good.kind !== 'node') throw new Error('fixture');
  expect((await checkDeliverables({ ...options, checks: [good] }))[0].status).toBe('passed');
  expect(
    (await checkDeliverables({ ...options, checks: [{ ...good, json: { total: 43 } }] }))[0].status,
  ).toBe('failed');
  expect(
    (await checkDeliverables({ ...options, allowProcess: false, checks: [good] }))[0].status,
  ).toBe('failed');
});
it('reopens real Office output and fails an incorrect source-cell sum', async () => {
  const options = await setup();
  const context = checkContext(options.root, options.signal);
  context.scope.writeRoots = [options.root];
  const created = await options.executor.execute(
    'office_create',
    {
      format: 'xlsx',
      output: 'values.xlsx',
      content: {
        sheets: [
          {
            name: 'Data',
            rows: [
              ['Item', 'Value'],
              ['A', 10],
              ['B', 20],
            ],
          },
        ],
      },
    },
    context,
  );
  expect(created.ok, created.output).toBe(true);
  const check = checkSchema.parse({
    kind: 'office',
    path: 'values.xlsx',
    assertions: [{ at: ['sheets', 0, 'name'], equals: 'Data' }],
    sums: [{ sheet: 'Data', range: 'B2:B3', sum: 30 }],
  });
  expect((await checkDeliverables({ ...options, checks: [check] }))[0].status).toBe('passed');
  if (check.kind !== 'office') throw new Error('fixture');
  expect(
    (
      await checkDeliverables({
        ...options,
        checks: [{ ...check, sums: [{ sheet: 'Data', range: 'B2:B3', sum: 31 }] }],
      })
    )[0].status,
  ).toBe('failed');
});
it('does not read or execute checks outside the export root', async () => {
  const options = await setup();
  await mkdir(join(options.root, 'export'));
  await writeFile(join(options.root, 'outside.txt'), 'private');
  const result = await checkDeliverables({
    ...options,
    root: join(options.root, 'export'),
    checks: [{ kind: 'text', path: '../outside.txt', equals: 'private' }],
  });
  expect(result[0].status).toBe('failed');
});
it('validates CLI bounds and never accepts credentials as command-line arguments', () => {
  expect(
    parseAcceptanceArgs(['--scenario', 'code-new', '--repeat', '2', '--allow-process']),
  ).toMatchObject({ scenario: 'code-new', repeat: 2, allowProcess: true });
  expect(() => parseAcceptanceArgs(['--repeat', '0'])).toThrow();
  expect(() => parseAcceptanceArgs(['--api-key', 'secret'])).toThrow();
  expect(() => parseAcceptanceArgs(['--scenario-file', 'a.json', '--scenario', 'all'])).toThrow();
});
it('requires explicit provider configuration and validates remote HTTPS', () => {
  expect(providerFromEnvironment({})).toBeNull();
  expect(() =>
    providerFromEnvironment({
      ASTRISLE_PROVIDER_KIND: 'openai-compatible',
      ASTRISLE_PROVIDER_URL: 'http://remote.invalid',
      ASTRISLE_PROVIDER_MODEL: 'demo',
      ASTRISLE_PROVIDER_API_KEY: 'secret',
    }),
  ).toThrow();
  expect(
    providerFromEnvironment({
      ASTRISLE_PROVIDER_KIND: 'openai-compatible',
      ASTRISLE_PROVIDER_URL: 'https://api.deepseek.com',
      ASTRISLE_PROVIDER_MODEL: 'deepseek-flash',
      ASTRISLE_PROVIDER_API_KEY: 'secret',
    }),
  ).toMatchObject({ kind: 'openai-compatible', model: 'deepseek-flash' });
});
it('redacts secrets in report map keys and preserves entries after redaction collisions', () => {
  const value = sanitize(
    {
      exportHashes: { 'synthetic-review-key.txt': 'one', '[REDACTED].txt': 'two' },
      detail: 'synthetic-review-key',
    },
    'synthetic-review-key',
  );
  expect(JSON.stringify(value)).not.toContain('synthetic-review-key');
  expect(Object.values(value.exportHashes).sort()).toEqual(['one', 'two']);
});
