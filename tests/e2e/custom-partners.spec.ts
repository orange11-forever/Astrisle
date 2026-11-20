import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentIdentity, Artifact, Task } from '../../packages/contracts/src/index';
import { launchIsolatedElectron } from '../fixtures/electron';
import { makeGlb } from '../fixtures/character-model';

const partnerName = '小满';
const firstGoal = '请小满撰写交接说明，由 Mori 复核。';
const secondGoal = '请 Mori 撰写交接说明，由小满复核。';
const filename = 'handoff.md';
const content = '# 交接说明\n\n已核对本期工作。';

async function startPartnerProvider() {
  const failures: string[] = [];
  let rejectedSelfReview = false;
  let sequence = 0;
  const call = (name: string, args: unknown) => ({
    id: `partner-call-${++sequence}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  });
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const messages: { role: string; content: string }[] = JSON.parse(body).messages;
      const first = JSON.parse(messages.find((m) => m.role === 'user')!.content) as {
        goal: string;
        agents: AgentIdentity[];
        task?: Task;
        inputs: Artifact[];
      };
      let calls;
      if (!first.task) {
        const partner = first.agents.find((a) => a.name === partnerName)!;
        expect(first.agents.map((a) => a.id)).toEqual(['mori', 'luma', partner.id]);
        const writes = first.goal === firstGoal;
        const author = writes ? partner.id : 'mori';
        let reviewer = writes ? 'mori' : partner.id;
        if (writes) {
          // Offer a self-review once; the runtime must reject it before anybody starts work.
          rejectedSelfReview = messages.some((m) => m.content?.includes('The plan was rejected'));
          if (!rejectedSelfReview) reviewer = author;
        }
        calls = [
          call('propose_plan', {
            tasks: [
              {
                key: 'write',
                title: '撰写交接说明',
                description: '撰写并发布交接说明',
                kind: 'implement',
                agentId: author,
                criterionIds: ['c1'],
                dependencies: [],
              },
              {
                key: 'review',
                title: '核对交接说明',
                description: '回读并核对已提交版本',
                kind: 'review',
                agentId: reviewer,
                criterionIds: ['c1'],
                dependencies: ['write'],
              },
            ],
          }),
        ];
      } else if (first.task.kind === 'review') {
        const read = messages
          .filter((m) => m.role === 'tool')
          .map((m) => JSON.parse(m.content))
          .find((r) => r.evidenceId);
        calls = read
          ? [
              call('submit_review', {
                verdict: read.output === content ? 'pass' : 'changes_requested',
                summary: '已回读交接说明',
                evidenceIds: [read.evidenceId],
                versionIds: first.inputs.map((a) => a.versionId),
              }),
            ]
          : [call('workspace_read', { path: filename })];
      } else {
        calls = [
          call('workspace_write', { path: filename, content }),
          call('submit_artifact', { path: filename, name: filename, mediaType: 'text/markdown' }),
          call('complete_task', { summary: '交接说明已发布' }),
        ];
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: null, tool_calls: calls } }],
        }),
      );
    } catch (error) {
      failures.push(String(error));
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    failures,
    rejectedSelfReview: () => rejectedSelfReview,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

async function submitAndAccept(page: Page, goal: string, author: string, reviewer: string) {
  const navigation = page.getByRole('button', { name: '展开项目与委托' });
  if ((await navigation.getAttribute('aria-expanded')) !== 'true') await navigation.click();
  await page.getByRole('button', { name: '新建委托', exact: true }).first().click();
  const form = page.getByRole('dialog', { name: '新建委托' });
  await form.getByLabel('工作目标').fill(goal);
  await form.getByLabel('验收条件').fill('交接说明包含本期工作的核对结果');
  await form.getByText('权限与工作预算').click();
  await form.getByLabel('先审阅计划，再开始执行').uncheck();
  await form.getByRole('button', { name: '提交委托' }).click();
  await expect(form).toBeHidden();
  await page.getByRole('button', { name: '伙伴与任务', exact: true }).click();
  const tasks = page.getByRole('complementary', { name: '伙伴与任务' });
  await expect(tasks.getByRole('button', { name: /撰写交接说明/ })).toContainText(
    `${author} · implement`,
  );
  await expect(tasks.getByRole('button', { name: /核对交接说明/ })).toContainText(
    `${reviewer} · review`,
  );
  await page.getByRole('button', { name: '成果与验收', exact: true }).click();
  const version = page.getByRole('region', { name: `成果版本 ${filename}` });
  await expect(version).toContainText(`作者 ${author}`);
  await expect(version).toContainText(`复核人 ${reviewer}`);
  await version.getByLabel(`选择成果 ${filename}`).check();
  await page.getByRole('button', { name: '接受选中成果（1）' }).click();
  await expect(version.getByText('已接受', { exact: true })).toBeVisible();
  return page.evaluate(async (title) => {
    const host = window.astrisle!;
    const commission = (await host.bootstrap()).commissions.find((item) => item.goal === title)!;
    return host.snapshot(commission.id);
  }, goal);
}

test('a created partner keeps its model after restart and can author and independently review deliveries', async () => {
  // This journey cold-starts the packaged desktop twice and opens the isolated model inspector.
  test.setTimeout(240_000);
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, 'astrisle-partner-'));
  const source = join(root, 'partner.glb');
  await writeFile(source, makeGlb());
  const provider = await startPartnerProvider();
  let app: ElectronApplication | undefined;
  try {
    app = await launchIsolatedElectron(root);
    let page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: '2D 模式', exact: true }).click();
    await page.getByRole('button', { name: '工作室设置', exact: true }).click();
    await page.getByRole('button', { name: '添加伙伴', exact: true }).click();
    const name = page.getByLabel('伙伴名称', { exact: true });
    await name.fill(' ');
    const create = page.getByRole('button', { name: '创建伙伴', exact: true });
    await expect(create).toBeDisabled();
    await name.fill(partnerName);
    await create.click();
    const importButton = page.getByRole('button', { name: `为${partnerName}导入模型` });
    await expect(importButton).toBeFocused();
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, source);
    await importButton.click();
    const orientation = page.getByLabel(`${partnerName} 的模型朝向`);
    await orientation.selectOption('90');
    await expect(page.getByRole('status').filter({ hasText: '角色朝向已保存' })).toBeVisible();
    const profile = await page.evaluate(
      async (name) =>
        (await window.astrisle!.getCharacters!()).find((p) => p.displayName === name)!,
      partnerName,
    );
    expect(profile.model?.triangleCount).toBe(1);
    expect(profile.rotationY).toBe(90);
    await unlink(source);
    await page.evaluate(async (baseUrl) => {
      await window.astrisle!.createWorkspace({ name: '伙伴验收岛' });
      await window.astrisle!.saveProvider({
        kind: 'openai-compatible',
        baseUrl,
        model: 'local-script',
        apiKey: 'isolated-test-token',
      });
    }, provider.baseUrl);
    await app.close();
    app = await launchIsolatedElectron(root);
    page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const camera = page.getByLabel('场景视角与角色特写');
    await expect(camera.getByRole('option', { name: partnerName })).toHaveAttribute(
      'value',
      profile.id,
    );
    const canvas = page.locator('.studio-canvas canvas');
    await expect(canvas).toHaveAttribute(`data-character-${profile.id}`, profile.model!.assetId);
    await camera.selectOption(profile.id);
    await expect(page.getByRole('heading', { name: `${partnerName}的角色特写` })).toBeVisible();
    await expect(canvas).toHaveAttribute(`data-character-${profile.id}`, profile.model!.assetId);
    await page.getByRole('button', { name: '2D 模式', exact: true }).click();
    const first = await submitAndAccept(page, firstGoal, partnerName, 'Mori');
    const second = await submitAndAccept(page, secondGoal, 'Mori', partnerName);
    for (const [snapshot, author, reviewer] of [
      [first, profile.id, 'mori'],
      [second, 'mori', profile.id],
    ] as const) {
      expect(snapshot.commission.status).toBe('accepted');
      expect(snapshot.tasks.find((t) => t.id === snapshot.artifacts[0].taskId)?.agentId).toBe(
        author,
      );
      const witness = snapshot.evidence.find(
        (e) =>
          e.kind === 'review' &&
          e.status === 'passed' &&
          e.artifactVersionIds.includes(snapshot.artifacts[0].versionId),
      );
      expect(snapshot.tasks.find((t) => t.id === witness?.taskId)?.agentId).toBe(reviewer);
    }
    expect(provider.rejectedSelfReview()).toBe(true);
    expect(provider.failures).toEqual([]);
    await page.getByRole('button', { name: '工作室设置', exact: true }).click();
    await page.getByLabel(`${partnerName} 的显示名称`).fill('夏至');
    await page.getByRole('button', { name: `保存 ${partnerName} 的名称` }).click();
    await expect(page.getByLabel('夏至 的模型朝向')).toHaveValue('90');
    await page.getByRole('button', { name: '成果与验收', exact: true }).click();
    await expect(page.getByRole('region', { name: `成果版本 ${filename}` })).toContainText(
      '复核人 夏至',
    );
  } finally {
    try {
      await app?.close();
    } finally {
      await provider.close();
      if ((await realpath(root)) === root && dirname(root) === parent)
        await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});
