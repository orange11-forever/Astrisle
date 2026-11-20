import { spawn } from 'node:child_process';
import { lstat, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { build } from 'esbuild';

const project = resolve(fileURLToPath(new URL('../', import.meta.url)));
const source = resolve(project, process.env.ASTRISLE_DATA_ROOT || '.astrisle-dev');
const canvasSelector = '.studio-canvas canvas';

async function screenshotDestination(rawArgs) {
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  if (!args.length) return;
  if (args.length !== 2 || args[0] !== '--screenshot' || extname(args[1]).toLowerCase() !== '.png')
    throw new Error('用法：pnpm.cmd demo [--screenshot <新建的本地 PNG 路径>]');
  const path = resolve(args[1]);
  if (process.platform === 'win32' && path.startsWith('\\\\'))
    throw new Error('请选择本机磁盘上的截图路径。');
  if (
    !(await stat(dirname(path)).then(
      (info) => info.isDirectory(),
      () => false,
    ))
  )
    throw new Error(`截图的父目录不存在：${dirname(path)}`);
  try {
    await lstat(path);
    throw new Error(`截图目标已存在：${path}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return path;
}

async function buildApplication(signal) {
  const windows = process.platform === 'win32';
  await new Promise((accept, reject) => {
    const child = spawn(windows ? 'pnpm.cmd' : 'pnpm', ['run', 'build'], {
      cwd: project,
      stdio: 'inherit',
      signal,
      shell: windows,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) accept();
      else reject(new Error(`Astrisle 构建失败（${code ?? signal}）。`));
    });
  });
}

async function launchDemo() {
  const screenshot = await screenshotDestination(process.argv.slice(2));
  const stop = new AbortController();
  const requestStop = () => stop.abort();
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  const interrupted = new Promise((accept) =>
    stop.signal.addEventListener('abort', accept, { once: true }),
  );
  const whileRunning = (work) =>
    Promise.race([work, interrupted.then(() => stop.signal.throwIfAborted())]);
  let demo;
  let app;
  let closed = false;
  try {
    const { outputFiles } = await build({
      entryPoints: [resolve(project, 'scripts/demo-data.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      write: false,
      logLevel: 'warning',
      absWorkingDir: project,
    });
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`;
    const { prepareDemoData } = await import(moduleUrl);
    demo = await prepareDemoData(source);
    const configured = Object.values(demo.expected).filter((asset) => asset !== 'builtin').length;
    const total = Object.keys(demo.expected).length;
    if (!configured) console.warn(`本次演示的 ${total} 位角色使用默认外观。`);
    else console.log(`已校验当前配置的 ${configured} 个角色模型副本。`);
    stop.signal.throwIfAborted();
    await buildApplication(stop.signal);

    // Demo data and configuration come only from the verified snapshot above.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.toUpperCase().startsWith('ASTRISLE_') &&
          key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE',
      ),
    );
    app = await electron.launch({
      args: [project],
      cwd: project,
      env: { ...env, ASTRISLE_DATA_ROOT: demo.root, ASTRISLE_MODEL_DEMO: '1' },
      timeout: 30_000,
    });
    const onClose = new Promise((accept) =>
      app.once('close', () => {
        closed = true;
        accept();
      }),
    );
    stop.signal.throwIfAborted();
    const page = await whileRunning(app.firstWindow({ timeout: 30_000 }));
    const nativeWindow = await app.browserWindow(page);
    if (await nativeWindow.evaluate((window) => window.isVisible()))
      throw new Error('演示窗口必须保持隐藏，直到实际加载的角色模型通过核验。');
    await whileRunning(page.waitForLoadState('domcontentloaded'));
    await whileRunning(
      page.evaluate(() => window.astrisle.createWorkspace({ name: '角色演示工作区' })),
    );
    await whileRunning(page.reload({ waitUntil: 'domcontentloaded' }));
    const verifyModels = () =>
      whileRunning(
        page.waitForFunction(
          ({ selector, expected }) => {
            const canvas = document.querySelector(selector);
            return (
              canvas &&
              Object.entries(expected).every(
                ([id, asset]) => canvas.getAttribute(`data-character-${id}`) === asset,
              )
            );
          },
          { selector: canvasSelector, expected: demo.expected },
          { polling: 100, timeout: 90_000 },
        ),
      );
    try {
      await verifyModels();
    } catch (error) {
      stop.signal.throwIfAborted();
      throw new Error('演示画布未在 90 秒内加载配置中的全部角色模型，演示窗口保持隐藏。', {
        cause: error,
      });
    }
    stop.signal.throwIfAborted();
    const visible = await nativeWindow.evaluate((window) => {
      if (window.isVisible()) throw new Error('演示窗口在角色核验前已显示。');
      window.show();
      window.focus();
      return { pid: process.pid, title: window.getTitle(), shown: window.isVisible() };
    });
    if (!visible.shown) throw new Error('角色已核验，但演示窗口未能显示。');
    console.log(
      `已核验全部 ${total} 个角色并显示窗口“${visible.title}”（PID ${visible.pid}）。关闭窗口会清理临时工作区。`,
    );
    if (screenshot) {
      try {
        await verifyModels();
        const png = await whileRunning(page.screenshot({ type: 'png', timeout: 30_000 }));
        await writeFile(screenshot, png, { flag: 'wx' });
        console.log(`已保存完成角色核验后的演示截图：${screenshot}`);
      } catch (error) {
        if (!stop.signal.aborted) {
          console.error(`[Astrisle 演示] 截图失败：${error.message}`);
          process.exitCode = 1;
        }
      }
    }
    await Promise.race([onClose, interrupted]);
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
    if (app && !closed) {
      try {
        await app.close();
      } catch (error) {
        throw new Error(`演示进程未能关闭，临时数据仍位于 ${demo.root}。`, { cause: error });
      }
    }
    await demo?.cleanup();
  }
}

try {
  await launchDemo();
} catch (error) {
  console.error(`[Astrisle 演示] ${error.message}`);
  process.exitCode = 1;
}
