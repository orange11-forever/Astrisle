import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CharacterStore } from '../../apps/desktop/src/characters';
import { agentsFromCharacters } from '../../packages/domain/src/index';
import { RuntimeStore } from '../../packages/persistence/src/index';
import { launchIsolatedElectron } from '../fixtures/electron';
import { reviewProject, seedReview } from '../fixtures/review-project';

const partnerName = '小满';
const reason = '第一版缺少验收日期';

async function conversationProvider() {
  const turns: { partner: string; question: string; history: number }[] = [];
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      if (request.tools?.length) throw new Error('Dialogue requested task tools');
      const prompt = JSON.parse(
        request.messages.find((m: { role: string }) => m.role === 'user').content,
      );
      type Source = {
        key: string;
        kind: string;
        taskKind?: string;
        validity?: string;
        summary?: string;
      };
      const sources: Source[] = prompt.sources;
      const author = prompt.partner.name === partnerName;
      const followUp = prompt.history.length > 0;
      const selected =
        author && !followUp
          ? sources.find((s) => s.taskKind === 'implement')
          : author
            ? sources.find((s) => s.kind === 'artifact' && s.validity === 'stale')
            : sources.find((s) => s.kind === 'evidence' && s.summary === reason);
      if (!selected) throw new Error('Required commission record missing');
      turns.push({
        partner: prompt.partner.name,
        question: prompt.question,
        history: prompt.history.length,
      });
      const answer = author
        ? followUp
          ? '这是当时提交的第一版。'
          : '我负责起草项目说明。'
        : `我要求修改，因为${reason}。`;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({ answer, sources: [selected.key] }),
              },
            },
          ],
        }),
      );
    } catch {
      res.writeHead(400).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  return {
    turns,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

async function ask(page: Page, partner: string, question: string, answer: string) {
  await page.getByLabel(`向${partner}提问`, { exact: true }).fill(question);
  await page.getByRole('button', { name: '发送问题', exact: true }).click();
  await expect(page.getByText(answer, { exact: true })).toBeVisible();
}

test('desktop partners answer from current commission records and open the precise task, version and review', async () => {
  test.setTimeout(150_000);
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, 'astrisle-talk-'));
  const provider = await conversationProvider();
  let app: ElectronApplication | undefined;
  try {
    const { original } = await seedReview(root);
    const profiles = new CharacterStore(root);
    const partner = await profiles.create(partnerName);
    const store = new RuntimeStore(root);
    try {
      const snapshot = store.get(reviewProject.commissionId);
      snapshot.agents = agentsFromCharacters(await profiles.profiles());
      snapshot.tasks.find((t) => t.id === reviewProject.authorId)!.agentId = partner.id;
      snapshot.evidence.unshift({
        id: 'original-review',
        kind: 'review',
        taskId: reviewProject.reviewId,
        summary: reason,
        detail: '补充日期后重新提交。',
        status: 'failed',
        artifactVersionIds: [original.versionId],
        createdAt: original.createdAt,
      });
      store.save(snapshot);
    } finally {
      store.close();
    }
    app = await launchIsolatedElectron(root);
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: '工作室设置', exact: true }).click();
    await page.getByLabel('API 基础地址').fill(provider.baseUrl);
    await page.getByLabel('模型名称', { exact: true }).fill('dialogue-fixture');
    await page.getByLabel('API 密钥', { exact: true }).fill('isolated-test-token');
    await page.getByRole('button', { name: '保存设置' }).click();
    await expect(page.getByText('当前模型　dialogue-fixture')).toBeVisible();
    await page.getByRole('button', { name: '展开项目与委托' }).click();
    await page.getByRole('button', { name: '项目说明验收 待验收' }).click();
    const before = await page.evaluate(
      (id) => window.astrisle!.snapshot(id),
      reviewProject.commissionId,
    );
    const nameplate = page.locator(`button.scene-label[data-character-id="${partner.id}"]`);
    // The nameplate renders before the selected commission has supplied its participant list.
    await expect(nameplate).toHaveAttribute('title', `与${partnerName}对话`);
    await nameplate.press('Enter');
    await expect(page.getByRole('heading', { name: `与${partnerName}对话` })).toBeVisible();
    await ask(page, partnerName, '这份委托中你做了什么？', '我负责起草项目说明。');
    await page.getByRole('button', { name: '起草项目说明', exact: true }).click();
    await expect(page.locator('.task-detail')).toContainText('更新源稿并提交');
    await page.getByRole('button', { name: '返回对话' }).click();
    await ask(page, partnerName, '能给我看当时的第一版吗？', '这是当时提交的第一版。');
    await page.getByRole('button', { name: /draft\.md.*第 1 版/ }).click();
    const preview = page.getByRole('dialog', { name: reviewProject.file });
    await expect(preview).toContainText('Original draft marker.');
    await preview.getByRole('button', { name: '关闭对话框' }).click();

    await page
      .getByRole('complementary', { name: `与${partnerName}对话` })
      .getByRole('button', { name: '收起工作面板' })
      .click();
    await page.getByRole('button', { name: '2D 模式', exact: true }).click();
    await page.getByRole('button', { name: '伙伴与任务', exact: true }).click();
    await page.getByRole('button', { name: '与Luma对话', exact: true }).click();
    await expect(page.getByText('我负责起草项目说明。', { exact: true })).toHaveCount(0);
    await ask(page, 'Luma', '你为什么要求修改第一版？', `我要求修改，因为${reason}。`);
    await page.getByRole('button', { name: reason, exact: true }).click();
    await expect(page.locator('details.evidence[open]')).toContainText('补充日期后重新提交。');
    expect(provider.turns.map(({ partner, history }) => [partner, history])).toEqual([
      [partnerName, 0],
      [partnerName, 1],
      ['Luma', 0],
    ]);
    const after = await page.evaluate(
      (id) => window.astrisle!.snapshot(id),
      reviewProject.commissionId,
    );
    expect(after).toEqual(before);
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
