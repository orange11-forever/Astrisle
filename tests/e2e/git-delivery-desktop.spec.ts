import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchIsolatedElectron } from '../fixtures/electron';
import { reviewProject, seedReview } from '../fixtures/review-project';
import { RuntimeStore } from '../../packages/persistence/src';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });

function launchGitFixture(data: string) {
  const old = process.env.ASTRISLE_TEST_LOCAL_GIT;
  process.env.ASTRISLE_TEST_LOCAL_GIT = '1';
  try {
    return launchIsolatedElectron(data);
  } finally {
    if (old === undefined) delete process.env.ASTRISLE_TEST_LOCAL_GIT;
    else process.env.ASTRISLE_TEST_LOCAL_GIT = old;
  }
}
async function approveNativePush(app: ElectronApplication) {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async (...args: unknown[]) => {
      const options = args.at(-1) as { title?: string; defaultId?: number } | undefined;
      if (options?.title !== '确认 Git 推送' || options.defaultId !== 0)
        throw Error('Missing native Git confirmation');
      return { response: 1, checkboxChecked: false };
    };
  });
}

test('accepted code requests a Git handoff and native confirmation pushes the exact preview to a new remote branch', async ({}, info) => {
  test.setTimeout(150_000);
  const testRoot = info.outputPath('git-delivery');
  await mkdir(testRoot, { recursive: true });
  const root = await realpath(testRoot);
  const data = join(root, 'data'),
    source = join(root, 'source'),
    remote = join(data, 'git-remotes', 'origin.git');
  await mkdir(source, { recursive: true });
  await mkdir(remote, { recursive: true });
  git(remote, 'init', '--bare', '--initial-branch=main');
  git(source, 'init', '--initial-branch=main');
  await writeFile(join(source, reviewProject.file), reviewProject.originalText);
  git(source, 'add', '--', reviewProject.file);
  git(
    source,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Base',
  );
  git(source, 'remote', 'add', 'origin', remote);
  git(source, 'push', 'origin', 'main');
  const base = git(remote, 'rev-parse', 'refs/heads/main').trim();
  const { current } = await seedReview(data, source);
  const store = new RuntimeStore(data);
  try {
    const snapshot = store.get(reviewProject.commissionId);
    snapshot.commission.gitDeliveryRequested = true;
    store.save(snapshot);
  } finally {
    store.close();
  }
  let app = await launchGitFixture(data);
  try {
    let page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: '展开项目与委托' }).click();
    await page.getByRole('button', { name: '项目说明验收 待验收' }).click();
    await page.evaluate(
      async ({ id, artifact }) => {
        const result = await window.astrisle!.accept(id, [artifact]);
        if (!result.ok) throw Error(result.message);
      },
      { id: reviewProject.commissionId, artifact: current.id },
    );
    const request = await page.evaluate(
      async (id) =>
        (await window.astrisle!.snapshot(id)).requests.find((r) => r.purpose === 'git_delivery'),
      reviewProject.commissionId,
    );
    expect(request?.status).toBe('open');
    expect(
      await page.evaluate((id) => window.astrisle!.answer(id, '', true), request!.id),
    ).toMatchObject({ ok: false, code: 'git_preview_required' });
    await page.getByRole('button', { name: '输入与审批', exact: true }).click();
    await page.getByRole('button', { name: '查看 Git 交付' }).click();
    let panel = page.getByRole('region', { name: 'Git 分支交付' });
    await panel.getByRole('button', { name: '预览 Git 推送' }).click();
    await panel.locator('summary').click();
    await expect(panel.locator('pre')).toContainText('Reviewed draft marker');
    const preview = (await page.evaluate(
      (id) => window.astrisle!.latestGitDelivery!(id),
      reviewProject.commissionId,
    ))!.preview;
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await panel.getByRole('button', { name: '确认并推送新分支' }).click();
    await expect(panel).toContainText('已取消本次推送');
    expect(git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/astrisle/').trim()).toBe(
      '',
    );
    await approveNativePush(app);
    expect(preview.targetBranch).toMatch(/^astrisle\/delivery-[a-f\d-]+$/);
    const refLock = join(remote, 'refs', 'heads', preview.targetBranch) + '.lock';
    await mkdir(dirname(refLock), { recursive: true });
    await writeFile(refLock, 'held by fixture', { flag: 'wx' });
    await panel.getByRole('button', { name: '确认并推送新分支' }).click();
    await expect(panel).toContainText('待核查');
    await unlink(refLock);
    await app.close();
    app = await launchGitFixture(data);
    await approveNativePush(app);
    page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: '展开项目与委托' }).click();
    await page.getByRole('button', { name: '项目说明验收 已接受' }).click();
    await page.getByRole('button', { name: '成果与验收', exact: true }).click();
    panel = page.getByRole('region', { name: 'Git 分支交付' });
    expect(
      (
        await page.evaluate(
          (id) => window.astrisle!.latestGitDelivery!(id),
          reviewProject.commissionId,
        )
      )?.preview.operationId,
    ).toBe(preview.operationId);
    await panel.getByRole('button', { name: '核查并重试原推送' }).click();
    await expect(panel).toContainText('已推送');
    await panel.getByRole('button', { name: '核查远端分支' }).click();
    await expect(panel).toContainText('远端分支仍指向此次交付的提交');
    expect(git(remote, 'rev-parse', 'main').trim()).toBe(base);
    expect(git(remote, 'show', preview.targetBranch + ':' + reviewProject.file)).toContain(
      'Reviewed draft marker.',
    );
    expect(await readFile(join(source, reviewProject.file), 'utf8')).toBe(
      reviewProject.originalText,
    );
    const completed = await page.evaluate(
      (id) => window.astrisle!.snapshot(id),
      reviewProject.commissionId,
    );
    expect(completed.events.filter((e) => e.type === 'git_delivery_published')).toHaveLength(1);
    expect(completed.requests.find((r) => r.id === request!.id)?.status).toBe('answered');
  } finally {
    await app.close();
  }
});
