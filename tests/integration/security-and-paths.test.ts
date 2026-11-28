import { createServer, type Server } from 'node:http';
import { mkdtemp, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../packages/contracts/src/index';
import { resolveDesktopPaths } from '../../apps/desktop/src/paths';
import { contentSecurityPolicy } from '../../apps/desktop/src/security';
import { createExecutor } from '../../packages/executor/src/index';
import {
  isRestrictedIpAddress,
  webRead,
  webSearch,
  type HostLookup,
} from '../../packages/executor/src/web';

const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

function makeContext(overrides: Partial<ToolContext['scope']> = {}): ToolContext {
  return {
    commissionId: 'commission-sec',
    taskId: 'task-sec',
    runId: 'run-sec',
    workPath: process.cwd(),
    scope: {
      readRoots: [],
      writeRoots: [],
      allowProcess: false,
      allowNetwork: true,
      allowedHosts: ['docs.example.com'],
      ...overrides,
    },
    signal: new AbortController().signal,
  };
}

describe('desktop resource paths', () => {
  it('resolves development binary and worker paths across platforms', () => {
    const projectRoot = 'C:\\Astrisle';
    expect(
      resolveDesktopPaths({
        projectRoot,
        packaged: false,
        platform: 'win32',
      }),
    ).toEqual({
      supervisorPath: join(projectRoot, 'dist/helpers/process-supervisor.exe'),
      safeApplyPath: join(projectRoot, 'dist/helpers/safe-apply.exe'),
      pythonPath: join(projectRoot, '.venv', 'Scripts/python.exe'),
      officeWorkerPath: join(projectRoot, 'workers/office/worker.py'),
    });

    for (const platform of ['linux', 'darwin'] as const) {
      expect(
        resolveDesktopPaths({
          projectRoot: '/workspace/astrisle',
          packaged: false,
          platform,
        }),
      ).toEqual({
        supervisorPath: join('/workspace/astrisle', 'dist/helpers/process-supervisor.exe'),
        safeApplyPath: join('/workspace/astrisle', 'dist/helpers/safe-apply.exe'),
        pythonPath: join('/workspace/astrisle', '.venv', 'bin/python'),
        officeWorkerPath: join('/workspace/astrisle', 'workers/office/worker.py'),
      });
    }
  });

  it('resolves packaged resource paths outside app.asar and requires resourcesPath', () => {
    const projectRoot = 'C:\\Program Files\\Astrisle\\resources\\app.asar';
    const resourcesPath = 'C:\\Program Files\\Astrisle\\resources';
    expect(
      resolveDesktopPaths({
        projectRoot,
        resourcesPath,
        packaged: true,
        platform: 'win32',
      }),
    ).toEqual({
      supervisorPath: join(resourcesPath, 'helpers/process-supervisor.exe'),
      safeApplyPath: join(resourcesPath, 'helpers/safe-apply.exe'),
      pythonPath: join(resourcesPath, 'office-python', 'python.exe'),
      officeWorkerPath: join(resourcesPath, 'workers/office/worker.py'),
    });

    for (const platform of ['linux', 'darwin'] as const) {
      expect(
        resolveDesktopPaths({
          projectRoot: '/opt/Astrisle/resources/app.asar',
          resourcesPath: '/opt/Astrisle/resources',
          packaged: true,
          platform,
        }),
      ).toEqual({
        supervisorPath: join('/opt/Astrisle/resources', 'helpers/process-supervisor.exe'),
        safeApplyPath: join('/opt/Astrisle/resources', 'helpers/safe-apply.exe'),
        pythonPath: join('/opt/Astrisle/resources', 'office-python', 'bin/python'),
        officeWorkerPath: join('/opt/Astrisle/resources', 'workers/office/worker.py'),
      });
    }

    expect(() =>
      resolveDesktopPaths({
        projectRoot,
        packaged: true,
        platform: 'win32',
      }),
    ).toThrow(/resourcesPath/);
    expect(() =>
      resolveDesktopPaths({
        projectRoot,
        resourcesPath: '   ',
        packaged: true,
        platform: 'win32',
      }),
    ).toThrow(/resourcesPath/);
  });

  it('allows createExecutor to probe decoupled helper paths outside projectRoot', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'astrisle-paths-')));
    tempDirs.push(root);
    const asarRoot = join(root, 'app.asar');
    const resourcesRoot = join(root, 'resources');
    await mkdir(join(resourcesRoot, 'helpers'), { recursive: true });
    const supervisorPath = join(resourcesRoot, 'helpers/process-supervisor.exe');
    const safeApplyPath = join(resourcesRoot, 'helpers/safe-apply.exe');
    await writeFile(supervisorPath, 'stub');
    await writeFile(safeApplyPath, 'stub');

    const unconfigured = await createExecutor({ projectRoot: asarRoot }).capabilities();
    if (process.platform === 'win32') {
      expect(unconfigured.find((c) => c.id === 'process')?.available).toBe(false);
      expect(unconfigured.find((c) => c.id === 'safe_apply')?.available).toBe(false);
    }

    const configured = await createExecutor({
      projectRoot: asarRoot,
      supervisorPath,
      safeApplyPath,
      pythonPath: join(resourcesRoot, 'office-python/python.exe'),
      workerPath: join(resourcesRoot, 'workers/office/worker.py'),
    }).capabilities();
    expect(configured.find((c) => c.id === 'process')?.available).toBe(true);
    if (process.platform === 'win32') {
      expect(configured.find((c) => c.id === 'safe_apply')?.available).toBe(true);
    }
  });
});

describe('renderer Content Security Policy', () => {
  it('enforces a strict script policy in packaged mode while allowing blob/data models and inline Three/React styles', () => {
    const policy = contentSecurityPolicy();
    expect(policy).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toContain('127.0.0.1:5173');
  });

  it('permits Vite HMR inline preamble and websocket only for the supported local dev origin', () => {
    const devPolicy = contentSecurityPolicy('http://127.0.0.1:5173');
    expect(devPolicy).toContain("script-src 'self' 'unsafe-inline' http://127.0.0.1:5173");
    expect(devPolicy).toContain("style-src 'self' 'unsafe-inline' http://127.0.0.1:5173");
    expect(devPolicy).toContain(
      "connect-src 'self' data: blob: http://127.0.0.1:5173 ws://127.0.0.1:5173",
    );
    expect(devPolicy).toContain("object-src 'none'");
    expect(devPolicy).toContain("base-uri 'none'");
    expect(devPolicy).toContain("frame-ancestors 'none'");
    expect(devPolicy).not.toContain('unsafe-eval');

    expect(() => contentSecurityPolicy('http://evil.example:5173')).toThrow(
      /Unsupported development origin/,
    );
  });
});

describe('private/local IP classification and DNS rebinding protection', () => {
  it.each([
    '0.0.0.0',
    '0.10.20.30',
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '100.127.255.254',
    '169.254.169.254',
    '169.254.0.1',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.0.1',
    '192.168.255.254',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '[::1]',
    'fe80::1',
    'fe80::1%12',
    'fc00::1',
    'fd12:3456:789a::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:10.0.0.1',
    '::ffff:172.16.5.4',
    '::ffff:192.168.1.1',
    '0:0:0:0:0:ffff:169.254.169.254',
  ])('classifies restricted private, loopback, or link-local address: %s', (address) => {
    expect(isRestrictedIpAddress(address)).toBe(true);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '100.63.255.255',
    '100.128.0.1',
    '172.15.255.254',
    '172.32.0.1',
    '192.167.255.254',
    '2606:2800:220:1:248:1893:25c8:1946',
    '2001:4860:4860::8888',
    '::ffff:93.184.216.34',
  ])('permits public unicast address: %s', (address) => {
    expect(isRestrictedIpAddress(address)).toBe(false);
  });

  it.each([
    { label: '127.0.0.1', records: [{ address: '127.0.0.1', family: 4 }] },
    { label: '169.254.169.254', records: [{ address: '169.254.169.254', family: 4 }] },
    { label: '10.1.2.3', records: [{ address: '10.1.2.3', family: 4 }] },
    { label: '172.20.0.5', records: [{ address: '172.20.0.5', family: 4 }] },
    { label: '192.168.1.9', records: [{ address: '192.168.1.9', family: 4 }] },
    { label: '::1', records: [{ address: '::1', family: 6 }] },
    { label: 'fc00::42', records: [{ address: 'fc00::42', family: 6 }] },
    { label: '::ffff:127.0.0.1', records: [{ address: '::ffff:127.0.0.1', family: 6 }] },
    {
      label: 'dual-stack with private IP',
      records: [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
    },
  ])(
    'blocks DNS rebinding before fetch when docs.example.com resolves to $label',
    async ({ records }) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const lookup = vi.fn<HostLookup>().mockResolvedValue(records);
      const context = makeContext({ allowedHosts: ['docs.example.com'] });

      await expect(
        webRead('https://docs.example.com/article', context, { lookup }),
      ).rejects.toMatchObject({
        code: 'SCOPE_DENIED',
        message: expect.stringMatching(/restricted private or local address/i),
      });
      expect(lookup).toHaveBeenCalledWith('docs.example.com', { all: true, verbatim: true });
      expect(fetchSpy).not.toHaveBeenCalled();

      const executor = createExecutor({ projectRoot: process.cwd(), lookup });
      const result = await executor.execute(
        'web_read',
        { url: 'https://docs.example.com/article' },
        context,
      );
      expect(result).toMatchObject({
        ok: false,
        code: 'SCOPE_DENIED',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('blocks DNS rebinding on redirect hops and allows explicit literal 127.0.0.1 when authorized', async () => {
    let secretHits = 0;
    let port = 0;
    const server = createServer((req, res) => {
      if (req.url === '/public-local') {
        res.end('Allowed explicit loopback');
      } else if (req.url === '/redirect-to-rebind') {
        res.writeHead(302, { location: `http://rebind.example.com:${port}/secret` }).end();
      } else {
        secretHits++;
        res.end('Internal metadata');
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;

    const lookup = vi.fn<HostLookup>().mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const context = makeContext({
      allowedHosts: ['127.0.0.1', 'rebind.example.com'],
    });

    const allowed = await webRead(`http://127.0.0.1:${port}/public-local`, context, { lookup });
    expect(allowed).toMatchObject({
      ok: true,
      output: 'Allowed explicit loopback',
      metadata: { status: 200, url: `http://127.0.0.1:${port}/public-local` },
    });
    expect(lookup).not.toHaveBeenCalled();

    await expect(
      webRead(`http://127.0.0.1:${port}/redirect-to-rebind`, context, { lookup }),
    ).rejects.toMatchObject({
      code: 'SCOPE_DENIED',
    });
    expect(lookup).toHaveBeenCalledWith('rebind.example.com', { all: true, verbatim: true });
    expect(secretHits).toBe(0);
  });

  it('blocks DNS rebinding on webSearch endpoints and reports unresolvable hosts as NETWORK_FAILED', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const rebindLookup = vi
      .fn<HostLookup>()
      .mockResolvedValue([{ address: '10.0.0.9', family: 4 }]);
    const searchContext = makeContext({
      allowedHosts: ['docs.example.com'],
      searchEndpoint: 'https://search.example.com/search',
    });

    await expect(
      webSearch('astrisle release', searchContext, { lookup: rebindLookup }),
    ).rejects.toMatchObject({
      code: 'SCOPE_DENIED',
    });
    expect(rebindLookup).toHaveBeenCalledWith('search.example.com', {
      all: true,
      verbatim: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    const emptyLookup = vi.fn<HostLookup>().mockResolvedValue([]);
    await expect(
      webRead('https://docs.example.com/article', searchContext, { lookup: emptyLookup }),
    ).rejects.toMatchObject({
      code: 'NETWORK_FAILED',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
