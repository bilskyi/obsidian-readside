// Smoke run of the Bergamot engine outside Firefox: Node's V8 (the same wasm engine as
// Chromium/Electron, and like them without Firefox's WebAssembly.mozIntGemm).
//   node obsidian/scripts/bergamot-smoke.mjs
// Downloads the engine and the uk-en / en-uk models listed in src/translate/catalog.ts into the
// test vault's (gitignored) plugin folder, verifies every file's sha256, evaluates the vendored
// glue in a vm context shaped like a worker, and translates one sentence each way.
// Exits non-zero if anything fails or a translation comes back empty or unchanged.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { get } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { ENGINE, PAIRS } from '../../src/translate/catalog.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'test-vault', '.obsidian', 'plugins', 'margin-reader', 'translation');
const gluePath = join(here, '..', 'src', 'translate', 'vendor', 'bergamot-translator.js');
const CDN = 'https://firefox-settings-attachments.cdn.mozilla.net/';
const INITIAL_MEMORY = 41943040; // 40 MiB; the heap grows as models are loaded.

const SAMPLES = [
  { from: 'uk', to: 'en', text: 'Привіт, світ. Як справи?' },
  { from: 'en', to: 'uk', text: 'The quick brown fox jumps over the lazy dog.' },
];

// Firefox's translations-engine.worker.js values.
const ALIGNMENT = { model: 256, lex: 64, vocab: 64, srcvocab: 64, trgvocab: 64 };

const sha256File = (path) =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });

function download(url, dest) {
  if (!url.startsWith(CDN)) throw new Error(`refusing non-catalog URL ${url}`);
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GET ${url}: HTTP ${res.statusCode}`));
        return;
      }
      const out = createWriteStream(dest);
      res.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Ensures `file` is at `path` with the catalog's size and sha256; returns its bytes. */
async function fetchVerified(file, path) {
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) {
    if ((await stat(path)).size === file.size && (await sha256File(path)) === file.sha256) {
      console.log(`  cached   ${file.name}`);
      return readFile(path);
    }
    await rm(path);
  }
  const part = `${path}.part`;
  const t = performance.now();
  await download(file.url, part);
  const [size, sha] = [(await stat(part)).size, await sha256File(part)];
  if (size !== file.size || sha !== file.sha256) {
    await rm(part, { force: true });
    throw new Error(`${file.name}: got ${size} B sha256 ${sha}, want ${file.size} B ${file.sha256}`);
  }
  await rename(part, path);
  console.log(`  verified ${file.name} (${size} B, ${Math.round(performance.now() - t)} ms)`);
  return readFile(path);
}

function loadEngine(glue, wasmBinary) {
  // A worker-shaped global: `self`, a no-op `importScripts` (makes the glue take its worker
  // path), a blob: location (so it resolves no script directory), WebAssembly and performance.
  const ctx = {
    console,
    performance,
    WebAssembly,
    TextDecoder,
    TextEncoder,
    location: { href: 'blob:null/margin-bergamot-smoke' },
    importScripts() {},
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(glue, ctx, { filename: 'bergamot-translator.js' });
  if (typeof ctx.loadBergamot !== 'function') throw new Error('glue did not define loadBergamot');
  const prints = [];
  return new Promise((resolve, reject) => {
    const bergamot = ctx.loadBergamot({
      wasmBinary,
      INITIAL_MEMORY,
      print: (m) => prints.push(String(m)),
      printErr: (m) => prints.push(`ERR ${m}`),
      onAbort: (why) => reject(new Error(`Bergamot aborted: ${why}`)),
      onRuntimeInitialized: async () => {
        await Promise.resolve();
        resolve({ bergamot, prints });
      },
    });
  });
}

function configText(modelName) {
  const config = {
    'beam-size': '1',
    normalize: '1.0',
    'word-penalty': '0',
    'max-length-break': '128',
    'mini-batch-words': '1024',
    workspace: '128',
    'max-length-factor': '2.0',
    'skip-cost': 'true',
    'cpu-threads': '0',
    quiet: 'true',
    'quiet-translation': 'true',
    'gemm-precision': modelName.endsWith('intgemm8.bin') ? 'int8shiftAll' : 'int8shiftAlphaAll',
    alignment: 'soft',
  };
  const indent = '            ';
  return `\n${Object.entries(config).map(([k, v]) => `${indent}${k}: ${v}\n`).join('')}${indent}`;
}

function buildModel(bergamot, pair, bytesByType) {
  const aligned = {};
  for (const [type, bytes] of Object.entries(bytesByType)) {
    const mem = new bergamot.AlignedMemory(bytes.byteLength, ALIGNMENT[type]);
    mem.getByteArrayView().set(bytes);
    aligned[type] = mem;
  }
  const vocabs = new bergamot.AlignedMemoryList();
  if (aligned.vocab) vocabs.push_back(aligned.vocab);
  else {
    vocabs.push_back(aligned.srcvocab);
    vocabs.push_back(aligned.trgvocab);
  }
  const modelName = pair.files.find((f) => f.type === 'model').name;
  return new bergamot.TranslationModel(pair.from, pair.to, configText(modelName), aligned.model, aligned.lex, vocabs, null);
}

function translate(bergamot, service, model, text) {
  const messages = new bergamot.VectorString();
  const options = new bergamot.VectorResponseOptions();
  let responses;
  try {
    messages.push_back(text);
    options.push_back({ qualityScores: false, alignment: true, html: false });
    responses = service.translate(model, messages, options);
    return responses.get(0).getTranslatedText();
  } finally {
    messages.delete();
    options.delete();
    responses?.delete();
  }
}

async function main() {
  console.log(`node ${process.version}, V8 ${process.versions.v8}; mozIntGemm: ${'mozIntGemm' in WebAssembly}`);
  console.log(`files → ${root}`);
  const t0 = performance.now();
  const wasm = await fetchVerified(ENGINE.file, join(root, 'engine', ENGINE.file.sha256.slice(0, 12), ENGINE.file.name));
  const pairBytes = new Map();
  for (const s of SAMPLES) {
    const pair = PAIRS.find((p) => p.from === s.from && p.to === s.to);
    if (!pair) throw new Error(`catalog has no ${s.from}-${s.to}`);
    const bytes = {};
    for (const f of pair.files) {
      bytes[f.type] = new Uint8Array(await fetchVerified(f, join(root, 'models', `${pair.from}-${pair.to}`, pair.version, f.name)));
    }
    pairBytes.set(s, { pair, bytes });
  }
  const tFiles = performance.now();

  const glue = await readFile(gluePath, 'utf8');
  const { bergamot, prints } = await loadEngine(glue, wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const tInit = performance.now();
  console.log(`engine initialised in ${Math.round(tInit - tFiles)} ms; glue says: ${prints.join(' | ') || '(nothing)'}`);

  const service = new bergamot.BlockingService({ cacheSize: 0 });
  const results = [];
  for (const s of SAMPLES) {
    const { pair, bytes } = pairBytes.get(s);
    const tb = performance.now();
    const model = buildModel(bergamot, pair, bytes);
    const tm = performance.now();
    const out = translate(bergamot, service, model, s.text);
    const tt = performance.now();
    const again = translate(bergamot, service, model, s.text);
    const tt2 = performance.now();
    results.push({ ...s, version: pair.version, out, again, build: tm - tb, first: tt - tm, second: tt2 - tt });
  }
  console.log(`glue messages after translating: ${prints.slice(1).join(' | ') || '(none)'}`);

  let ok = true;
  for (const r of results) {
    const sane = r.out.trim().length > 0 && r.out.trim() !== r.text && r.out === r.again;
    const script = r.to === 'uk' ? /[Ѐ-ӿ]/ : /^[\x20-\x7E]+$/;
    const rightScript = script.test(r.out);
    ok &&= sane && rightScript;
    console.log(
      `${r.from}→${r.to} (v${r.version}): ${JSON.stringify(r.text)} → ${JSON.stringify(r.out)}  ` +
        `[model build ${Math.round(r.build)} ms, first ${Math.round(r.first)} ms, second ${Math.round(r.second)} ms]` +
        (sane && rightScript ? '' : '  ← FAILED CHECK'),
    );
  }
  console.log(`files ${Math.round(tFiles - t0)} ms, total ${Math.round(performance.now() - t0)} ms`);
  if (!ok) {
    console.error('smoke: FAILED');
    process.exit(1);
  }
  console.log('smoke: OK');
}

main().catch((err) => {
  console.error('smoke: FAILED', err);
  process.exit(1);
});
