import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  build: {
    outDir: path.resolve(here, '../dist/web'),
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    proxy: {
      // dev: vite serves the client, game server runs on :8080
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
