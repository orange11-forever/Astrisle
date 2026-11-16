import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { ProviderInput } from '../../packages/contracts/src/index';
import { validateEndpoint } from '../../packages/runtime/src/provider';

export function parseAcceptanceArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      list: { type: 'boolean' },
      check: { type: 'boolean' },
      scenario: { type: 'string' },
      'scenario-file': { type: 'string' },
      repeat: { type: 'string' },
      output: { type: 'string' },
      'allow-process': { type: 'boolean' },
      'key-stdin': { type: 'boolean' },
      'max-steps': { type: 'string' },
      'timeout-seconds': { type: 'string' },
    },
  });
  if (values.scenario && values['scenario-file'])
    throw new Error('Choose either --scenario or --scenario-file');
  function integer(value: string | undefined, fallback: number, maximum: number) {
    if (value !== undefined && !/^[1-9]\d*$/.test(value))
      throw new Error('Expected a positive integer');
    const result = value === undefined ? fallback : Number(value);
    if (result > maximum) throw new Error(`Value exceeds ${maximum}`);
    return result;
  }
  return {
    list: values.list ?? false,
    check: values.check ?? false,
    scenario: values.scenario ?? 'code-new',
    scenarioFile: values['scenario-file'],
    repeat: integer(values.repeat, 1, 10),
    output: values.output ?? '.astrisle-acceptance',
    allowProcess: values['allow-process'] ?? false,
    keyStdin: values['key-stdin'] ?? false,
    maxSteps: integer(values['max-steps'], 40, 200),
    timeoutMs: integer(values['timeout-seconds'], 300, 1800) * 1000,
  };
}
export function providerFromEnvironment(
  env: Record<string, string | undefined>,
): (ProviderInput & { apiKey: string }) | null {
  const baseUrl = env.ASTRISLE_PROVIDER_URL;
  const model = env.ASTRISLE_PROVIDER_MODEL;
  if (!baseUrl && !model && !env.ASTRISLE_PROVIDER_KIND && !env.ASTRISLE_PROVIDER_API_KEY)
    return null;
  if (!baseUrl || !model?.trim())
    throw new Error('Set ASTRISLE_PROVIDER_URL and ASTRISLE_PROVIDER_MODEL');
  validateEndpoint(baseUrl);
  const kind = z
    .enum(['openai-compatible', 'openai-responses', 'anthropic', 'gemini'])
    .parse(env.ASTRISLE_PROVIDER_KIND ?? 'openai-compatible');
  return { kind, baseUrl, model: model.trim(), apiKey: env.ASTRISLE_PROVIDER_API_KEY ?? '' };
}
export async function readSecretInput(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const stream = process.stdin;
    const raw = stream.isTTY;
    if (raw) stream.setRawMode(true);
    stream.setEncoding('utf8');
    const finish = (error?: Error) => {
      stream.off('data', data);
      stream.off('end', end);
      stream.pause();
      if (raw) stream.setRawMode(false);
      const value = buffer.trim();
      buffer = '';
      if (error) reject(error);
      else if (!value) reject(new Error('API key input is empty'));
      else resolve(value);
    };
    const data = (chunk: string) => {
      buffer += chunk;
      if (buffer.includes('\x03')) finish(new Error('Input cancelled'));
      else if (buffer.length > 8192) finish(new Error('API key input exceeds limit'));
      else if (/[\r\n]/.test(buffer)) finish();
    };
    const end = () => finish();
    stream.on('data', data);
    stream.once('end', end);
    stream.resume();
    if (raw) process.stdout.write('API key input ready (hidden)\n');
  });
}
