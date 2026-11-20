import { expect, test, type Page } from '@playwright/test';
import type {
  Artifact,
  PartnerDialogueInput,
  ProjectSnapshot,
} from '../../packages/contracts/src/index';

const createdAt = '2026-11-21T01:00:00Z';
const workspace = { id: 'island', name: '交付岛', sourcePath: '', workPath: 'fixture', createdAt };
const oldVersion: Artifact = {
  id: 'file-1',
  versionId: 'version-1',
  commissionId: 'first',
  taskId: 'write',
  name: 'guide.md',
  relativePath: 'guide.md',
  size: 10,
  mediaType: 'text/markdown',
  sha256: 'a'.repeat(64),
  inputVersions: [],
  validity: 'stale',
  createdAt,
};
const first: ProjectSnapshot = {
  workspace,
  commission: {
    id: 'first',
    workspaceId: workspace.id,
    title: '交付说明',
    goal: '撰写并复核说明',
    status: 'awaiting_acceptance',
    criteria: [],
    scope: {
      readRoots: [],
      writeRoots: [],
      allowProcess: false,
      allowNetwork: false,
      allowedHosts: [],
    },
    budget: { maxSteps: 10, maxMinutes: 2, maxRework: 1 },
    revision: 1,
    planningMode: 'auto',
    stepsUsed: 3,
    createdAt,
    updatedAt: createdAt,
    acceptedArtifactIds: [],
    summary: '待验收',
  },
  agents: [
    { id: 'mori', name: '旧名字', temperament: 'organizer' },
    { id: 'luma', name: 'Luma', temperament: 'explorer' },
  ],
  tasks: [
    {
      id: 'write',
      commissionId: 'first',
      title: '撰写说明',
      description: '整理交付步骤',
      status: 'passed',
      kind: 'implement',
      agentId: 'mori',
      dependencies: [],
      criterionIds: [],
      inputVersions: [],
      outputArtifactIds: ['file-2'],
      step: '完成撰写',
      attempts: 1,
      createdAt,
      updatedAt: createdAt,
    },
  ],
  artifacts: [
    oldVersion,
    { ...oldVersion, id: 'file-2', versionId: 'version-2', validity: 'current' },
  ],
  evidence: [
    {
      id: 'review-evidence',
      kind: 'review',
      summary: '检查前一版',
      detail: '前一版缺少回滚步骤。',
      status: 'failed',
      artifactVersionIds: ['version-1'],
      createdAt,
    },
  ],
  events: [],
  requests: [],
  lastSequence: 0,
};
const second: ProjectSnapshot = {
  ...first,
  commission: { ...first.commission, id: 'second', title: '另一份委托' },
  tasks: [],
  artifacts: [],
  evidence: [],
};

async function openFixture(page: Page, configured = true) {
  await page.addInitScript(
    ({ first, second, configured }) => {
      const requests: PartnerDialogueInput[] = [];
      let finishDelayedReply: () => void = () => {};
      Object.assign(window, {
        dialogueRequests: requests,
        finishDialogue: () => finishDelayedReply(),
      });
      window.astrisle = {
        bootstrap: async () => ({
          workspaces: [first.workspace],
          commissions: [first.commission, second.commission],
          characters: [
            { id: 'mori', displayName: '小满' },
            { id: 'luma', displayName: 'Luma' },
            { id: 'partner-extra', displayName: '未参与伙伴' },
            { id: 'user', displayName: '我' },
          ],
          provider: {
            configured,
            kind: 'openai-compatible',
            baseUrl: '',
            model: '',
            hasApiKey: false,
          },
          capabilities: [],
          version: 'fixture',
        }),
        snapshot: async (id: string) => (id === first.commission.id ? first : second),
        onSnapshot: () => () => {},
        artifact: async (id: string) => ({
          format: 'text',
          artifact: first.artifacts.find((entry) => entry.id === id),
          content: id === 'file-1' ? '这是旧版正文。' : '这是当前版正文。',
        }),
        askPartner: async (input: PartnerDialogueInput) => {
          requests.push(input);
          if (input.question === '慢一点回答') {
            await new Promise<void>((resolve) => {
              finishDelayedReply = resolve;
            });
            return { answer: '只属于原来委托的回复。', references: [] };
          }
          if (input.question === '哪些地方需要修改？') {
            if (requests.filter((item) => item.question === input.question).length === 1) {
              throw new Error(
                "Error invoking remote method 'astrisle:askPartner': Error: 模型未返回可核对的回答，请重试。",
              );
            }
            return { answer: '需要补充回滚步骤。', references: [] };
          }
          return {
            answer: '旧版未通过，见撰写任务和复核记录。',
            references: [
              { kind: 'commission', id: input.commissionId, label: '委托目标与进度' },
              { kind: 'task', id: 'write', label: '原撰写任务' },
              { kind: 'artifact', id: 'version-1', label: '说明第一版' },
              { kind: 'evidence', id: 'review-evidence', label: '前一版复核证据' },
            ],
          };
        },
      } as unknown as NonNullable<Window['astrisle']>;
    },
    { first, second, configured },
  );
  await page.goto('/');
  await page.getByRole('button', { name: '2D 模式', exact: true }).click();
  await selectCommission(page, '交付说明 待验收');
}

async function selectCommission(page: Page, name: string) {
  await page.getByRole('button', { name: '展开项目与委托' }).click();
  await page.getByRole('button', { name }).click();
  await page.getByRole('button', { name: '伙伴与任务', exact: true }).click();
}

test('a partner answers follow-ups and references navigate to the exact source', async ({
  page,
}) => {
  await openFixture(page);
  await expect(page.getByRole('button', { name: '与未参与伙伴对话' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '与我对话' })).toHaveCount(0);
  await page.getByRole('button', { name: '与小满对话' }).click();
  const question = page.getByRole('textbox', { name: '向小满提问' });
  await question.fill('旧版为什么没通过？');
  await question.press('Control+Enter');
  await expect(page.getByText('旧版未通过，见撰写任务和复核记录。')).toBeVisible();

  await page.getByRole('button', { name: '委托目标与进度' }).click();
  await expect(page.getByRole('complementary', { name: '目标与计划' })).toContainText(
    first.commission.goal,
  );
  await page.getByRole('button', { name: '返回对话' }).click();

  await page.getByRole('button', { name: '原撰写任务' }).click();
  await expect(page.getByRole('heading', { name: '撰写说明' })).toBeVisible();
  await expect(page.getByText('整理交付步骤')).toBeVisible();
  await page.getByRole('button', { name: '返回对话' }).click();
  await page.getByRole('button', { name: '说明第一版' }).click();
  const preview = page.getByRole('dialog', { name: 'guide.md' });
  await expect(preview).toContainText('这是旧版正文。');
  await preview.getByRole('button', { name: '关闭对话框' }).click();
  await page.getByRole('button', { name: '前一版复核证据' }).click();
  await expect(page.getByText('前一版缺少回滚步骤。')).toBeVisible();
  await expect(page.locator('summary').filter({ hasText: '检查前一版' })).toBeFocused();
  await page.getByRole('button', { name: '返回对话' }).click();

  await question.fill('哪些地方需要修改？');
  await page.getByRole('button', { name: '发送问题' }).click();
  await expect(page.getByRole('alert')).toHaveText('模型未返回可核对的回答，请重试。');
  await expect(question).toHaveValue('哪些地方需要修改？');
  await page.getByRole('button', { name: '发送问题' }).click();
  await expect(page.getByText('需要补充回滚步骤。')).toBeVisible();
  const requests = await page.evaluate(() => {
    return (window as unknown as { dialogueRequests: PartnerDialogueInput[] }).dialogueRequests;
  });
  expect(requests.slice(1)).toEqual(
    Array.from({ length: 2 }, () => ({
      commissionId: 'first',
      partnerId: 'mori',
      question: '哪些地方需要修改？',
      history: [{ question: '旧版为什么没通过？', answer: '旧版未通过，见撰写任务和复核记录。' }],
    })),
  );
});

test('an earlier preview cannot replace the version opened from a dialogue citation', async ({
  page,
}) => {
  await openFixture(page);
  await page.evaluate(() => {
    const host = window.astrisle!;
    const read = host.artifact;
    host.artifact = async (id) => {
      if (id === 'file-2')
        await new Promise<void>((resolve) => Object.assign(window, { finishPreview: resolve }));
      return read(id);
    };
  });
  await page.getByRole('button', { name: '成果与验收', exact: true }).click();
  await page.getByRole('button', { name: '预览第 2 版 guide.md' }).click();
  await page.getByRole('button', { name: '伙伴与任务', exact: true }).click();
  await page.getByRole('button', { name: '与小满对话' }).click();
  await page.getByLabel('向小满提问').fill('查看第一版');
  await page.getByRole('button', { name: '发送问题' }).click();
  await page.getByRole('button', { name: '说明第一版' }).click();
  const preview = page.getByRole('dialog', { name: 'guide.md' });
  await expect(preview).toContainText('这是旧版正文。');
  await page.evaluate(async () => {
    (window as unknown as { finishPreview: () => void }).finishPreview();
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
  });
  await expect(preview).toContainText('这是旧版正文。');
});

test('a late reply stays with its original commission and partner', async ({ page }) => {
  await openFixture(page);
  await page.getByRole('button', { name: '与小满对话' }).click();
  await page.getByRole('textbox', { name: '向小满提问' }).fill('慢一点回答');
  await page.getByRole('button', { name: '发送问题' }).click();
  await expect(page.getByRole('status').filter({ hasText: '正在等待小满回答' })).toBeVisible();
  await selectCommission(page, '另一份委托 待验收');
  await page.getByRole('button', { name: '与小满对话' }).click();
  await page.evaluate(() => (window as unknown as { finishDialogue: () => void }).finishDialogue());
  await expect(page.getByText('只属于原来委托的回复。')).toHaveCount(0);
  await selectCommission(page, '交付说明 待验收');
  await page.getByRole('button', { name: '与Luma对话' }).click();
  await expect(page.getByText('只属于原来委托的回复。')).toHaveCount(0);
  await page.getByRole('button', { name: '伙伴与任务', exact: true }).click();
  await page.getByRole('button', { name: '与小满对话' }).click();
  await expect(page.getByText('只属于原来委托的回复。')).toBeVisible();
});

test('a partner provides a route to model settings when credentials are missing', async ({
  page,
}) => {
  await openFixture(page, false);
  await page.getByRole('button', { name: '与小满对话' }).click();
  await expect(page.getByRole('button', { name: '发送问题' })).toBeDisabled();
  await page.getByRole('button', { name: '配置模型' }).click();
  await expect(page.getByRole('heading', { name: '工作室设置', exact: true })).toBeVisible();
});
