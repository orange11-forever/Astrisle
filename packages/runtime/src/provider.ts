import { randomUUID } from 'node:crypto';
import type { ProviderInput, ToolDefinition } from '../../contracts/src/index';
export interface Call {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  calls?: Call[];
  callId?: string;
  name?: string;
  native?: unknown;
}
export interface ModelResult {
  text: string;
  calls: Call[];
  native?: unknown;
}
type Kind = ProviderInput['kind'];
type Json = Record<string, any>;
function obj(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Provider returned an invalid object');
  return value as Json;
}
function array(value: unknown): any[] {
  if (!Array.isArray(value)) throw new Error('Provider returned an invalid array');
  return value;
}
function args(value: unknown): Record<string, unknown> {
  return obj(typeof value === 'string' ? JSON.parse(value) : value);
}
function call(id: unknown, name: unknown, input: unknown): Call {
  if (typeof name !== 'string' || !name) throw new Error('Invalid tool call name');
  return {
    id: typeof id === 'string' ? id : randomUUID(),
    name,
    args: args(input),
  };
}
export function validateEndpoint(baseUrl: string): URL {
  const u = new URL(baseUrl);
  if (u.username || u.password || u.hash || u.search)
    throw new Error('Provider URL cannot contain credentials, query, or fragment');
  if (
    u.protocol !== 'https:' &&
    !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
  )
    throw new Error('Provider requires HTTPS (loopback HTTP is allowed)');
  return u;
}
export function normalizeResponse(kind: Kind, payload: unknown): ModelResult {
  const p = obj(payload);
  if (p.error) throw new Error('Provider returned an error');
  if (kind === 'openai-compatible') {
    const m = obj(array(p.choices)[0]?.message);
    return {
      text: typeof m.content === 'string' ? m.content : '',
      calls: (m.tool_calls === undefined ? [] : array(m.tool_calls)).map((c) =>
        call(c.id, c.function?.name, c.function?.arguments),
      ),
      native: m,
    };
  }
  if (kind === 'openai-responses') {
    const blocks = array(p.output);
    return {
      text: blocks
        .filter((b) => b.type === 'message')
        .flatMap((b) => b.content ?? [])
        .filter((b) => b.type === 'output_text')
        .map((b) => b.text)
        .join('\n'),
      calls: blocks
        .filter((b) => b.type === 'function_call')
        .map((c) => call(c.call_id, c.name, c.arguments)),
      native: blocks,
    };
  }
  if (kind === 'anthropic') {
    const blocks = array(p.content);
    return {
      text: blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
      calls: blocks.filter((b) => b.type === 'tool_use').map((c) => call(c.id, c.name, c.input)),
      native: blocks,
    };
  }
  if (kind === 'gemini') {
    const parts = array(array(p.candidates)[0]?.content?.parts);
    return {
      text: parts
        .filter((b) => typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n'),
      calls: parts
        .filter((b) => b.functionCall)
        .map((c) => call(c.functionCall.id, c.functionCall.name, c.functionCall.args)),
      native: parts,
    };
  }
  throw new Error('Unsupported provider protocol');
}
export function buildRequest(
  settings: ProviderInput & {
    apiKey: string;
  },
  messages: Message[],
  tools: ToolDefinition[],
): {
  url: string;
  headers: Record<string, string>;
  body: Json;
} {
  validateEndpoint(settings.baseUrl);
  if (!settings.model.trim()) throw new Error('A provider model is required');
  const base = settings.baseUrl.replace(/\/$/, ''),
    headers: Record<string, string> = {
      'content-type': 'application/json',
    };
  const functions = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  if (settings.kind === 'openai-compatible') {
    headers.authorization = `Bearer ${settings.apiKey}`;
    return {
      url: `${base}/chat/completions`,
      headers,
      body: {
        model: settings.model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.calls?.length
            ? {
                tool_calls: m.calls.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: {
                    name: c.name,
                    arguments: JSON.stringify(c.args),
                  },
                })),
              }
            : {}),
          ...(m.callId
            ? {
                tool_call_id: m.callId,
              }
            : {}),
        })),
        ...(tools.length
          ? {
              tools: functions.map((f) => ({
                type: 'function',
                function: f,
              })),
              tool_choice: 'auto',
            }
          : {}),
      },
    };
  }
  if (settings.kind === 'openai-responses') {
    headers.authorization = `Bearer ${settings.apiKey}`;
    const input = messages.flatMap((m) =>
      m.role === 'tool'
        ? [
            {
              type: 'function_call_output',
              call_id: m.callId,
              output: m.content,
            },
          ]
        : m.role === 'assistant' && m.native
          ? (m.native as any[])
          : [
              {
                role: m.role,
                content: m.content,
              },
            ],
    );
    return {
      url: `${base}/responses`,
      headers,
      body: {
        model: settings.model,
        input,
        ...(tools.length
          ? {
              tools: functions.map((f) => ({
                type: 'function',
                ...f,
                strict: false,
              })),
            }
          : {}),
      },
    };
  }
  if (settings.kind === 'anthropic') {
    headers['x-api-key'] = settings.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    const conversation = messages
      .filter((m) => m.role !== 'system')
      .map((m) =>
        m.role === 'tool'
          ? {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: m.callId,
                  content: m.content,
                },
              ],
            }
          : m.role === 'assistant' && m.native
            ? {
                role: 'assistant',
                content: m.native,
              }
            : {
                role: m.role,
                content: m.content,
              },
      );
    return {
      url: `${base}/messages`,
      headers,
      body: {
        model: settings.model,
        max_tokens: 8192,
        system: messages
          .filter((m) => m.role === 'system')
          .map((m) => m.content)
          .join('\n'),
        messages: conversation,
        ...(tools.length
          ? {
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
              })),
            }
          : {}),
      },
    };
  }
  if (settings.kind === 'gemini') {
    headers['x-goog-api-key'] = settings.apiKey;
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts:
          m.role === 'tool'
            ? [
                {
                  functionResponse: {
                    name: m.name,
                    id: m.callId,
                    response: {
                      output: m.content,
                    },
                  },
                },
              ]
            : m.role === 'assistant' && m.native
              ? m.native
              : [
                  {
                    text: m.content,
                  },
                ],
      }));
    return {
      url: `${base}/models/${encodeURIComponent(settings.model)}:generateContent`,
      headers,
      body: {
        contents,
        systemInstruction: {
          parts: [
            {
              text: messages
                .filter((m) => m.role === 'system')
                .map((m) => m.content)
                .join('\n'),
            },
          ],
        },
        ...(tools.length
          ? {
              tools: [
                {
                  functionDeclarations: functions,
                },
              ],
            }
          : {}),
      },
    };
  }
  throw new Error('Unsupported provider protocol');
}
/** Throws on unknown arguments before any side effects. Supports the tool registry's JSON Schema subset. */
export function validateArguments(
  value: unknown,
  schema: Record<string, unknown>,
  path = 'arguments',
): void {
  const s = schema as Json;
  if (s.enum && !s.enum.includes(value)) throw new Error(`${path}: invalid enum`);
  if (s.type === 'object') {
    const v = obj(value);
    for (const key of s.required ?? [])
      if (!(key in v)) throw new Error(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(v)) {
      if (s.properties?.[key]) validateArguments(item, s.properties[key], `${path}.${key}`);
      else if (s.additionalProperties === false) throw new Error(`${path}.${key}: unknown`);
    }
  }
  if (s.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path}: expected array`);
    for (const item of value) validateArguments(item, s.items ?? {}, path);
  }
  if (s.type === 'string' && typeof value !== 'string') throw new Error(`${path}: expected string`);
  if (s.type === 'boolean' && typeof value !== 'boolean')
    throw new Error(`${path}: expected boolean`);
  if (
    ['number', 'integer'].includes(s.type) &&
    (typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (s.type === 'integer' && !Number.isInteger(value)))
  )
    throw new Error(`${path}: expected number`);
}
export async function complete(
  settings: ProviderInput & {
    apiKey: string;
  },
  messages: Message[],
  tools: ToolDefinition[],
  signal: AbortSignal,
): Promise<ModelResult> {
  const request = buildRequest(settings, messages, tools);
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
        redirect: 'error',
      });
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await delay(250 * (attempt + 1), signal);
          continue;
        }
        throw new Error(`Provider HTTP ${response.status}`);
      }
      return normalizeResponse(settings.kind, await response.json());
    } catch (e) {
      if (signal.aborted) throw e;
      if (attempt < 2 && e instanceof TypeError) {
        await delay(250 * (attempt + 1), signal);
        continue;
      }
      throw e;
    }
  }
  throw new Error('Provider retry limit reached');
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    }
    signal.addEventListener('abort', abort, {
      once: true,
    });
  });
}
