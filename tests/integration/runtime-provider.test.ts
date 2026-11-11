import { expect, it } from 'vitest';
import {
  normalizeResponse,
  buildRequest,
  validateEndpoint,
} from '../../packages/runtime/src/provider';
const tool = {
  name: 'write',
  description: 'Write',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  effect: 'write' as const,
};
it('normalizes real Chat Completions, Responses, Anthropic and Gemini tool calls', () => {
  const fixtures = [
    [
      'openai-compatible',
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'a',
                  type: 'function',
                  function: { name: 'write', arguments: '{"path":"a"}' },
                },
              ],
            },
          },
        ],
      },
    ],
    [
      'openai-responses',
      {
        output: [{ type: 'function_call', call_id: 'a', name: 'write', arguments: '{"path":"a"}' }],
      },
    ],
    [
      'anthropic',
      { content: [{ type: 'tool_use', id: 'a', name: 'write', input: { path: 'a' } }] },
    ],
    [
      'gemini',
      {
        candidates: [
          { content: { parts: [{ functionCall: { name: 'write', args: { path: 'a' } } }] } },
        ],
      },
    ],
  ] as const;
  for (const [kind, payload] of fixtures) {
    const result = normalizeResponse(kind, payload);
    expect(result.calls[0].name).toBe('write');
    expect(result.calls[0].args).toEqual({ path: 'a' });
  }
});
it('builds vendor-native endpoints and rejects insecure remote HTTP', () => {
  for (const kind of ['openai-compatible', 'openai-responses', 'anthropic', 'gemini'] as const) {
    const request = buildRequest(
      { kind, baseUrl: 'https://example.com/v1', model: 'configured', apiKey: 'secret' },
      [{ role: 'user', content: 'work' }],
      [tool],
    );
    expect(request.url).toContain('https://example.com/v1/');
    expect(request.url + JSON.stringify(request.body)).toContain('configured');
    if (kind === 'gemini') expect(request.body).not.toHaveProperty('model');
  }
  expect(() => validateEndpoint('http://remote.example/v1')).toThrow();
  expect(() => validateEndpoint('http://127.0.0.1:8080/v1')).not.toThrow();
});
