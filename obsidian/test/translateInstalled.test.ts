import { describe, expect, it } from 'vitest';
import { InstalledStore, enginePath, isFileName, isPairKey, isSha256, isVersion, modelPath, parseInstalled, type Installed } from '../src/translate/installed';
import { ENGINE, PAIRS } from '../../src/translate/catalog';
import { pairKey } from '../../src/translate/planPair';
import { TROOT, TestAdapter } from './translateFakes';

const SHA_E = 'e'.repeat(64);
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const FILES = [
  { name: 'model.uken.intgemm.alphas.bin', sha256: SHA_A, size: 10 },
  { name: 'vocab.uken.spm', sha256: SHA_B, size: 4 },
];
const REG = `${TROOT}/installed.json`;

/** Puts the files the registry entries name on disk with their sizes. */
async function place(adapter: TestAdapter, key: string, version: string, files = FILES) {
  await adapter.mkdir(`${TROOT}/models/${key}/${version}`);
  for (const f of files) adapter.files.set(modelPath(TROOT, key, version, f.name), new ArrayBuffer(f.size));
}
async function placeEngine(adapter: TestAdapter, sha = SHA_E, size = 7) {
  await adapter.mkdir(`${TROOT}/engine/${sha.slice(0, 12)}`);
  adapter.files.set(enginePath(TROOT, sha), new ArrayBuffer(size));
}

describe('InstalledStore', () => {
  it('round-trips through installed.json', async () => {
    const adapter = new TestAdapter();
    await place(adapter, 'uk-en', '1.1');
    await placeEngine(adapter);
    const a = new InstalledStore(adapter as never, TROOT);
    await a.markEngine(SHA_E, 7);
    await a.markPair('uk-en', '1.1', FILES);
    const want: Installed = { version: 1, engine: { sha256: SHA_E, size: 7 }, pairs: { 'uk-en': { version: '1.1', files: FILES } } };
    expect(JSON.parse(adapter.files.get(REG) as string)).toEqual(want);
    const b = new InstalledStore(adapter as never, TROOT);
    expect(await b.load()).toEqual(want);
    expect(await b.hasPair('uk-en', '1.1')).toBe(true);
    expect(await b.hasEngine(SHA_E)).toBe(true);
    expect(await b.hasEngine(SHA_A)).toBe(false);
    expect(await b.hasPair('uk-en', '1.0')).toBe(false);
    expect(await b.hasPair('en-uk', '1.1')).toBe(false);
  });

  it('writes tmp → remove → rename', async () => {
    const adapter = new TestAdapter();
    const s = new InstalledStore(adapter as never, TROOT);
    await s.markEngine(SHA_E, 7);
    adapter.calls = [];
    await s.markPair('uk-en', '1.1', FILES);
    const ops = adapter.calls.filter((c) => /^(write|remove|rename) /.test(c));
    expect(ops).toEqual([`write ${REG}.tmp`, `remove ${REG}`, `rename ${REG}.tmp`]);
    expect(adapter.files.has(`${REG}.tmp`)).toBe(false);
  });

  it('a failed write keeps the old registry in force and later writes still work', async () => {
    const adapter = new TestAdapter();
    const s = new InstalledStore(adapter as never, TROOT);
    await s.markEngine(SHA_E, 7);
    adapter.failOn('rename', `${REG}.tmp`);
    await expect(s.markPair('uk-en', '1.1', FILES)).rejects.toThrow();
    expect(await s.sizes()).toEqual([]);
    // the interrupted write left only the tmp; a fresh store recovers from it
    expect(adapter.files.has(REG)).toBe(false);
    await s.markPair('de-en', '1.0', FILES);
    expect(Object.keys(JSON.parse(adapter.files.get(REG) as string).pairs)).toEqual(['de-en']);
  });

  it('recovers from a tmp left by an interrupted write when the main file is gone', async () => {
    const adapter = new TestAdapter();
    await adapter.mkdir(TROOT);
    await placeEngine(adapter);
    adapter.files.set(`${REG}.tmp`, JSON.stringify({ version: 1, engine: { sha256: SHA_E, size: 7 }, pairs: {} }));
    expect(await new InstalledStore(adapter as never, TROOT).hasEngine(SHA_E)).toBe(true);
  });

  it('a listed file that is missing or the wrong size makes the pair not installed', async () => {
    const adapter = new TestAdapter();
    await place(adapter, 'uk-en', '1.1');
    const s = new InstalledStore(adapter as never, TROOT);
    await s.markPair('uk-en', '1.1', FILES);
    expect(await s.hasPair('uk-en', '1.1')).toBe(true);
    adapter.files.set(modelPath(TROOT, 'uk-en', '1.1', FILES[1].name), new ArrayBuffer(5));
    expect(await s.hasPair('uk-en', '1.1')).toBe(false);
    expect((await s.load()).pairs).toEqual({});
    adapter.files.delete(modelPath(TROOT, 'uk-en', '1.1', FILES[1].name));
    expect(await s.hasPair('uk-en', '1.1')).toBe(false);
  });

  it('a missing engine file makes the engine not installed', async () => {
    const adapter = new TestAdapter();
    const s = new InstalledStore(adapter as never, TROOT);
    await s.markEngine(SHA_E, 7);
    expect(await s.hasEngine(SHA_E)).toBe(false);
    expect((await s.load()).engine).toBeNull();
    await placeEngine(adapter, SHA_E, 8);
    expect(await s.hasEngine(SHA_E)).toBe(false);
  });

  it('removePair deletes the pair folder and its entry, keeping the engine for the other pair', async () => {
    const adapter = new TestAdapter();
    await place(adapter, 'uk-en', '1.1');
    await place(adapter, 'en-uk', '2.2');
    await placeEngine(adapter);
    const s = new InstalledStore(adapter as never, TROOT);
    await s.markEngine(SHA_E, 7);
    await s.markPair('uk-en', '1.1', FILES);
    await s.markPair('en-uk', '2.2', FILES);
    await s.removePair('uk-en');
    expect(adapter.under(`${TROOT}/models/uk-en`)).toEqual([]);
    expect(adapter.folders.has(`${TROOT}/models/uk-en`)).toBe(false);
    expect(adapter.under(`${TROOT}/models/en-uk`)).toHaveLength(2);
    expect(await s.hasEngine(SHA_E)).toBe(true);
    const disk = parseInstalled(adapter.files.get(REG) as string)!;
    expect(Object.keys(disk.pairs)).toEqual(['en-uk']);
    expect(disk.engine).not.toBeNull();
  });

  it('removing the last pair removes the engine too', async () => {
    const adapter = new TestAdapter();
    await place(adapter, 'uk-en', '1.1');
    await placeEngine(adapter);
    const s = new InstalledStore(adapter as never, TROOT);
    await s.markEngine(SHA_E, 7);
    await s.markPair('uk-en', '1.1', FILES);
    await s.removePair('uk-en');
    expect(adapter.under(TROOT)).toEqual([REG]);
    expect(parseInstalled(adapter.files.get(REG) as string)).toEqual({ version: 1, engine: null, pairs: {} });
  });

  it('keepEngine keeps the engine even with the last pair gone', async () => {
    const adapter = new TestAdapter();
    await place(adapter, 'uk-en', '1.1');
    await placeEngine(adapter);
    const s = new InstalledStore(adapter as never, TROOT);
    await s.markEngine(SHA_E, 7);
    await s.markPair('uk-en', '1.1', FILES);
    await s.removePair('uk-en', { keepEngine: true });
    expect(await s.hasEngine(SHA_E)).toBe(true);
    expect(adapter.under(`${TROOT}/engine`)).toHaveLength(1);
  });

  it('sizes() lists recorded pairs with their bytes', async () => {
    const adapter = new TestAdapter();
    const s = new InstalledStore(adapter as never, TROOT);
    await s.markPair('uk-en', '1.1', FILES);
    await s.markPair('de-en', '1.0', [FILES[0]]);
    await s.markEngine(SHA_E, 7);
    expect(await s.sizes()).toEqual([
      { key: 'de-en', bytes: 10 },
      { key: 'uk-en', bytes: 14 },
    ]);
    expect(await s.engineSize()).toBe(7);
  });

  it('removeFolder refuses paths outside the root', async () => {
    const s = new InstalledStore(new TestAdapter() as never, TROOT);
    for (const p of ['.obsidian/plugins/margin-reader', `${TROOT}/../x`, TROOT, `${TROOT}/models/./x`]) {
      await expect(s.removeFolder(p)).rejects.toThrow(/refusing/);
    }
  });

  it('rejects malformed entries instead of writing them', async () => {
    const s = new InstalledStore(new TestAdapter() as never, TROOT);
    await expect(s.markPair('../x', '1.0', FILES)).rejects.toThrow();
    await expect(s.markPair('uk-en', '../1', FILES)).rejects.toThrow();
    await expect(s.markPair('uk-en', '1.0', [])).rejects.toThrow();
    await expect(s.markEngine('nope', 7)).rejects.toThrow();
  });
});

describe('parseInstalled (strict)', () => {
  const good = { version: 1, engine: { sha256: SHA_E, size: 7 }, pairs: { 'uk-en': { version: '1.1', files: FILES }, 'zh-Hans-en': { version: '2.0', files: FILES } } };
  const variant = (f: (o: any) => void) => {
    const o = JSON.parse(JSON.stringify(good));
    f(o);
    return JSON.stringify(o);
  };

  it('accepts the documented shape', () => {
    expect(parseInstalled(JSON.stringify(good))).toEqual(good);
    expect(parseInstalled(JSON.stringify({ version: 1, engine: null, pairs: {} }))).toEqual({ version: 1, engine: null, pairs: {} });
  });

  it('rejects anything else as a whole', () => {
    const bad = [
      '',
      '{',
      'null',
      '[]',
      variant((o) => (o.version = 2)),
      variant((o) => delete o.engine),
      variant((o) => (o.engine = { sha256: 'xyz', size: 7 })),
      variant((o) => (o.engine.size = 0)),
      variant((o) => (o.pairs = [])),
      variant((o) => (o.pairs['../../x'] = o.pairs['uk-en'])),
      variant((o) => (o.pairs['uk-en'].version = '../1')),
      variant((o) => (o.pairs['uk-en'].version = 2)),
      variant((o) => (o.pairs['uk-en'].files = [])),
      variant((o) => (o.pairs['uk-en'].files[0].name = '../../../data.json')),
      variant((o) => (o.pairs['uk-en'].files[0].name = 'a/b.bin')),
      variant((o) => (o.pairs['uk-en'].files[0].name = 'x.bin.part')),
      variant((o) => (o.pairs['uk-en'].files[0].sha256 = 'A'.repeat(64))),
      variant((o) => (o.pairs['uk-en'].files[0].size = 1.5)),
      variant((o) => (o.pairs['uk-en'].files[0].size = -3)),
      variant((o) => o.pairs['uk-en'].files.push(o.pairs['uk-en'].files[0])),
    ];
    for (const t of bad) expect(parseInstalled(t), t).toBeNull();
  });

  it('a corrupt installed.json counts as empty, and the next write replaces it', async () => {
    const adapter = new TestAdapter();
    await adapter.mkdir(TROOT);
    await place(adapter, 'uk-en', '1.1');
    adapter.files.set(REG, '{"version":1,"engine":null,"pairs":{"uk-en":{"version":"1.1","files":[{"name":"../../data.json"');
    const s = new InstalledStore(adapter as never, TROOT);
    expect(await s.load()).toEqual({ version: 1, engine: null, pairs: {} });
    expect(await s.hasPair('uk-en', '1.1')).toBe(false);
    await s.markPair('uk-en', '1.1', FILES);
    expect(parseInstalled(adapter.files.get(REG) as string)?.pairs['uk-en'].version).toBe('1.1');
  });
});


describe('InstalledStore: T4 review', () => {
  it('markPair refuses file names that are not one plain segment, .part names, duplicates and bad hashes', async () => {
    const adapter = new TestAdapter();
    const s = new InstalledStore(adapter as never, TROOT);
    const bad = [
      [{ ...FILES[0], name: '../x.bin' }],
      [{ ...FILES[0], name: 'a/b.bin' }],
      [{ ...FILES[0], name: '..' }],
      [{ ...FILES[0], name: 'model.bin.part' }],
      [FILES[0], { ...FILES[1], name: FILES[0].name }],
      [{ ...FILES[0], sha256: 'xyz' }],
      [{ ...FILES[0], size: 0 }],
    ];
    for (const files of bad) await expect(s.markPair('uk-en', '1.1', files)).rejects.toThrow('invalid registry entry uk-en@1.1');
    expect(adapter.files.has(REG)).toBe(false);
    await s.markPair('uk-en', '1.1', FILES);
    expect(adapter.files.has(REG)).toBe(true);
  });

  it('every catalog pair key, version, file name and hash passes the registry rules', () => {
    expect(PAIRS.length).toBeGreaterThan(100);
    for (const p of PAIRS) {
      expect(isPairKey(pairKey(p.from, p.to)), pairKey(p.from, p.to)).toBe(true);
      expect(isVersion(p.version), `${p.from}-${p.to}@${p.version}`).toBe(true);
      for (const f of p.files) {
        expect(isFileName(f.name), f.name).toBe(true);
        expect(isSha256(f.sha256), f.name).toBe(true);
      }
    }
    expect(isSha256(ENGINE.file.sha256)).toBe(true);
    expect(isFileName(ENGINE.file.name)).toBe(true);
  });

  it('concurrent first reads share one read of installed.json', async () => {
    const adapter = new TestAdapter();
    await place(adapter, 'uk-en', '1.1');
    const w = new InstalledStore(adapter as never, TROOT);
    await w.markPair('uk-en', '1.1', FILES);
    adapter.calls = [];
    const s = new InstalledStore(adapter as never, TROOT);
    const got = await Promise.all([s.hasPair('uk-en', '1.1'), s.sizes(), s.engineSize(), s.load()]);
    expect(got[0]).toBe(true);
    expect(adapter.calls.filter((c) => c === `read ${REG}`)).toHaveLength(1);
  });
});

// ---- T7: startup sweep and Remove all ----
describe('InstalledStore.sweep', () => {
  async function scene() {
    const adapter = new TestAdapter();
    const store = new InstalledStore(adapter as never, TROOT);
    await place(adapter, 'uk-en', '1.1');
    await placeEngine(adapter);
    await store.markEngine(SHA_E, 7);
    await store.markPair('uk-en', '1.1', FILES);
    return { adapter, store };
  }

  it('removes .part files anywhere, unlisted engine and model folders, and a stale installed.json.tmp; keeps what the registry lists', async () => {
    const { adapter, store } = await scene();
    // Leftovers: a part file in a listed folder and one in an unlisted folder, an old engine, an
    // unlisted pair, an old version of a listed pair, a tmp beside a good registry.
    adapter.files.set(`${TROOT}/models/uk-en/1.1/lex.uken.bin.part`, new ArrayBuffer(3));
    await adapter.mkdir(`${TROOT}/engine/${'f'.repeat(12)}`);
    adapter.files.set(`${TROOT}/engine/${'f'.repeat(12)}/bergamot-translator.wasm.part`, new ArrayBuffer(3));
    await adapter.mkdir(`${TROOT}/models/en-de/1.0`);
    adapter.files.set(`${TROOT}/models/en-de/1.0/model.ende.bin`, new ArrayBuffer(3));
    await adapter.mkdir(`${TROOT}/models/uk-en/1.0`);
    adapter.files.set(`${TROOT}/models/uk-en/1.0/vocab.uken.spm`, new ArrayBuffer(3));
    adapter.files.set(`${REG}.tmp`, '{}');
    adapter.files.set(`${TROOT}/worker.js`, 'x');

    const removed = await store.sweep();

    expect(adapter.under(TROOT)).toEqual([
      `${TROOT}/engine/${SHA_E.slice(0, 12)}/bergamot-translator.wasm`,
      `${TROOT}/installed.json`,
      `${TROOT}/models/uk-en/1.1/model.uken.intgemm.alphas.bin`,
      `${TROOT}/models/uk-en/1.1/vocab.uken.spm`,
      `${TROOT}/worker.js`,
    ]);
    expect(adapter.folders.has(`${TROOT}/models/en-de`)).toBe(false);
    expect(adapter.folders.has(`${TROOT}/models/uk-en/1.0`)).toBe(false);
    expect(adapter.folders.has(`${TROOT}/engine/${'f'.repeat(12)}`)).toBe(false);
    expect(removed).toContain(`${REG}.tmp`);
    expect(removed).toContain(`${TROOT}/models/en-de`);
    expect(await store.hasPair('uk-en', '1.1')).toBe(true);
    expect(await store.hasEngine(SHA_E)).toBe(true);
  });

  it('a tmp with no installed.json is the newest registry: it is kept, and the folders it lists stay', async () => {
    const { adapter, store } = await scene();
    adapter.files.set(`${REG}.tmp`, adapter.files.get(REG) as string);
    adapter.files.delete(REG);
    await new InstalledStore(adapter as never, TROOT).sweep();
    expect(adapter.files.has(`${REG}.tmp`)).toBe(true);
    expect(adapter.under(`${TROOT}/models`)).toHaveLength(2);
    expect(adapter.under(`${TROOT}/engine`)).toHaveLength(1);
    void store;
  });

  it('an installed.json that cannot be read: only .part files go, no folder is touched', async () => {
    const { adapter } = await scene();
    adapter.files.set(REG, '{ not json');
    adapter.files.set(`${TROOT}/models/uk-en/1.1/x.part`, new ArrayBuffer(1));
    await adapter.mkdir(`${TROOT}/models/en-de/1.0`);
    await new InstalledStore(adapter as never, TROOT).sweep();
    expect(adapter.files.has(`${TROOT}/models/uk-en/1.1/x.part`)).toBe(false);
    expect(adapter.under(`${TROOT}/models/uk-en`)).toHaveLength(2);
    expect(adapter.folders.has(`${TROOT}/models/en-de/1.0`)).toBe(true);
    expect(adapter.under(`${TROOT}/engine`)).toHaveLength(1);
  });

  it('no translation folder: nothing is listed or removed', async () => {
    const adapter = new TestAdapter();
    expect(await new InstalledStore(adapter as never, TROOT).sweep()).toEqual([]);
    expect(adapter.calls.filter((c) => c.startsWith('list') || c.startsWith('remove') || c.startsWith('rmdir'))).toEqual([]);
  });

  it('runs between registry writes (never sees a half-written registry)', async () => {
    const { adapter, store } = await scene();
    const write = store.markPair('en-de', '1.0', FILES);
    await place(adapter, 'en-de', '1.0');
    const sweep = store.sweep();
    await Promise.all([write, sweep]);
    expect(await store.hasPair('en-de', '1.0')).toBe(true);
    expect(adapter.files.has(`${REG}.tmp`)).toBe(false);
  });
});

describe('InstalledStore.removeAll', () => {
  it('empties the registry and removes every model and the engine', async () => {
    const adapter = new TestAdapter();
    const store = new InstalledStore(adapter as never, TROOT);
    await place(adapter, 'uk-en', '1.1');
    await place(adapter, 'en-de', '1.0');
    await placeEngine(adapter);
    await store.markEngine(SHA_E, 7);
    await store.markPair('uk-en', '1.1', FILES);
    await store.removeAll();
    expect(adapter.under(TROOT)).toEqual([`${TROOT}/installed.json`]);
    expect(parseInstalled(adapter.files.get(REG) as string)).toEqual({ version: 1, engine: null, pairs: {} });
    expect(await store.sizes()).toEqual([]);
    expect(await store.engineSize()).toBeNull();
  });
});
