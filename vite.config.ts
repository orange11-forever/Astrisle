import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'apps/client',
  base: './',
  plugins: [react()],
  resolve: { alias: { '@astrisle/contracts': resolve('packages/contracts/src/index.ts') } },
  build: { outDir: '../../dist/client', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
