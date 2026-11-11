import { build } from 'esbuild';
await build({
  entryPoints: {
    main: 'apps/desktop/src/main.ts',
    preload: 'apps/desktop/src/preload.ts',
    runtime: 'apps/desktop/src/runtime-process.ts',
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
