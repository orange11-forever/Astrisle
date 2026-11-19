import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { humanoidGlb } from '../fixtures/island-life';

test('waits for saved desktop profiles and reports the asset that actually renders after a retry', async ({
  page,
}) => {
  const bytes = humanoidGlb();
  const assetId = createHash('sha256').update(bytes).digest('hex');
  await page.addInitScript(
    ({ data, assetId }) => {
      let ready = false;
      const initialRead = new Promise<void>((resolve) => {
        window.addEventListener('fixture-read-failed', () => resolve(), { once: true });
      });
      window.addEventListener(
        'fixture-data-ready',
        () => {
          ready = true;
        },
        { once: true },
      );
      window.astrisle = {
        bootstrap: async () => {
          if (!ready) {
            await initialRead;
            throw new Error('角色配置暂时不可读');
          }
          return {
            workspaces: [],
            commissions: [],
            capabilities: [],
            version: 'fixture',
            provider: {
              kind: 'openai-compatible',
              baseUrl: '',
              model: '',
              hasApiKey: false,
              configured: false,
            },
            characters: [
              {
                id: 'mori',
                displayName: 'Mori',
                model: {
                  assetId,
                  filename: 'configured.glb',
                  format: 'glb',
                  byteLength: data.length,
                  triangleCount: 84,
                  animationCount: 0,
                  hasSkins: false,
                },
              },
              { id: 'luma', displayName: 'Luma' },
              { id: 'user', displayName: '我' },
            ],
          };
        },
        loadCharacterModel: async (requested: string) => {
          if (requested !== assetId) throw new Error('Wrong model requested');
          return Uint8Array.from(data);
        },
        onSnapshot: () => () => {},
      } satisfies Partial<NonNullable<Window['astrisle']>> as unknown as NonNullable<
        Window['astrisle']
      >;
    },
    { data: [...bytes], assetId },
  );
  await page.goto('/');
  await expect(page.getByText('正在读取工作室和角色配置…')).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('fixture-read-failed')));
  await expect(page.getByText('工作室加载失败：角色配置暂时不可读')).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('fixture-data-ready')));
  await page.getByRole('button', { name: '重新加载' }).click();
  const canvas = page.locator('.studio-canvas canvas');
  await expect(canvas).toHaveAttribute('data-character-mori', assetId);
  await expect(canvas).toHaveAttribute('data-character-luma', 'builtin');
});
