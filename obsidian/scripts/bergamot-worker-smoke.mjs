// Smoke run of the shipping worker + client against the real engine (not part of any test suite).
//   node obsidian/scripts/bergamot-smoke.mjs          # once: downloads + verifies engine, uk-en, en-uk
//   node obsidian/scripts/bergamot-worker-smoke.mjs
// Builds src/translate/bergamot/worker.ts exactly as main.js embeds it, runs it in a worker-shaped
// vm context (messages structured-cloned with their transfer lists, like postMessage), and drives
// it through BergamotClient: uk→en, en→uk, a pivot (uk→en→uk), an eviction and an idle restart.
import esbuild from 'esbuild';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { ENGINE, PAIRS } from '../../src/translate/catalog.ts';
import { GLUE_FILE, buildWorkerScript } from './workerAssetsPlugin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const root = join(here, '..', 'test-vault', '.obsidian', 'plugins', 'margin-reader', 'translation');
const wasmPath = join(root, 'engine', ENGINE.file.sha256.slice(0, 12), ENGINE.file.name);
const pairDir = (p) => join(root, 'models', `${p.from}-${p.to}`, p.version);

async function loadClientModule() {
  const out = await esbuild.build({
    absWorkingDir: repo,
    entryPoints: [join(repo, 'src', 'translate', 'bergamot', 'BergamotClient.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

/** A WorkerLike whose "thread" is a vm context running the bundled worker script. */
function makeWorkerFactory(workerCode, stats) {
  return () => {
    stats.created++;
    const blobs = new Map();
    const ctx = {
      console,
      performance,
      WebAssembly,
      TextDecoder,
      TextEncoder,
      Uint8Array,
      Promise,
      queueMicrotask,
      setTimeout,
      location: { href: 'blob:null/margin-worker-smoke' },
      Blob: class {
        constructor(parts) {
          this.text = parts.join('');
        }
      },
      URL: {
        createObjectURL: (b) => {
          const url = `blob:smoke/${blobs.size + 1}`;
          blobs.set(url, b.text);
          return url;
        },
        revokeObjectURL: (u) => blobs.delete(u),
      },
    };
    ctx.self = ctx;
    ctx.importScripts = (url) => vm.runInContext(blobs.get(url), ctx, { filename: 'bergamot-translator.js' });
    let dead = false;
    const outer = {
      onmessage: null,
      onerror: null,
      postMessage(m, transfer = []) {
        if (dead) return;
        const copy = structuredClone(m, { transfer });
        setTimeout(() => !dead && ctx.onmessage({ data: copy }), 0);
      },
      terminate() {
        dead = true;
        stats.terminated++;
      },
    };
    ctx.postMessage = (r) => setTimeout(() => !dead && outer.onmessage?.({ data: structuredClone(r) }), 0);
    vm.createContext(ctx);
    vm.runInContext(workerCode, ctx, { filename: 'worker.js' });
    if (typeof ctx.onmessage !== 'function') throw new Error('the worker script did not install onmessage');
    return outer;
  };
}

async function main() {
  const ukEn = PAIRS.find((p) => p.from === 'uk' && p.to === 'en');
  const enUk = PAIRS.find((p) => p.from === 'en' && p.to === 'uk');
  for (const path of [wasmPath, ...[ukEn, enUk].flatMap((p) => p.files.map((f) => join(pairDir(p), f.name)))]) {
    if (!existsSync(path)) throw new Error(`missing ${path}: run node obsidian/scripts/bergamot-smoke.mjs first`);
  }
  const { BergamotClient } = await loadClientModule();
  const { code } = await buildWorkerScript({ minify: true });
  const glue = await readFile(GLUE_FILE, 'utf8');
  const stats = { created: 0, terminated: 0 };
  const reads = [];
  const files = (p) => async () => {
    reads.push(`${p.from}-${p.to}`);
    return Promise.all(
      p.files.map(async (f) => {
        const b = await readFile(join(pairDir(p), f.name));
        return { type: f.type, name: f.name, bytes: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
      }),
    );
  };
  const client = new BergamotClient({
    createWorker: makeWorkerFactory(code, stats),
    glue: () => glue,
    wasm: async () => {
      const b = await readFile(wasmPath);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    idleMs: 1500,
    timeoutMs: 30_000,
  });

  const t0 = performance.now();
  const lap = (label) => console.log(`${label} [${Math.round(performance.now() - t0)} ms]`);
  await client.ensureModel('uk-en', 'uk', 'en', files(ukEn));
  await client.ensureModel('en-uk', 'en', 'uk', files(enUk));
  lap('engine + 2 models loaded');
  const a = await client.translate(['uk-en'], ['Привіт, світ. Як справи?', 'Книга лежить на столі.']);
  lap(`uk→en: ${JSON.stringify(a)}`);
  const b = await client.translate(['en-uk'], ['The quick brown fox jumps over the lazy dog.']);
  lap(`en→uk: ${JSON.stringify(b)}`);
  const c = await client.translate(['uk-en', 'en-uk'], ['Я читаю книгу.']);
  lap(`uk→en→uk (pivot): ${JSON.stringify(c)}`);
  const ac = new AbortController();
  const aborted = client.translate(['uk-en'], ['Скасовано.'], ac.signal);
  ac.abort();
  const abortName = await aborted.then(() => 'resolved', (e) => e.name);
  lap(`abort → ${abortName}`);
  await new Promise((r) => setTimeout(r, 2000));
  lap(`idle: workers created ${stats.created}, terminated ${stats.terminated}`);
  const d = await client.translate(['uk-en'], ['Добрий ранок.']);
  lap(`after idle restart, uk→en: ${JSON.stringify(d)}; workers created ${stats.created}; file reads ${reads.join(', ')}`);
  client.dispose();

  const cyr = /[Ѐ-ӿ]/;
  const ok =
    a.length === 2 && a.every((s) => s.trim() && !cyr.test(s)) &&
    b.length === 1 && cyr.test(b[0]) &&
    c.length === 1 && cyr.test(c[0]) &&
    abortName === 'AbortError' &&
    stats.created === 2 && stats.terminated >= 1 &&
    d.length === 1 && d[0].trim() && !cyr.test(d[0]) &&
    reads.join(',') === 'uk-en,en-uk,uk-en';
  console.log(ok ? 'worker smoke: OK' : 'worker smoke: FAILED');
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('worker smoke: FAILED', e);
  process.exit(1);
});
