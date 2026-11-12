// Generates src/translate/catalog.ts from Mozilla's Remote Settings (the collections Firefox's
// translations feature uses). Run by hand when deliberately updating models:
//   node obsidian/scripts/gen-translation-catalog.mjs
// Node 24, no dependencies. The plugin never reads Remote Settings at runtime; it only uses the
// committed table this script writes.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RS = 'https://firefox.settings.services.mozilla.com/v1/';
const RECORDS = `${RS}buckets/main/collections/translations-models/records`;
const WASM_RECORDS = `${RS}buckets/main/collections/translations-wasm/records`;
const ENGINE_NAME = 'bergamot-translator';
const VOCAB_TYPES = ['model', 'lex', 'vocab', 'srcvocab', 'trgvocab'];

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'src', 'translate', 'catalog.ts');

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res.json();
}

/** "2.1" > "2.1a2" > "2.1a1" > "2.0"; "b" ranks above "a"; a bare suffix ("1.0a") is suffix 0. */
export function parseVersion(v) {
  const m = /^(\d+(?:\.\d+)*)(?:([a-z]+)(\d*))?$/.exec(String(v));
  if (!m) throw new Error(`unparseable version ${JSON.stringify(v)}`);
  return { nums: m[1].split('.').map(Number), tag: m[2] ?? null, tagNum: m[3] ? Number(m[3]) : 0 };
}

export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  const n = Math.max(x.nums.length, y.nums.length);
  for (let i = 0; i < n; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.tag === y.tag) return Math.sign(x.tagNum - y.tagNum);
  if (x.tag === null) return 1; // a release outranks any pre-release
  if (y.tag === null) return -1;
  return x.tag < y.tag ? -1 : 1;
}

/**
 * Filter expressions under which Firefox desktop Release offers a record. Empty means "everyone".
 * The second is true on desktop for every channel (it only withholds the record from Android
 * Release); en-ru, ja-en, ko-en, en-ko and zh-Hans-en reach desktop Release this way. Anything
 * else (Nightly/Beta-only, Android-only) is excluded. Whitespace is normalised before comparing.
 */
export const DESKTOP_RELEASE_FILTERS = ['', "env.appinfo.OS != 'Android' || env.channel != 'release'"];

export function isRelease(r) {
  const f = r.filter_expression;
  if (f === undefined || f === null) return true;
  return DESKTOP_RELEASE_FILTERS.includes(String(f).trim().replace(/\s+/g, ' '));
}

function file(baseUrl, r, type) {
  const a = r.attachment;
  if (!a || !/^[0-9a-f]{64}$/.test(a.hash) || !(a.size > 0) || !a.location) {
    throw new Error(`record ${r.id} (${r.name}) has a malformed attachment`);
  }
  return { name: a.filename ?? r.name, type, url: baseUrl + a.location, size: a.size, sha256: a.hash };
}

/**
 * Pure: Remote Settings records → { engine, pairs, dropped }. `models` and `wasm` are the
 * collections' `data` arrays; `baseUrl` is the attachments base URL.
 */
export function buildCatalog({ models, wasm, baseUrl }) {
  // Engine: the highest-version Release bergamot-translator record.
  const engines = wasm.filter((r) => r.name === ENGINE_NAME && isRelease(r));
  if (!engines.length) throw new Error('no bergamot-translator record');
  engines.sort((a, b) => compareVersions(b.version, a.version));
  const e = engines[0];
  const engine = { version: e.version, release: e.release, file: file(baseUrl, e, 'wasm') };

  // Models: highest version per (from, to, fileType) among Release records.
  const best = new Map();
  for (const r of models) {
    if (!isRelease(r)) continue;
    if (!VOCAB_TYPES.includes(r.fileType)) throw new Error(`unknown fileType ${r.fileType} in ${r.id}`);
    const k = `${r.fromLang}\u0000${r.toLang}\u0000${r.fileType}`;
    const cur = best.get(k);
    if (!cur || compareVersions(r.version, cur.version) > 0) best.set(k, r);
  }
  const byPair = new Map();
  for (const r of best.values()) {
    const k = `${r.fromLang}-${r.toLang}`;
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(r);
  }

  const pairs = [];
  const dropped = [];
  for (const [k, rs] of byPair) {
    const versions = new Set(rs.map((r) => r.version));
    const types = new Set(rs.map((r) => r.fileType));
    const vocabOk = types.has('vocab') !== (types.has('srcvocab') && types.has('trgvocab'));
    const splitPartial = !types.has('vocab') && types.has('srcvocab') !== types.has('trgvocab');
    if (versions.size !== 1) {
      dropped.push(`${k}: mixed versions ${[...versions].join(', ')}`);
      continue;
    }
    if (!types.has('model') || !types.has('lex') || !vocabOk || splitPartial) {
      dropped.push(`${k}: incomplete file set ${[...types].join(', ')}`);
      continue;
    }
    const [from, to] = [rs[0].fromLang, rs[0].toLang];
    if (from !== 'en' && to !== 'en') {
      dropped.push(`${k}: no English side`);
      continue;
    }
    const files = rs
      .map((r) => file(baseUrl, r, r.fileType))
      .sort((a, b) => VOCAB_TYPES.indexOf(a.type) - VOCAB_TYPES.indexOf(b.type));
    pairs.push({ from, to, version: rs[0].version, files });
  }
  pairs.sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1));
  return { engine, pairs, dropped };
}

async function main() {
  const [root, models, wasm] = await Promise.all([getJson(RS), getJson(RECORDS), getJson(WASM_RECORDS)]);
  const baseUrl = root?.capabilities?.attachments?.base_url;
  if (typeof baseUrl !== 'string' || !baseUrl.startsWith('https://')) throw new Error('no attachments base_url');
  const { engine, pairs, dropped } = buildCatalog({ models: models.data, wasm: wasm.data, baseUrl });
  for (const d of dropped) console.warn(`dropped ${d}`);

  const fetchedAt = new Date().toISOString().slice(0, 10);
  const j = (v) => JSON.stringify(v);
  const fileLine = (f) =>
    `{ name: ${j(f.name)}, type: ${j(f.type)}, url: ${j(f.url)}, size: ${f.size}, sha256: ${j(f.sha256)} }`;
  const lines = [
    '// src/translate/catalog.ts: GENERATED by obsidian/scripts/gen-translation-catalog.mjs; do not edit.',
    `// Source: Mozilla Remote Settings, fetched ${fetchedAt}:`,
    `//   ${RECORDS}`,
    `//   ${WASM_RECORDS}`,
    `// Files: ${baseUrl} + attachment.location (immutable per-upload URLs).`,
    '// Desktop Release records only (empty filter_expression, or one desktop Release passes);',
    '// highest version per (from, to, fileType).',
    '// Engine, glue and models: MPL-2.0 (see obsidian/src/translate/vendor/VENDOR.md).',
    '',
    "export interface CatalogFile { name: string; type: 'model' | 'lex' | 'vocab' | 'srcvocab' | 'trgvocab' | 'wasm'; url: string; size: number; sha256: string }",
    'export interface CatalogPair { from: string; to: string; version: string; files: CatalogFile[] }',
    '',
    `export const CATALOG_SOURCE: { fetchedAt: string; records: string; wasmRecords: string } = { fetchedAt: ${j(fetchedAt)}, records: ${j(RECORDS)}, wasmRecords: ${j(WASM_RECORDS)} };`,
    '',
    `export const ENGINE: { version: string; release: string; file: CatalogFile } = { version: ${j(engine.version)}, release: ${j(engine.release)}, file: ${fileLine(engine.file)} };`,
    '',
    'export const PAIRS: readonly CatalogPair[] = [',
    ...pairs.map(
      (p) =>
        `  { from: ${j(p.from)}, to: ${j(p.to)}, version: ${j(p.version)}, files: [\n${p.files.map((f) => `    ${fileLine(f)},`).join('\n')}\n  ] },`,
    ),
    '];',
    '',
  ];
  writeFileSync(out, lines.join('\n'));
  console.log(`wrote ${out}: engine ${engine.version} (${engine.release}), ${pairs.length} pairs, ${dropped.length} dropped`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
