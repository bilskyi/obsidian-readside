import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('..'),
  resolve: {
    // Only the bare specifier: the real package has no runtime code.
    alias: [
      { find: /^obsidian$/, replacement: here('./test/obsidian-mock.ts') },
      // Built by esbuild (obsidian/scripts/workerAssetsPlugin.mjs); tests get two short strings.
      { find: /^margin:worker-assets$/, replacement: here('./test/workerAssetsStub.ts') },
    ],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['obsidian/test/**/*.test.ts', 'obsidian/test/**/*.test.tsx'],
    setupFiles: ['obsidian/test/setup.ts'],
  },
});
