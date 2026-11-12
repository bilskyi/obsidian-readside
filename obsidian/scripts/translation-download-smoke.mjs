// Real-network smoke run of the plugin's download path (not part of any test suite; run by hand):
//   node obsidian/scripts/translation-download-smoke.mjs
// Bundles obsidian/src/translate/downloads.ts as main.js would, then, against the real CDN, through
// Node's https (nodeFetcher) into a throwaway temp folder:
//   1. downloads the smallest catalog file (~750 KB), sha256-verified by crypto.subtle, .part → rename;
//   2. starts the same download and cancels it mid-stream: AbortError, nothing left behind.
// The temp folder is deleted at the end, whatever happens.
import esbuild from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rename, rm, stat, unlink, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE, PAIRS } from '../../src/translate/catalog.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');

async function loadDownloads() {
  const out = await esbuild.build({
    absWorkingDir: repo,
    entryPoints: [join(repo, 'obsidian', 'src', 'translate', 'downloads.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'obsidian-stub',
        setup(b) {
          b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const requestUrl = undefined;', loader: 'js' }));
        },
      },
    ],
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

/** The DataAdapter calls downloadFile makes, over a real folder (paths relative to `base`). */
function fsAdapter(base) {
  const p = (x) => join(base, x);
  return {
    async exists(x) {
      try {
        await stat(p(x));
        return true;
      } catch {
        return false;
      }
    },
    async mkdir(x) {
      await mkdir(p(x), { recursive: true });
    },
    async writeBinary(x, data) {
      await writeFile(p(x), new Uint8Array(data));
    },
    async remove(x) {
      await unlink(p(x));
    },
    async rename(a, b) {
      await rename(p(a), p(b));
    },
  };
}

async function listAll(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out.push(join(e.parentPath ?? e.path, e.name));
  return out;
}

const { downloadFile, nodeFetcher, sha256Hex } = await loadDownloads();
const fetcher = nodeFetcher(createRequire(import.meta.url)('https'));
if (!fetcher) throw new Error('nodeFetcher returned null under Node');
const file = [ENGINE.file, ...PAIRS.flatMap((x) => x.files)].sort((a, b) => a.size - b.size)[0];
const base = await mkdtemp(join(tmpdir(), 'margin-dl-smoke-'));
const root = 'translation';
const dest = `${root}/models/smoke/1/${file.name}`;
const deps = { adapter: fsAdapter(base), root, fetcher, sha256: sha256Hex };

try {
  console.log(`1. ${file.name} (${file.size} B) from ${new URL(file.url).host}`);
  let got = 0;
  const t0 = Date.now();
  await downloadFile(deps, file, dest, (n) => (got += n));
  const bytes = await readFile(join(base, dest));
  const sha = await sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (got !== file.size || bytes.byteLength !== file.size || sha !== file.sha256) throw new Error('verification failed');
  console.log(`   ok: ${got} B in ${Date.now() - t0} ms, sha256 ${sha.slice(0, 12)}…, files: ${(await listAll(base)).length}`);

  await rm(join(base, root), { recursive: true, force: true });
  console.log('2. cancel mid-stream');
  const ctl = new AbortController();
  let n2 = 0;
  const err = await downloadFile(deps, file, dest, (n) => (n2 += n) > 100_000 && ctl.abort(), ctl.signal).then(
    () => null,
    (e) => e,
  );
  const left = (await listAll(base)).filter((f) => !f.endsWith('/'));
  if (err?.name !== 'AbortError' || left.length) throw new Error(`cancel: ${err} / left ${left}`);
  console.log(`   ok: AbortError after ${n2} B, nothing left`);
} finally {
  await rm(base, { recursive: true, force: true });
}
console.log('download smoke passed');
