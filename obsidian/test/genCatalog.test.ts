import { describe, expect, it } from 'vitest';
import { buildCatalog, isRelease } from '../scripts/gen-translation-catalog.mjs';

const BASE = 'https://firefox-settings-attachments.cdn.mozilla.net/';
const DESKTOP = "env.appinfo.OS != 'Android' || env.channel != 'release'";
const NIGHTLY = "env.channel == 'default' || env.channel == 'nightly'";
const ANDROID = "env.appinfo.OS == 'Android' ";

let n = 0;
function rec(fromLang: string, toLang: string, fileType: string, version: string, filter_expression?: string) {
  n++;
  const hex = n.toString(16).padStart(64, '0');
  return {
    id: `r${n}`,
    name: `${fileType}.${fromLang}${toLang}.bin`,
    fromLang,
    toLang,
    fileType,
    version,
    ...(filter_expression === undefined ? {} : { filter_expression }),
    attachment: { hash: hex, size: 100 + n, location: `models/${n}.bin`, filename: `${fileType}.${fromLang}${toLang}.bin` },
  };
}
const pairRecs = (from: string, to: string, version: string, filter?: string) =>
  ['model', 'lex', 'vocab'].map((t) => rec(from, to, t, version, filter));

const wasm = [
  {
    id: 'w1',
    name: 'bergamot-translator',
    version: '3.0',
    release: 'v0.6.0',
    filter_expression: '',
    attachment: { hash: 'a'.repeat(64), size: 5, location: 'wasm/1.wasm', filename: 'bergamot-translator.wasm' },
  },
];

describe('gen-translation-catalog: Release filter', () => {
  it('treats empty and the desktop-only-withholds-Android-Release filter as desktop Release', () => {
    expect(isRelease({})).toBe(true);
    expect(isRelease({ filter_expression: '' })).toBe(true);
    expect(isRelease({ filter_expression: null })).toBe(true);
    expect(isRelease({ filter_expression: DESKTOP })).toBe(true);
    expect(isRelease({ filter_expression: `  ${DESKTOP.replace(' || ', '  ||  ')} ` })).toBe(true);
  });

  it('excludes Nightly/Beta-only and Android-only filters', () => {
    expect(isRelease({ filter_expression: NIGHTLY })).toBe(false);
    expect(isRelease({ filter_expression: `${NIGHTLY} || env.channel == 'beta'` })).toBe(false);
    expect(isRelease({ filter_expression: ANDROID })).toBe(false);
    expect(isRelease({ filter_expression: "env.appinfo.OS == 'Android' || env.channel != 'release'" })).toBe(false);
  });

  it('buildCatalog keeps desktop-filtered pairs, drops Nightly-only ones, and takes the best desktop version', () => {
    const models = [
      ...pairRecs('uk', 'en', '1.1', ''),
      ...pairRecs('en', 'ru', '2.0', DESKTOP),
      ...pairRecs('en', 'ru', '2.1', ANDROID), // newer but Android-only: ignored
      ...pairRecs('en', 'ru', '2.1a1', NIGHTLY),
      ...pairRecs('mt', 'en', '1.0a1', NIGHTLY),
      ...pairRecs('nn', 'en', '1.0a1', NIGHTLY),
    ];
    const { engine, pairs, dropped } = buildCatalog({ models, wasm, baseUrl: BASE });
    expect(engine.file.url).toBe(`${BASE}wasm/1.wasm`);
    expect(dropped).toEqual([]);
    const keys = pairs.map((p: { from: string; to: string; version: string }) => `${p.from}-${p.to}@${p.version}`);
    expect(keys).toEqual(['en-ru@2.0', 'uk-en@1.1']);
    const enRu = pairs.find((p: { from: string }) => p.from === 'en');
    expect(enRu.files.map((f: { type: string }) => f.type)).toEqual(['model', 'lex', 'vocab']);
    expect(enRu.files[0].url.startsWith(`${BASE}models/`)).toBe(true);
  });
});
