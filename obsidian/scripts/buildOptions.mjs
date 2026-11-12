// The plugin's esbuild options, shared by obsidian/esbuild.config.mjs and the bundle test
// (obsidian/test/bundle.test.ts), so the test checks the bundle the build makes.
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workerAssets } from './workerAssetsPlugin.mjs';

const obsidianDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(obsidianDir, '..');

export const MAIN_JS_BUDGET = 1572864; // 1.5 MiB
/** The MPL-2.0 header of the vendored Bergamot glue: it must reach main.js verbatim. */
export const MPL_NOTICE = 'This Source Code Form is subject to the terms of the Mozilla Public';

export const EXTERNALS = [
  'obsidian',
  'electron',
  '@codemirror/autocomplete',
  '@codemirror/collab',
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/lint',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/lr',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

const backendFile = join(repo, 'src', 'lib', 'backend.ts');
const tauriStub = join(obsidianDir, 'src', 'stubs', 'tauriBackend.ts');

/** Keeps desktop-only code and our own pdf.js out of the plugin. */
const guards = {
  name: 'margin-guards',
  setup(build) {
    build.onResolve({ filter: /^\.\/tauriBackend$/ }, (args) => (args.importer === backendFile ? { path: tauriStub } : undefined));
    build.onResolve({ filter: /^@tauri-apps\// }, (args) => ({
      errors: [{ text: `desktop-only module ${args.path} imported by ${args.importer}` }],
    }));
    build.onResolve({ filter: /^pdfjs-dist(\/|$)/ }, (args) => ({
      errors: [{ text: `pdfjs-dist imported by ${args.importer}: the plugin uses Obsidian's loadPdfJs()` }],
    }));
  },
};

/** esbuild options for main.js (`outfile` defaults to obsidian/dist/main.js). */
export function buildOptions({ production, outfile = join(obsidianDir, 'dist', 'main.js') }) {
  return {
    absWorkingDir: repo,
    entryPoints: [join(obsidianDir, 'src', 'main.ts')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['es2022', 'chrome120'],
    external: EXTERNALS,
    jsx: 'automatic',
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.gif': 'dataurl' },
    define: {
      'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
      'import.meta.env.DEV': JSON.stringify(!production),
    },
    minify: production,
    sourcemap: production ? false : 'inline',
    treeShaking: true,
    logLevel: 'info',
    plugins: [guards, workerAssets({ minify: production })],
  };
}
