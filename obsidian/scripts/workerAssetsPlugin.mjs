// esbuild plugin: the virtual module `margin:worker-assets`, which exports the Bergamot worker
// (src/translate/bergamot/worker.ts, bundled to a self-contained IIFE) and the vendored engine
// glue, both as strings. The plugin starts them from blob: URLs at runtime; neither is ever
// evaluated in the plugin's own scope. The wasm and the models are never bundled.
import esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
export const WORKER_ENTRY = join(repo, 'src', 'translate', 'bergamot', 'worker.ts');
export const GLUE_FILE = join(repo, 'obsidian', 'src', 'translate', 'vendor', 'bergamot-translator.js');
export const WORKER_ASSETS_MODULE = 'margin:worker-assets';

/** The worker script as one IIFE string, plus the files it was built from. */
export async function buildWorkerScript({ minify }) {
  const result = await esbuild.build({
    absWorkingDir: repo,
    entryPoints: [WORKER_ENTRY],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022', 'chrome120'],
    write: false,
    minify,
    metafile: true,
    logLevel: 'silent',
  });
  const code = result.outputFiles[0].text;
  const inputs = Object.keys(result.metafile.inputs).map((p) => resolve(repo, p));
  return { code, inputs };
}

export function workerAssets({ minify }) {
  return {
    name: 'margin-worker-assets',
    setup(build) {
      build.onResolve({ filter: /^margin:worker-assets$/ }, () => ({ path: WORKER_ASSETS_MODULE, namespace: 'margin-worker-assets' }));
      build.onLoad({ filter: /.*/, namespace: 'margin-worker-assets' }, async () => {
        const [worker, glue] = await Promise.all([buildWorkerScript({ minify }), readFile(GLUE_FILE, 'utf8')]);
        return {
          contents: `export const WORKER_JS = ${JSON.stringify(worker.code)};\nexport const GLUE_JS = ${JSON.stringify(glue)};\n`,
          loader: 'js',
          watchFiles: [...worker.inputs, GLUE_FILE],
        };
      });
    },
  };
}
