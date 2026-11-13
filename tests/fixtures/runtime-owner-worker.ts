import { createRuntime } from '../../packages/runtime/src/index';

try {
  const runtime = createRuntime({
    dataRoot: process.argv[2],
    executor: {
      definitions: () => [],
      execute: async () => ({ ok: false, output: 'No tools in ownership fixture' }),
      capabilities: async () => [],
    },
    getCredentials: async () => null,
  });
  process.on('message', async (message) => {
    if (message === 'block') {
      process.send?.({ status: 'blocking' }, () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      });
    } else if (message === 'close') {
      await runtime.close();
      process.disconnect();
    }
  });
  process.send?.({ status: 'ready' });
} catch (error) {
  process.send?.(
    {
      status: 'error',
      code: (error as { code?: string }).code,
      message: (error as Error).message,
    },
    () => process.disconnect(),
  );
}
