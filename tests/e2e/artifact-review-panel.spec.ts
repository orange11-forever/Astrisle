import { expect, test, type Page } from '@playwright/test';
import type {
  Artifact,
  ArtifactReworkInput,
  ProjectSnapshot,
} from '../../packages/contracts/src/index';

const createdAt = '2026-11-19T01:00:00Z';
const workspace = {
  id: 'version-case-workspace',
  name: '版本岛',
  sourcePath: '',
  workPath: 'fixture/source',
  createdAt,
};
const original: Artifact = {
  id: 'module-1',
  versionId: 'module-version-1',
  commissionId: 'version-case',
  taskId: 'author',
  name: 'module.ts',
  relativePath: 'src/module.ts',
  mediaType: 'text/typescript',
  sha256: 'a'.repeat(64),
  size: 17,
  createdAt,
  inputVersions: [],
  validity: 'stale',
};
const current: Artifact = {
  ...original,
  id: 'module-2',
  versionId: 'module-version-2',
  previousVersionId: original.versionId,
  sha256: 'b'.repeat(64),
  size: 24,
  validity: 'current',
};
const binary: Artifact[] = [original, current].map((artifact, i) => ({
  ...artifact,
  id: 'image-' + (i + 1),
  versionId: 'image-version-' + (i + 1),
  previousVersionId: i ? 'image-version-1' : undefined,
  name: 'cover.png',
  relativePath: 'assets/cover.png',
  mediaType: 'image/png',
  sha256: (i ? 'd' : 'c').repeat(64),
  size: 250 + i,
}));
const markdown: Artifact[] = [original, current].map((artifact, index) => ({
  ...artifact,
  id: 'guide-' + (index + 1),
  versionId: 'guide-version-' + (index + 1),
  previousVersionId: index ? 'guide-version-1' : undefined,
  relativePath: 'docs/guide.md',
  name: 'guide.md',
  mediaType: 'text/markdown',
}));
const table: Artifact = {
  ...current,
  id: 'table',
  versionId: 'table-version-1',
  previousVersionId: undefined,
  relativePath: 'data.csv',
  name: 'data.csv',
  mediaType: 'text/csv',
};
const rendered: Artifact = {
  ...current,
  id: 'generated-guide',
  versionId: 'generated-guide-version-1',
  previousVersionId: undefined,
  renderedFromVersionId: markdown[0].versionId,
  relativePath: 'docs/guide.docx',
  name: 'guide.docx',
  mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const snapshot: ProjectSnapshot = {
  commission: {
    id: original.commissionId,
    workspaceId: workspace.id,
    title: '成果版本验证',
    goal: '修订项目模块',
    status: 'awaiting_acceptance',
    criteria: [{ id: 'criterion', description: '更新模块' }],
    scope: {
      readRoots: [],
      writeRoots: [],
      allowProcess: false,
      allowNetwork: false,
      allowedHosts: [],
    },
    budget: { maxSteps: 20, maxMinutes: 3, maxRework: 2 },
    revision: 4,
    planningMode: 'auto',
    stepsUsed: 3,
    createdAt,
    updatedAt: createdAt,
    acceptedArtifactIds: [],
    summary: '可验收',
  },
  workspace,
  agents: [],
  tasks: [
    {
      id: original.taskId,
      commissionId: original.commissionId,
      title: '更新并提交成果',
      description: '',
      kind: 'implement',
      agentId: 'author-agent',
      status: 'passed',
      dependencies: [],
      criterionIds: ['criterion'],
      inputVersions: [],
      outputArtifactIds: [current.id],
      step: '',
      attempts: 1,
      createdAt,
      updatedAt: createdAt,
    },
  ],
  artifacts: [original, current, ...binary, ...markdown, table, rendered],
  events: [],
  requests: [],
  evidence: [
    {
      id: 'tool',
      kind: 'tool',
      summary: '读取已锁定的模块',
      detail: '{}',
      status: 'passed',
      artifactVersionIds: [current.versionId],
      createdAt,
    },
    {
      id: 'current-review',
      kind: 'review',
      summary: '检查了模块的当前版本',
      detail: JSON.stringify({ verdict: 'pass', evidenceIds: ['tool'] }),
      status: 'passed',
      artifactVersionIds: [current.versionId],
      createdAt,
    },
    {
      id: 'original-review',
      kind: 'review',
      summary: '旧版缺少错误处理',
      detail: '{}',
      status: 'failed',
      artifactVersionIds: [original.versionId],
      createdAt,
    },
  ],
  lastSequence: 0,
};

async function openArtifactPanel(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(
    ({ snapshot, original }) => {
      const received: ArtifactReworkInput[] = [];
      const exports: { commissionId: string; versionId: string; format: string }[] = [];
      Object.assign(window, { receivedRework: received, receivedExports: exports });
      window.astrisle = {
        bootstrap: async () => ({
          workspaces: [snapshot.workspace],
          commissions: [snapshot.commission],
          capabilities: [],
          version: 'fixture',
        }),
        onSnapshot: () => () => {},
        snapshot: async () => snapshot,
        artifact: async (id: string) => ({
          format: 'text',
          artifact: snapshot.artifacts.find((artifact) => artifact.id === id),
          content: id === original.id ? 'export const oldValue = 1;' : 'export const newValue = 2;',
        }),
        compareArtifacts: async ({
          fromVersionId,
          toVersionId,
        }: {
          fromVersionId: string;
          toVersionId: string;
        }) => {
          const from = snapshot.artifacts.find((artifact) => artifact.versionId === fromVersionId)!;
          const to = snapshot.artifacts.find((artifact) => artifact.versionId === toVersionId)!;
          return {
            from,
            to,
            kind: from.mediaType === 'image/png' ? 'binary' : 'text',
            truncated: from.mediaType !== 'image/png',
            reason: from.mediaType === 'image/png' ? undefined : 'output-limit',
            hunks:
              from.mediaType === 'image/png'
                ? []
                : [
                    {
                      lines: [
                        { kind: 'deletion', oldLine: 1, text: 'export const oldValue = 1;' },
                        { kind: 'addition', newLine: 1, text: 'export const newValue = 2;' },
                        { kind: 'context', oldLine: 2, newLine: 2, text: 'unbroken'.repeat(90) },
                      ],
                    },
                  ],
          };
        },
        exportSourceArtifact: async (input: {
          commissionId: string;
          versionId: string;
          format: string;
        }) => {
          exports.push(input);
          if (exports.length === 1) return { ok: false, code: 'cancelled', message: '已取消保存' };
          return { ok: true, message: '已保存生成的文档' };
        },
        requestArtifactRework: async (input: ArtifactReworkInput) => {
          received.push(input);
          const code = ['budget_exhausted', 'request_pending', 'invalid_artifact', 'path_conflict'][
            received.length - 1
          ];
          if (code) return { ok: false, code, message: code };
          return { ok: true, message: 'queued', commissionId: snapshot.commission.id };
        },
      } as unknown as NonNullable<Window['astrisle']>;
    },
    { snapshot, original },
  );
  await page.goto('/');
  await page.getByRole('button', { name: '2D 模式', exact: true }).click();
  await page.getByRole('button', { name: '展开项目与委托' }).click();
  await page.getByRole('button', { name: '成果版本验证 待验收' }).click();
  await page.getByRole('button', { name: '成果与验收', exact: true }).click();
}

test('reviews exact historical versions and keeps long text diffs within the narrow workbench', async ({
  page,
}) => {
  await openArtifactPanel(page);
  const group = page.getByRole('region', { name: '成果版本 src/module.ts' });
  await expect(group.getByText('当前版本', { exact: true })).toBeVisible();
  await expect(group.getByText('复核通过', { exact: true })).toBeVisible();
  await expect(group.getByText('检查了模块的当前版本')).toBeVisible();
  await group.getByText('复核证据', { exact: true }).filter({ visible: true }).click();
  await expect(group.getByText('读取已锁定的模块')).toBeVisible();
  await group.getByText('版本历史（2）', { exact: true }).click();
  await expect(group.getByText('旧版缺少错误处理')).toBeVisible();
  await group.getByRole('button', { name: '预览第 1 版 module.ts' }).click();
  const preview = page.getByRole('dialog', { name: 'module.ts' });
  await expect(preview).toContainText('export const oldValue = 1;');
  await expect(preview.getByRole('button', { name: '生成 Word' })).toHaveCount(0);
  await preview.getByRole('button', { name: '关闭对话框' }).click();
  await group.getByRole('button', { name: '对比版本', exact: true }).click();
  await expect(group.getByLabel('基准版本')).toHaveValue(original.versionId);
  await expect(group.getByLabel('对比版本', { exact: true })).toHaveValue(current.versionId);
  await group.getByRole('button', { name: '查看差异' }).click();
  const diff = group.getByRole('region', { name: '版本差异' });
  await expect(diff).toContainText('-');
  await expect(diff).toContainText('export const oldValue = 1;');
  await expect(diff).toContainText('+');
  await expect(diff).toContainText('export const newValue = 2;');
  await expect(diff).toContainText('仅显示部分差异');
  await group.getByLabel('基准版本').selectOption(current.versionId);
  await expect(group.getByRole('button', { name: '查看差异' })).toBeDisabled();
  await expect(diff).toHaveCount(0);
  await group.getByLabel('对比版本', { exact: true }).selectOption(original.versionId);
  await page.setViewportSize({ width: 390, height: 844 });
  await group.getByRole('button', { name: '查看差异' }).click();
  await expect(diff).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('compares binary metadata and retries directed rework without losing its input', async ({
  page,
}) => {
  await openArtifactPanel(page);
  const imageGroup = page.getByRole('region', { name: '成果版本 assets/cover.png' });
  await imageGroup.getByRole('button', { name: '对比版本', exact: true }).click();
  await imageGroup.getByRole('button', { name: '查看差异' }).click();
  const binaryResult = imageGroup.getByRole('region', { name: '版本差异' });
  await expect(binaryResult.getByText('image/png', { exact: true })).toHaveCount(2);
  await expect(binaryResult).toContainText('250 字节');
  await expect(binaryResult).toContainText('251 字节');
  const group = page.getByRole('region', { name: '成果版本 src/module.ts' });
  await group.getByRole('button', { name: '发起返工' }).click();
  const instruction = group.getByLabel('返工要求');
  await expect(instruction).toBeFocused();
  await expect(group.getByRole('button', { name: '提交返工' })).toBeDisabled();
  await instruction.fill('请为新模块补充参数检查。');
  for (const message of ['预算', '输入与审批', '文件可预览', '同一文件路径']) {
    await group.getByRole('button', { name: '提交返工' }).click();
    await expect(group.getByRole('alert')).toContainText(message, { timeout: 3000 });
    await expect(instruction).toHaveValue('请为新模块补充参数检查。');
  }
  await group.getByRole('button', { name: '提交返工' }).click();
  await expect(group).toContainText('返工已提交');
  await expect(instruction).toHaveCount(0);
  const requests = await page.evaluate(
    () => (window as unknown as { receivedRework: ArtifactReworkInput[] }).receivedRework,
  );
  expect(requests).toHaveLength(5);
  expect(requests[0]).toMatchObject({
    commissionId: snapshot.commission.id,
    artifactId: current.id,
    versionId: current.versionId,
    revision: snapshot.commission.revision,
    instruction: '请为新模块补充参数检查。',
  });
  expect(requests[0].requestId).toBeTruthy();
  expect(requests.every((request) => request.requestId === requests[0].requestId)).toBe(true);
});

test('generates only supported document formats from the open immutable source version', async ({
  page,
}) => {
  await openArtifactPanel(page);
  const guide = page.getByRole('region', { name: '成果版本 docs/guide.md' });
  await guide.getByText('版本历史（2）', { exact: true }).click();
  await guide.getByRole('button', { name: '预览第 1 版 guide.md' }).click();
  const preview = page.getByRole('dialog', { name: 'guide.md' });
  await expect(preview.getByRole('button', { name: '生成 XLSX' })).toHaveCount(0);
  await preview.getByRole('button', { name: '生成 Word' }).click();
  await expect(preview).toContainText('已取消保存');
  await preview.getByRole('button', { name: '生成 PPTX' }).click();
  await expect(preview).toContainText('已保存生成的文档');
  await preview.getByRole('button', { name: '关闭对话框' }).click();

  await expect(guide.getByRole('button', { name: '预览第 1 版 guide.md' })).toBeVisible();
  const table = page.getByRole('region', { name: '成果版本 data.csv' });
  await table.getByRole('button', { name: '预览第 1 版 data.csv' }).click();
  const sheet = page.getByRole('dialog', { name: 'data.csv' });
  await expect(sheet.getByRole('button', { name: '生成 Word' })).toHaveCount(0);
  await sheet.getByRole('button', { name: '生成 XLSX' }).click();
  await expect(sheet).toContainText('已保存生成的文档');

  const requests = await page.evaluate(
    () => (window as unknown as { receivedExports: unknown[] }).receivedExports,
  );
  expect(requests).toEqual([
    { commissionId: snapshot.commission.id, versionId: markdown[0].versionId, format: 'docx' },
    { commissionId: snapshot.commission.id, versionId: markdown[0].versionId, format: 'pptx' },
    { commissionId: snapshot.commission.id, versionId: 'table-version-1', format: 'xlsx' },
  ]);
});

test('generated deliverables lead back to the exact source preview and its rework actions', async ({
  page,
}) => {
  await openArtifactPanel(page);
  const generated = page.getByRole('region', { name: '成果版本 docs/guide.docx' });
  await expect(generated.getByRole('button', { name: '发起返工' })).toHaveCount(0);
  await generated.getByRole('button', { name: '预览源版本 docs/guide.md' }).click();
  const preview = page.getByRole('dialog', { name: 'guide.md' });
  await expect(preview).toContainText('历史版本');
  await preview.getByRole('button', { name: '关闭对话框' }).click();

  await generated.getByRole('button', { name: '转到源成果返工' }).click();
  const source = page.getByRole('region', { name: '成果版本 docs/guide.md', exact: true });
  await expect(source).toBeFocused();
  await source.getByRole('button', { name: '发起返工' }).click();
  await expect(source.getByLabel('返工要求')).toBeFocused();
});
