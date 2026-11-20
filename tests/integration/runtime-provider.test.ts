import { expect, it } from 'vitest';
import {
  normalizeResponse,
  buildRequest,
  validateEndpoint,
  validateArguments,
  complete,
} from '../../packages/runtime/src/provider';
import { createPlanTool } from '../../packages/runtime/src/tools';
import { createServer } from 'node:http';
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
it('preserves provider reasoning for subsequent Chat Completions tool rounds', () => {
  const normalized = normalizeResponse('openai-compatible', {
    choices: [
      {
        message: {
          content: '',
          reasoning_content: 'synthetic provider continuation',
          tool_calls: [
            {
              id: 'read-1',
              type: 'function',
              function: { name: 'write', arguments: '{"path":"a"}' },
            },
          ],
          unrelated_vendor_field: 'must not leak into the request',
        },
      },
    ],
  });
  const request = buildRequest(
    {
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: 'fixture',
    },
    [
      { role: 'user', content: 'use the tool' },
      {
        role: 'assistant',
        content: normalized.text,
        calls: normalized.calls,
        native: normalized.native,
      },
      { role: 'tool', callId: 'read-1', content: 'done' },
    ],
    [tool],
  );
  expect(request.body.messages[1].reasoning_content).toBe('synthetic provider continuation');
  expect(request.body.messages[1]).not.toHaveProperty('unrelated_vendor_field');
  expect(request.body.messages[0]).not.toHaveProperty('reasoning_content');
});
it('accepts a normal assistant response with a null tool_calls field', () => {
  expect(
    normalizeResponse('openai-compatible', {
      choices: [{ message: { content: 'Done', tool_calls: null } }],
    }),
  ).toMatchObject({ text: 'Done', calls: [] });
});
it('exposes supported task kinds and partner identities in the model plan schema', () => {
  const planTool = createPlanTool([{ id: 'partner-test', name: 'Nova', temperament: 'explorer' }]);
  const task = {
    key: 'write',
    title: 'Create file',
    description: 'Create file',
    kind: 'implement',
    agentId: 'partner-test',
    dependencies: [],
    criterionIds: ['c1'],
  };
  expect(() => validateArguments({ tasks: [task] }, planTool.parameters)).not.toThrow();
  expect(() =>
    validateArguments({ tasks: [{ ...task, kind: 'author' }] }, planTool.parameters),
  ).toThrow();
  for (const agentId of ['user', 'mori', 'unknown'])
    expect(() =>
      validateArguments({ tasks: [{ ...task, agentId }] }, planTool.parameters),
    ).toThrow();
});
it('retries a malformed model JSON response before any tool call is returned, with a finite limit', async () => {
  let requests = 0;
  let alwaysMalformed = false;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
      /* consume the request */
    }
    requests++;
    const argumentsText =
      alwaysMalformed || requests === 1 ? '{"path":"bad\nJSON"}' : '{"path":"good.txt"}';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'a',
                  type: 'function',
                  function: { name: 'write', arguments: argumentsText },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const provider = {
    kind: 'openai-compatible' as const,
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    model: 'fixture',
    apiKey: 'fixture',
  };
  try {
    const response = await complete(
      provider,
      [{ role: 'user', content: 'write' }],
      [tool],
      new AbortController().signal,
    );
    expect(response.calls[0].args).toEqual({ path: 'good.txt' });
    expect(requests).toBe(2);
    requests = 0;
    alwaysMalformed = true;
    await expect(
      complete(
        provider,
        [{ role: 'user', content: 'write' }],
        [tool],
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(requests).toBe(3);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});
