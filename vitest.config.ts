import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({
  resolve: { alias: { '@astrisle/contracts': resolve('packages/contracts/src/index.ts') } },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 20000,
    pool: 'forks',
  },
});
