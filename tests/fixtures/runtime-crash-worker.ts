import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime } from '../../packages/runtime/src/index';

const [dataRoot, commissionId, baseUrl, phase] = process.argv.slice(2);
const runtime = createRuntime({
  dataRoot,
  getCredentials: async () => ({
    kind: 'openai-compatible',
    baseUrl,
    model: 'crash-fixture',
    apiKey: 'test-only',
  }),
  executor: {
    definitions: () => [
      {
        name: 'append_note',
        description: 'Real non-idempotent write',
        effect: 'write',
        parameters: { type: 'object', properties: {} },
      },
    ],
    capabilities: async () => [],
    execute: async (_name, _args, context) => {
      if (phase === 'before_effect') {
        process.send?.({ phase, path: join(context.workPath, 'note.txt') });
        await new Promise(() => {});
      }
      await appendFile(join(context.workPath, 'note.txt'), 'one physical write\n');
      if (phase === 'after_effect') {
        process.send?.({ phase, path: join(context.workPath, 'note.txt') });
        await new Promise(() => {});
      }
      return { ok: true, output: 'Write completed', files: ['note.txt'] };
    },
  },
});
runtime.subscribe((snapshot) => {
  if (phase === 'after_input' && snapshot.events.at(-1)?.type === 'input_requested')
    process.exit(86); // The request is committed, but runtimeTool has not returned its receipt.
  if (phase === 'after_receipt' && snapshot.events.at(-1)?.type === 'tool_finished')
    process.send?.({ phase });
});
void runtime.control(commissionId, 'resume');
