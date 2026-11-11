import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProviderInput, ProviderSettings } from '@astrisle/contracts';
import { validateProvider } from './security';

export interface SystemEncryption {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
interface StoredProvider {
  version: 1;
  kind: ProviderInput['kind'];
  baseUrl: string;
  model: string;
  encryptedKey?: string;
}

export class CredentialStore {
  constructor(
    private readonly path: string,
    private readonly encryption: SystemEncryption,
  ) {}
  private async read(): Promise<StoredProvider | null> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as StoredProvider;
      if (value.version !== 1) throw new Error('不支持的模型配置版本');
      validateProvider({ kind: value.kind, baseUrl: value.baseUrl, model: value.model });
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async credentials(): Promise<(ProviderInput & { apiKey: string }) | null> {
    const stored = await this.read();
    if (!stored) return null;
    if (stored.encryptedKey && !this.encryption.available())
      throw new Error('系统凭据加密暂不可用，请稍后重试');
    const apiKey = stored.encryptedKey
      ? this.encryption.decrypt(Buffer.from(stored.encryptedKey, 'base64'))
      : '';
    return { kind: stored.kind, baseUrl: stored.baseUrl, model: stored.model, apiKey };
  }
  async publicSettings(): Promise<ProviderSettings> {
    const stored = await this.read();
    if (!stored)
      return {
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        model: '',
        hasApiKey: false,
        configured: false,
      };
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(stored.baseUrl).hostname);
    return {
      kind: stored.kind,
      baseUrl: stored.baseUrl,
      model: stored.model,
      hasApiKey: !!stored.encryptedKey,
      configured: !!stored.model && (!!stored.encryptedKey || local),
    };
  }
  async save(input: unknown): Promise<ProviderSettings> {
    const parsed = validateProvider(input);
    const old = await this.read();
    let encryptedKey =
      old?.kind === parsed.kind && old.baseUrl === parsed.baseUrl ? old.encryptedKey : undefined;
    if (parsed.apiKey !== undefined) {
      if (parsed.apiKey && !this.encryption.available())
        throw new Error('系统加密不可用，无法安全保存 API 密钥');
      encryptedKey = parsed.apiKey
        ? this.encryption.encrypt(parsed.apiKey).toString('base64')
        : undefined;
    }
    const stored: StoredProvider = {
      version: 1,
      kind: parsed.kind,
      baseUrl: parsed.baseUrl,
      model: parsed.model,
      encryptedKey,
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.path);
    return this.publicSettings();
  }
}
