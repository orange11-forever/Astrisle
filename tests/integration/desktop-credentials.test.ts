import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore } from '../../apps/desktop/src/credentials';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
describe('OS-backed credential persistence', () => {
  it('stores encrypted keys and preserves keys only for the same endpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'astrisle-vault-'));
    dirs.push(dir);
    const store = new CredentialStore(join(dir, 'provider.json'), {
      available: () => true,
      encrypt: (value) => Buffer.from(value.split('').reverse().join('')),
      decrypt: (value) => value.toString().split('').reverse().join(''),
    });
    await store.save({
      kind: 'openai-compatible',
      baseUrl: 'https://one.example/v1',
      model: 'one',
      apiKey: 'secret-key-xyz',
    });
    expect(await readFile(join(dir, 'provider.json'), 'utf8')).not.toContain('secret-key-xyz');
    expect((await store.publicSettings()).hasApiKey).toBe(true);
    expect(
      (
        await store.save({
          kind: 'openai-compatible',
          baseUrl: 'https://one.example/v1',
          model: 'two',
        })
      ).hasApiKey,
    ).toBe(true);
    expect(
      (await store.save({ kind: 'anthropic', baseUrl: 'https://two.example', model: 'three' }))
        .hasApiKey,
    ).toBe(false);
  });
  it('refuses saving a secret without system encryption', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'astrisle-vault-'));
    dirs.push(dir);
    const store = new CredentialStore(join(dir, 'provider.json'), {
      available: () => false,
      encrypt: () => {
        throw Error('unavailable');
      },
      decrypt: () => {
        throw Error('unavailable');
      },
    });
    await expect(
      store.save({
        kind: 'openai-compatible',
        baseUrl: 'https://example.com',
        model: 'm',
        apiKey: 'secret',
      }),
    ).rejects.toThrow(/加密/);
  });
});
