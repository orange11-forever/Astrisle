import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchIsolatedElectron } from '../fixtures/electron';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { publishArtifact, readArtifact } from '../../packages/artifacts/src/index';
import type { ProjectSnapshot, Task } from '../../packages/contracts/src/index';
import { RuntimeStore } from '../../packages/persistence/src/index';
import { createWorkspaceStorage } from '../../packages/workspace/src/index';

const commissionId = 'desktop-artifact-review';
const authorId = 'initial-author';
const reviewId = 'initial-review';
const file = 'draft.md';
const originalText = '# Original title\n\nOriginal draft marker.\n';
const initialText = '# Reviewed title\n\nReviewed draft marker.\n';
const revisedText = '# Revised title\n\n## Result\n\nUser requested revision marker.\n';
const instruction = '请修改标题，并保留返工内容标记。';

function officeXml(bytes: Buffer, name: string) {
  const end = bytes.lastIndexOf(Buffer.from('504b0506', 'hex'));
  expect(end).toBeGreaterThan(0);
  const count = bytes.readUInt16LE(end + 10);
  let entry = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const nameLength = bytes.readUInt16LE(entry + 28);
    const filename = bytes.toString('utf8', entry + 46, entry + 46 + nameLength);
    if (filename === name) {
      const method = bytes.readUInt16LE(entry + 10);
      const compressedSize = bytes.readUInt32LE(entry + 20);
      const local = bytes.readUInt32LE(entry + 42);
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const payload = bytes.subarray(start, start + compressedSize);
      expect([0, 8]).toContain(method);
      return (method === 8 ? inflateRawSync(payload) : payload).toString('utf8');
    }
    entry += 46 + nameLength + bytes.readUInt16LE(entry + 30) + bytes.readUInt16LE(entry + 32);
  }
  throw new Error(`Missing document entry ${name}`);
}

async function startProvider() {
  const calls: { kind: Task['kind']; instruction?: string; read?: string }[] = [];
  const failures: string[] = [];
  let nextCall = 0;
  const tool = (name: string, args: Record<string, unknown>) => ({
    id: `call-${++nextCall}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  });
  const provider = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { messages } = JSON.parse(body) as {
        messages: { role: string; content: string }[];
      };
      const { task, inputs } = JSON.parse(
        messages.find(({ role }) => role === 'user')!.content,
      ) as {
        task: Task;
        inputs: { versionId: string; relativePath: string }[];
      };
      const outputs = messages
        .filter(({ role }) => role === 'tool')
        .map(({ content }) => JSON.parse(content) as { evidenceId?: string; output?: string });
      const checked = outputs.find(({ evidenceId }) => evidenceId);
      calls.push({
        kind: task.kind,
        instruction: task.artifactRework?.instruction,
        read: checked?.output,
      });
      const response =
        task.kind === 'review'
          ? checked
            ? [
                tool('submit_review', {
                  verdict: checked.output === revisedText ? 'pass' : 'changes_requested',
                  summary: '已独立检查返工后的源稿',
                  evidenceIds: [checked.evidenceId],
                  versionIds: inputs.map(({ versionId }) => versionId),
                }),
              ]
            : [tool('workspace_read', { path: inputs[0].relativePath })]
          : [
              tool('workspace_write', { path: file, content: revisedText }),
              tool('submit_artifact', { path: file, name: file, mediaType: 'text/markdown' }),
              tool('complete_task', { summary: '已按要求修改源稿' }),
            ];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: null, tool_calls: response } }],
        }),
      );
    } catch (error) {
      failures.push(String(error));
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((ready) => provider.listen(0, '127.0.0.1', ready));
  const { port } = provider.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    failures,
    close: () =>
      new Promise<void>((done) => {
        provider.close(() => done());
        provider.closeAllConnections();
      }),
  };
}

async function seedReview(dataRoot: string) {
  const workspace = await createWorkspaceStorage({ name: '成果验收岛' }, dataRoot);
  const source = join(workspace.workPath, file);
  const publish = async (text: string) => {
    await writeFile(source, text);
    return publishArtifact(dataRoot, workspace.workPath, file, {
      commissionId,
      taskId: authorId,
      name: file,
      mediaType: 'text/markdown',
      inputVersions: [],
    });
  };
  const original = await publish(originalText);
  original.validity = 'stale';
  const current = await publish(initialText);
  current.previousVersionId = original.versionId;
  const now = new Date().toISOString();
  const author: Task = {
    id: authorId,
    commissionId,
    agentId: 'mori',
    kind: 'implement',
    title: '起草项目说明',
    description: '更新源稿并提交',
    status: 'passed',
    dependencies: [],
    criterionIds: ['c1'],
    inputVersions: [],
    outputArtifactIds: [current.id],
    step: '已提交源稿',
    attempts: 1,
    createdAt: now,
    updatedAt: now,
  };
  const reviewer: Task = {
    ...author,
    id: reviewId,
    agentId: 'luma',
    kind: 'review',
    title: '复核项目说明',
    description: '读取并核对源稿',
    dependencies: [author.id],
    inputVersions: [current.versionId],
    outputArtifactIds: [],
    step: '已复核源稿',
  };
  const snapshot: ProjectSnapshot = {
    workspace,
    agents: [],
    tasks: [author, reviewer],
    artifacts: [original, current],
    evidence: [
      {
        id: 'initial-review-evidence',
        taskId: reviewer.id,
        kind: 'review',
        summary: '初稿已经过复核',
        detail: JSON.stringify({ verdict: 'pass' }),
        status: 'passed',
        artifactVersionIds: [current.versionId],
        createdAt: now,
      },
    ],
    requests: [],
    events: [],
    lastSequence: 0,
    commission: {
      id: commissionId,
      workspaceId: workspace.id,
      title: '项目说明验收',
      goal: '提交经过复核的项目说明',
      criteria: [{ id: 'c1', description: '项目说明符合本轮要求' }],
      status: 'awaiting_acceptance',
      scope: {
        readRoots: [],
        writeRoots: [],
        allowProcess: false,
        allowNetwork: false,
        allowedHosts: [],
      },
      budget: { maxSteps: 30, maxMinutes: 2, maxRework: 2 },
      revision: 1,
      planningMode: 'auto',
      stepsUsed: 0,
      acceptedArtifactIds: [],
      summary: '等候验收',
      createdAt: now,
      updatedAt: now,
    },
  };
  const store = new RuntimeStore(dataRoot);
  try {
    store.addWorkspace(workspace);
    store.save(snapshot);
  } finally {
    store.close();
  }
  return { original, current };
}

test('production Electron reviews immutable versions, reworks a selected draft and saves real native exports', async ({}, testInfo) => {
  test.setTimeout(95_000);
  const output = testInfo.outputPath();
  await mkdir(output, { recursive: true });
  const root = await realpath(await mkdtemp(join(output, 'isolated-')));
  const dataRoot = join(root, 'runtime');
  const exported = join(root, 'exports');
  const docx = join(exported, 'first.docx');
  const pptx = join(exported, 'reworked.pptx');
  await mkdir(exported);
  const { original, current } = await seedReview(dataRoot);
  const provider = await startProvider();
  let app: ElectronApplication | undefined;
  try {
    app = await launchIsolatedElectron(dataRoot);
    await app.evaluate(
      ({ dialog }, targets) => {
        let index = 0;
        dialog.showSaveDialog = async () => {
          const target = targets[index++];
          return target ? { canceled: false, filePath: target } : { canceled: true, filePath: '' };
        };
      },
      [null, docx, pptx],
    );
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 940 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForFunction(() => !!window.astrisle);
    await page.evaluate(
      (baseUrl) =>
        window.astrisle!.saveProvider({
          kind: 'openai-compatible',
          baseUrl,
          model: 'scripted-loopback',
          apiKey: 'isolated-test-token',
        }),
      provider.baseUrl,
    );
    await page.getByRole('button', { name: '2D 模式', exact: true }).click();
    await page.getByRole('button', { name: '展开项目与委托' }).click();
    await page.getByRole('button', { name: '项目说明验收 待验收' }).click();
    await page.getByRole('button', { name: '成果与验收', exact: true }).click();

    const group = page.getByRole('region', { name: `成果版本 ${file}` });
    await expect(group).toContainText('初稿已经过复核');
    await group.getByText('版本历史（2）', { exact: true }).click();
    await group.getByRole('button', { name: `预览第 1 版 ${file}` }).click();
    const preview = page.getByRole('dialog', { name: file });
    await expect(preview).toContainText(originalText.trim().replaceAll('\n\n', ' '));
    await preview.getByRole('button', { name: '关闭对话框' }).click();
    await group.getByRole('button', { name: '对比版本', exact: true }).click();
    await group.getByRole('button', { name: '查看差异' }).click();
    const diff = group.getByRole('region', { name: '版本差异' });
    await expect(diff).toContainText('Original draft marker.');
    await expect(diff).toContainText('Reviewed draft marker.');

    await group.getByRole('button', { name: '发起返工' }).click();
    await group.getByLabel('返工要求').fill(instruction);
    await group.getByRole('button', { name: '提交返工' }).click();
    await expect(group).toContainText('返工已提交');
    await expect(group).toContainText('已独立检查返工后的源稿', { timeout: 30_000 });
    const reviewed = await page.evaluate((id) => window.astrisle!.snapshot(id), commissionId);
    const replacement = reviewed.artifacts.find((artifact) => artifact.validity === 'current')!;
    expect(replacement.previousVersionId).toBe(current.versionId);
    expect(replacement.taskId).not.toBe(authorId);
    const witness = reviewed.evidence.find(
      ({ artifactVersionIds, kind, status }) =>
        kind === 'review' &&
        status === 'passed' &&
        artifactVersionIds.includes(replacement.versionId),
    );
    expect(witness?.taskId).toBeTruthy();
    expect(witness?.taskId).not.toBe(reviewId);
    expect(reviewed.tasks.find(({ id }) => id === witness?.taskId)?.agentId).toBe('luma');

    await group.getByRole('button', { name: '对比版本', exact: true }).click();
    await group.getByLabel('基准版本').selectOption(original.versionId);
    await expect(group.getByLabel('对比版本')).toHaveValue(replacement.versionId);
    await group.getByRole('button', { name: '查看差异' }).click();
    await expect(diff).toContainText('Original draft marker.');
    await expect(diff).toContainText('User requested revision marker.');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.screenshot({ path: testInfo.outputPath('artifact-version-diff-narrow.png') });
    await page.setViewportSize({ width: 1440, height: 940 });

    await group.getByRole('button', { name: `预览第 1 版 ${file}` }).click();
    await preview.getByRole('button', { name: '生成 Word' }).click();
    await expect(preview).toContainText('已取消保存');
    expect(await readdir(exported)).toEqual([]);
    await preview.getByRole('button', { name: '生成 Word' }).click();
    await expect(preview).toContainText('已生成', { timeout: 30_000 });
    const firstXml = officeXml(await readFile(docx), 'word/document.xml');
    expect(firstXml).toContain('Original draft marker.');
    expect(firstXml).not.toContain('User requested revision marker.');
    await preview.getByRole('button', { name: '关闭对话框' }).click();
    await group.getByRole('button', { name: `预览第 3 版 ${file}` }).click();
    await preview.getByRole('button', { name: '生成 PPTX' }).click();
    await expect(preview).toContainText('已生成', { timeout: 30_000 });
    const revisedDeck = await readFile(pptx);
    expect(officeXml(revisedDeck, 'ppt/slides/slide1.xml')).toContain('Revised title');
    const revisedXml = officeXml(revisedDeck, 'ppt/slides/slide2.xml');
    expect(revisedXml).toContain('User requested revision marker.');
    expect(revisedXml).not.toContain('Original draft marker.');

    expect(provider.failures).toEqual([]);
    expect(provider.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'implement', instruction }),
        expect.objectContaining({ kind: 'review', read: revisedText }),
      ]),
    );
    expect(errors).toEqual([]);
    await app.close();
    app = undefined;
    const persisted = new RuntimeStore(dataRoot);
    try {
      const stored = persisted.get(commissionId);
      expect(stored.commission.status).toBe('awaiting_acceptance');
      expect(stored.evidence.find(({ id }) => id === witness?.id)?.status).toBe('passed');
      expect(stored.artifacts.map((artifact) => artifact.validity)).toEqual([
        'stale',
        'stale',
        'current',
      ]);
      expect((await readArtifact(dataRoot, original)).toString('utf8')).toBe(originalText);
      expect((await readArtifact(dataRoot, replacement)).toString('utf8')).toBe(revisedText);
    } finally {
      persisted.close();
    }
  } finally {
    await app?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
});
