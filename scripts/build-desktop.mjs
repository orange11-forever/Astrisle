import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
import './build-process-supervisor.mjs';
import './build-safe-apply.mjs';
await build({
  entryPoints: {
    main: 'apps/desktop/src/main.ts',
    preload: 'apps/desktop/src/preload.ts',
    runtime: 'apps/desktop/src/runtime-process.ts',
    'character-validator-preload': 'apps/desktop/src/character-validator-preload.ts',
  },
  outdir: 'dist/desktop',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'node:sqlite'],
  sourcemap: true,
  logLevel: 'info',
});
await build({
  entryPoints: ['apps/desktop/src/character-validator-page.ts'],
  outfile: 'dist/desktop/character-validator.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome142',
  logLevel: 'info',
});
await copyFile(
  'apps/desktop/src/character-validator.html',
  'dist/desktop/character-validator.html',
);
