import { extname } from 'node:path';
import { z } from 'zod';
import type { ProviderInput } from '@astrisle/contracts';

const providerSchema = z
  .object({
    kind: z.enum(['openai-compatible', 'openai-responses', 'anthropic', 'gemini']),
    baseUrl: z.string().trim().min(1).max(2048),
    model: z.string().trim().min(1, '请填写模型名称').max(200),
    apiKey: z.string().max(8192).optional(),
  })
  .strict();

export function validateProvider(input: unknown): ProviderInput {
  const value = providerSchema.parse(input);
  const url = new URL(value.baseUrl);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    throw new Error('模型地址必须使用 HTTPS，本机模型可使用 HTTP');
  if (url.username || url.password || url.search || url.hash)
    throw new Error('模型地址不能包含凭据、查询参数或片段');
  return { ...value, baseUrl: value.baseUrl.replace(/\/+$/, '') };
}

export function isTrustedSender(actual: string, expected: string, mainFrame: boolean): boolean {
  if (!mainFrame) return false;
  try {
    const a = new URL(actual);
    const b = new URL(expected);
    a.hash = '';
    b.hash = '';
    return a.href === b.href;
  } catch {
    return false;
  }
}

export function canOpenExternally(path: string): boolean {
  return new Set([
    '.docx',
    '.xlsx',
    '.pptx',
    '.pdf',
    '.txt',
    '.md',
    '.csv',
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
  ]).has(extname(path).toLowerCase());
}
