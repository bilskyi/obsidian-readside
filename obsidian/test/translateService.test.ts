import { describe, expect, it } from 'vitest';
import { ENGINE } from '../../src/translate/catalog';
import type { ModelFile } from '../../src/translate/bergamot/protocol';
import type { DownloadProgress } from '../../src/translate/types';
import { CHECKSUM_MISMATCH } from '../src/translate/downloads';
import { engineDir, enginePath, modelPath, pairDir, parseInstalled } from '../src/translate/installed';
import { ObsidianTranslateHost, readEngineWasm, type TranslateClient } from '../src/translate/service';
import { ENGINE_DAMAGED, PAIR_REMOVED } from '../src/translate/service';
import { SharedJobs } from '../src/translate/shared';
import { FakeFetcher, TROOT, TestAdapter, bodyOf, fakeSha256, pairOf, pause } from './translateFakes';

const UK = 'Це книжка про історію України, її мову та культуру за останні сто років.';
const EN = 'This is a book about the history of the country and its culture over the last hundred years.';
const UKEN = pairOf('uk', 'en');
const ENDE = pairOf('en', 'de');
const sum = (fs: { size: number }[]) => fs.reduce((s, f) => s + f.size, 0);

class FakeClient implements TranslateClient {
  ensure: { key: string; from: string; to: string; files: () => Promise<ModelFile[]> }[] = [];
  calls: { legs: readonly string[]; texts: readonly string[] }[] = [];
  disposed = false;
  async ensureModel(key: string, from: string, to: string, files: () => Promise<ModelFile[]>) {
    this.ensure.push({ key, from, to, files });
    await files(); // a real client reads (and transfers) the bytes when it loads
  }
  async translate(legs: readonly string[], texts: readonly string[]) {
    this.calls.push({ legs, texts });
    return texts.map((t) => `[${legs.join('>')}] ${t}`);
  }
  dispose() {
    this.disposed = true;
  }
}

function setup(target = 'en') {
  const adapter = new TestAdapter();
  const fetcher = new FakeFetcher();
  const client = new FakeClient();
  const notices: string[] = [];
  const saved: string[] = [];
  const host = new ObsidianTranslateHost({
    adapter: adapter as never,
    root: TROOT,
    fetcher,
    settings: () => ({ target, hover: true }),
    saveTarget: (c) => saved.push(c),
    client,
    notice: (m) => notices.push(m),
    sha256: fakeSha256,
  });
  return { adapter, fetcher, client, host, notices, saved };
}

async function install(host: ObsidianTranslateHost, from: string, to: string) {
  const out = await host.translate({ text: from === 'uk' ? UK : EN, from, to });
  if (out.kind !== 'needsDownload') throw new Error(`expected an offer, got ${out.kind}`);
  await host.download(out.offer, {});
}

describe('ObsidianTranslateHost: translate', () => {
  it('Ukrainian text, target en, nothing installed → needsDownload for the engine + uk-en, with no request', async () => {
    const { host, fetcher } = setup('en');
    const out = await host.translate({ text: UK, from: 'auto' });
    expect(out).toEqual({
      kind: 'needsDownload',
      offer: {
        from: 'uk',
        to: 'en',
        bytes: ENGINE.file.size + sum(UKEN.files),
        parts: [
          { label: 'Translation engine', bytes: ENGINE.file.size },
          { label: 'Українська → English', bytes: sum(UKEN.files) },
        ],
      },
    });
    expect(fetcher.total()).toBe(0);
  });

  it('a short selection is detected together with its context', async () => {
    const { host } = setup('en');
    const out = await host.translate({ text: 'книжка', context: UK });
    expect(out).toMatchObject({ kind: 'needsDownload', offer: { from: 'uk', to: 'en' } });
    expect(await host.translate({ text: 'книжка' })).toEqual({ kind: 'unsupported', from: null, to: 'en' });
  });

  it('same source and target → same; a language outside the catalog → unsupported', async () => {
    const { host } = setup('en');
    expect(await host.translate({ text: EN })).toEqual({ kind: 'same', lang: 'en' });
    expect(await host.translate({ text: UK, to: 'xx' })).toEqual({ kind: 'unsupported', from: 'uk', to: 'xx' });
    expect(await host.translate({ text: 'whatever', from: 'xx', to: 'en' })).toEqual({ kind: 'unsupported', from: 'xx', to: 'en' });
  });

  it('a pair without English offers both legs', async () => {
    const { host } = setup('de');
    const out = await host.translate({ text: UK });
    expect(out.kind).toBe('needsDownload');
    if (out.kind !== 'needsDownload') return;
    expect(out.offer.bytes).toBe(ENGINE.file.size + sum(UKEN.files) + sum(ENDE.files));
    expect(out.offer.parts.map((p) => p.label)).toEqual(['Translation engine', 'Українська → English', 'English → Deutsch']);
  });

  it('target, languages, hover and default target come from the settings', () => {
    const { host, saved } = setup('uk');
    expect(host.target()).toBe('uk');
    expect(host.hoverEnabled()).toBe(true);
    expect(host.languages().find((l) => l.code === 'uk')).toEqual({ code: 'uk', name: 'Українська' });
    host.setDefaultTarget('de');
    host.setDefaultTarget('xx');
    expect(saved).toEqual(['de']);
  });
});

describe('ObsidianTranslateHost: download', () => {
  it('reports increasing progress, ends installed, then translates through the client', async () => {
    const { host, adapter, fetcher, client, notices } = setup('en');
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    const seen: DownloadProgress[] = [];
    await host.download(out.offer, { onProgress: (p) => seen.push(p) });

    expect(seen.length).toBeGreaterThan(5);
    for (let i = 1; i < seen.length; i++) expect(seen[i].received).toBeGreaterThan(seen[i - 1].received);
    expect(seen.every((p) => p.total === out.offer.bytes)).toBe(true);
    expect(seen.at(-1)).toEqual({ received: out.offer.bytes, total: out.offer.bytes });

    const reg = parseInstalled(adapter.files.get(`${TROOT}/installed.json`) as string)!;
    expect(reg.engine).toEqual({ sha256: ENGINE.file.sha256, size: ENGINE.file.size });
    expect(reg.pairs['uk-en']).toEqual({ version: UKEN.version, files: UKEN.files.map(({ name, sha256, size }) => ({ name, sha256, size })) });
    expect(adapter.files.has(enginePath(TROOT, ENGINE.file.sha256))).toBe(true);
    for (const f of UKEN.files) expect(adapter.files.has(modelPath(TROOT, 'uk-en', UKEN.version, f.name))).toBe(true);
    expect([...adapter.files.keys()].some((k) => k.endsWith('.part'))).toBe(false);
    expect(fetcher.total()).toBe(1 + UKEN.files.length);
    // the card that asked shows the result: no app-wide Notice on top of it
    expect(notices).toEqual([]);

    expect(await host.translate({ text: UK })).toEqual({ kind: 'done', text: `[uk-en] ${UK}`, from: 'uk', to: 'en' });
    expect(client.ensure.map((e) => [e.key, e.from, e.to])).toEqual([['uk-en', 'uk', 'en']]);
    expect(client.calls).toEqual([{ legs: ['uk-en'], texts: [UK] }]);
    // nothing more was fetched for the translation
    expect(fetcher.total()).toBe(1 + UKEN.files.length);
  });

  it('a second download of the same pair while running joins it: one request per file', async () => {
    const { host, fetcher } = setup('en');
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    const a: number[] = [];
    const b: number[] = [];
    const p1 = host.download(out.offer, { onProgress: (p) => a.push(p.received) });
    await pause();
    await pause();
    const p2 = host.download(out.offer, { onProgress: (p) => b.push(p.received) });
    await Promise.all([p1, p2]);
    for (const n of fetcher.gets.values()) expect(n).toBe(1);
    expect(fetcher.total()).toBe(1 + UKEN.files.length);
    expect(b.length).toBeGreaterThan(1);
    expect(b[0]).toBeGreaterThan(0); // the joiner starts from where the download is
    expect(b.at(-1)).toBe(out.offer.bytes);
  });

  it('two pairs that share the engine and a leg fetch each file once', async () => {
    const { host, fetcher, adapter } = setup('en');
    const toEn = await host.translate({ text: UK, to: 'en' });
    const toDe = await host.translate({ text: UK, to: 'de' });
    if (toEn.kind !== 'needsDownload' || toDe.kind !== 'needsDownload') throw new Error('no offer');
    await Promise.all([host.download(toEn.offer, {}), host.download(toDe.offer, {})]);
    for (const n of fetcher.gets.values()) expect(n).toBe(1);
    expect(fetcher.total()).toBe(1 + UKEN.files.length + ENDE.files.length);
    const reg = parseInstalled(adapter.files.get(`${TROOT}/installed.json`) as string)!;
    expect(Object.keys(reg.pairs).sort()).toEqual(['en-de', 'uk-en']);
    expect(await host.translate({ text: UK, to: 'de' })).toMatchObject({ kind: 'done', text: `[uk-en>en-de] ${UK}` });
  });

  it('cancel removes partial files, records nothing, and a retry starts afresh', async () => {
    const { host, adapter, fetcher } = setup('en');
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    const ctl = new AbortController();
    let seen = 0;
    const p = host.download(out.offer, {
      signal: ctl.signal,
      onProgress: (pr) => {
        // stop once the engine is in and the first model file is under way
        if (pr.received > ENGINE.file.size + 2_000_000 && !seen++) ctl.abort();
      },
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await pause();
    await pause();
    expect(adapter.under(`${TROOT}/models`)).toEqual([]);
    expect(host.downloading()).toBe(false);
    // the engine finished before the cancel: it stays, verified and recorded
    expect(parseInstalled(adapter.files.get(`${TROOT}/installed.json`) as string)?.pairs).toEqual({});
    expect([...adapter.files.keys()].some((k) => k.endsWith('.part'))).toBe(false);

    const before = fetcher.total();
    const again = await host.translate({ text: UK });
    if (again.kind !== 'needsDownload') throw new Error('no offer');
    expect(again.offer.parts.map((x) => x.label)).toEqual(['Українська → English']);
    await host.download(again.offer, {});
    expect(fetcher.total() - before).toBe(UKEN.files.length);
    expect(await host.translate({ text: UK })).toMatchObject({ kind: 'done' });
  });

  it('cancel in the middle of a model file leaves no file of that leg', async () => {
    const { host, adapter, fetcher } = setup('en');
    await install(host, 'en', 'de'); // engine in place
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    const ctl = new AbortController();
    // abort during the second file of the leg, after the first one landed
    const first = UKEN.files[0].size;
    const p = host.download(out.offer, {
      signal: ctl.signal,
      onProgress: (pr) => pr.received > first + 100 && ctl.abort(),
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await pause();
    await pause();
    expect(adapter.under(`${TROOT}/models/uk-en`)).toEqual([]);
    expect(adapter.under(`${TROOT}/models/en-de`)).toHaveLength(ENDE.files.length);
    expect(fetcher.gets.get(UKEN.files[1].url)).toBe(1);
  });

  it('one joiner cancelling does not stop the download for the other', async () => {
    const { host } = setup('en');
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    const ctl = new AbortController();
    const p1 = host.download(out.offer, { signal: ctl.signal });
    const p2 = host.download(out.offer, {});
    await pause();
    ctl.abort();
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
    await expect(p2).resolves.toBeUndefined();
    expect(await host.translate({ text: UK })).toMatchObject({ kind: 'done' });
  });

  it('an HTTP error fails with its reason and leaves no file of the leg', async () => {
    const { host, adapter, fetcher } = setup('en');
    fetcher.serve(UKEN.files[1].url, { status: 500 });
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    await expect(host.download(out.offer, {})).rejects.toThrow('The download failed: HTTP 500');
    expect(adapter.under(`${TROOT}/models`)).toEqual([]);
    expect(await host.translate({ text: UK })).toMatchObject({ kind: 'needsDownload' });
  });

  it('a checksum mismatch discards the file and fails', async () => {
    const { host, adapter, fetcher } = setup('en');
    fetcher.serve(UKEN.files[0].url, { body: bodyOf(UKEN.files[0], 'evil') });
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    await expect(host.download(out.offer, {})).rejects.toThrow(CHECKSUM_MISMATCH);
    expect(adapter.under(`${TROOT}/models`)).toEqual([]);
    expect(parseInstalled(adapter.files.get(`${TROOT}/installed.json`) as string)?.pairs).toEqual({});
  });

  it('a pair that is not in the catalog is refused', async () => {
    const { host, fetcher } = setup('en');
    await expect(host.download({ from: 'xx', to: 'en', bytes: 1, parts: [] }, {})).rejects.toThrow("This pair isn't available offline");
    expect(fetcher.total()).toBe(0);
  });

  it('dispose cancels a running download (no partial files) and disposes the client', async () => {
    const { host, adapter, client } = setup('en');
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    const p = host.download(out.offer, {});
    await pause();
    host.dispose();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await pause();
    await pause();
    expect([...adapter.files.keys()].filter((k) => k.startsWith(TROOT) && !k.endsWith('installed.json'))).toEqual([]);
    expect(client.disposed).toBe(true);
    await expect(host.translate({ text: UK })).rejects.toThrow('Translation was shut down');
  });
});

describe('ObsidianTranslateHost: model bytes', () => {
  it('model files are fresh buffers on every call (a transfer does not break the next load)', async () => {
    const { host, client } = setup('en');
    await install(host, 'uk', 'en');
    await host.translate({ text: UK });
    const files = client.ensure[0].files;
    const a = await files();
    const sizes = a.map((f) => f.bytes.byteLength);
    expect(sizes).toEqual(UKEN.files.map((f) => f.size));
    expect(a.map((f) => [f.type, f.name])).toEqual(UKEN.files.map((f) => [f.type, f.name]));
    structuredClone(a, { transfer: a.map((f) => f.bytes) }); // detaches them, as postMessage does
    expect(a[0].bytes.byteLength).toBe(0);
    const b = await files();
    expect(b.map((f) => f.bytes.byteLength)).toEqual(sizes);
    expect(b[0].bytes).not.toBe(a[0].bytes);
  });

  it('a model file damaged after install is reported, not loaded', async () => {
    const { host, adapter, client } = setup('en');
    await install(host, 'uk', 'en');
    await host.translate({ text: UK });
    const p = modelPath(TROOT, 'uk-en', UKEN.version, UKEN.files[2].name);
    adapter.files.set(p, new ArrayBuffer(3));
    await expect(client.ensure[0].files()).rejects.toThrow(/is damaged/);
  });

  it('readEngineWasm reads the installed engine afresh each call and refuses when it is missing', async () => {
    const { host, adapter } = setup('en');
    await expect(readEngineWasm(adapter as never, TROOT)).rejects.toThrow('The translation engine is not installed');
    await install(host, 'uk', 'en');
    const a = await readEngineWasm(adapter as never, TROOT, fakeSha256);
    const b = await readEngineWasm(adapter as never, TROOT, fakeSha256);
    expect(a.byteLength).toBe(ENGINE.file.size);
    expect(b).not.toBe(a);
    structuredClone(a, { transfer: [a] });
    expect((await readEngineWasm(adapter as never, TROOT, fakeSha256)).byteLength).toBe(ENGINE.file.size);
  });
});

describe('ObsidianTranslateHost: translateWord', () => {
  it('says not installed (or unavailable) when the pair is not installed and never fetches', async () => {
    const { host, fetcher, client } = setup('en');
    expect(await host.translateWord('книжка', 'uk', 'en')).toEqual({ kind: 'notInstalled' });
    expect(await host.translateWord('x', 'xx', 'en')).toEqual({ kind: 'unavailable' });
    expect(await host.translateWord('  ', 'uk', 'en')).toEqual({ kind: 'unavailable' });
    expect(fetcher.total()).toBe(0);
    expect(client.calls).toEqual([]);
  });

  it('translates through the client once and then answers from the cache', async () => {
    const { host, client } = setup('en');
    await install(host, 'uk', 'en');
    expect(await host.translateWord('книжка', 'uk', 'en')).toEqual({ kind: 'done', text: '[uk-en] книжка' });
    expect(await host.translateWord(' книжка ', 'uk', 'en')).toEqual({ kind: 'done', text: '[uk-en] книжка' });
    expect(client.calls).toEqual([{ legs: ['uk-en'], texts: ['книжка'] }]);
  });

  it('removing a pair drops its cached words and its files', async () => {
    const { host, client, adapter } = setup('en');
    await install(host, 'uk', 'en');
    await host.translateWord('книжка', 'uk', 'en');
    await host.removePair('uk-en');
    expect(await host.translateWord('книжка', 'uk', 'en')).toEqual({ kind: 'notInstalled' });
    expect(client.calls).toHaveLength(1);
    expect(adapter.under(TROOT)).toEqual([`${TROOT}/installed.json`]);
    expect(await host.installedSizes()).toEqual([]);
  });

  it('removePair is refused while that pair downloads, and keeps the engine while any download runs', async () => {
    const { host, adapter } = setup('en');
    await install(host, 'en', 'de');
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    const p = host.download(out.offer, {});
    await pause();
    await expect(host.removePair('uk-en')).rejects.toThrow('uk-en is still downloading');
    await host.removePair('en-de');
    expect(adapter.files.has(enginePath(TROOT, ENGINE.file.sha256))).toBe(true);
    await p;
    expect(await host.translate({ text: UK })).toMatchObject({ kind: 'done' });
  });
});


describe('SharedJobs', () => {
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((a, b) => {
      resolve = a;
      reject = b;
    });
    return { promise, resolve, reject };
  };

  it('a joiner gets the latest progress at once', async () => {
    const jobs = new SharedJobs<void, number>();
    const d = deferred();
    let emit!: (n: number) => void;
    const p1 = jobs.join('k', (_s, e) => ((emit = e), d.promise));
    await pause();
    emit(42);
    const seen: number[] = [];
    const p2 = jobs.join('k', () => Promise.reject(new Error('second start')), { onProgress: (n) => seen.push(n) });
    expect(seen).toEqual([42]);
    d.resolve();
    await Promise.all([p1, p2]);
  });

  it('after every joiner cancelled, a new join starts a fresh job, but only once the old one has settled', async () => {
    const jobs = new SharedJobs<void, number>();
    const first = deferred();
    let firstSignal!: AbortSignal;
    const ctl = new AbortController();
    const p1 = jobs.join('k', (s) => ((firstSignal = s), first.promise), { signal: ctl.signal });
    await pause();
    ctl.abort();
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
    expect(firstSignal.aborted).toBe(true);
    expect(jobs.has('k')).toBe(false);

    let started = 0;
    const p2 = jobs.join('k', async () => {
      started++;
    });
    await pause();
    expect(started).toBe(0); // the cancelled job is still cleaning up
    first.reject(new Error('cleaned up'));
    await p2;
    expect(started).toBe(1);
  });

  it('a failed job is forgotten before its joiners hear, so a retry starts afresh', async () => {
    const jobs = new SharedJobs<void, number>();
    let starts = 0;
    const retry = jobs.join('k', async () => {
      starts++;
      throw new Error('boom');
    });
    await expect(retry.catch((e) => {
      expect(jobs.has('k')).toBe(false);
      throw e;
    })).rejects.toThrow('boom');
    await jobs.join('k', async () => {
      starts++;
    });
    expect(starts).toBe(2);
  });
});


describe('ObsidianTranslateHost: background failures and cleanup (T4 review)', () => {
  it('a failed download with its card still open: the card says why, no Notice; a cancel shows none', async () => {
    const { host, fetcher, notices } = setup('en');
    fetcher.serve(UKEN.files[1].url, { status: 503 });
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    await expect(host.download(out.offer, {})).rejects.toThrow('The download failed: HTTP 503');
    await pause();
    expect(notices).toEqual([]);

    notices.length = 0;
    fetcher.overrides.clear();
    const again = await host.translate({ text: UK });
    if (again.kind !== 'needsDownload') throw new Error('no offer');
    const ctl = new AbortController();
    const p = host.download(again.offer, { signal: ctl.signal, onProgress: (pr) => pr.received > 0 && ctl.abort() });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await pause();
    await pause();
    expect(notices).toEqual([]);
  });

  it('dispose during a download shows no failure Notice', async () => {
    const { host, notices } = setup('en');
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    const p = host.download(out.offer, {});
    await pause();
    host.dispose();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await pause();
    expect(notices).toEqual([]);
  });

  it('a newer leg version replaces the old one: the old version folder is removed', async () => {
    const { host, adapter } = setup('en');
    await install(host, 'en', 'de'); // engine in place
    // an older uk-en, recorded and on disk
    const old = '1.0';
    await adapter.mkdir(pairDir(TROOT, 'uk-en', old));
    for (const f of UKEN.files) adapter.files.set(modelPath(TROOT, 'uk-en', old, f.name), new ArrayBuffer(f.size));
    const reg = parseInstalled(adapter.files.get(`${TROOT}/installed.json`) as string)!;
    reg.pairs['uk-en'] = { version: old, files: UKEN.files.map(({ name, sha256, size }) => ({ name, sha256, size })) };
    adapter.files.set(`${TROOT}/installed.json`, JSON.stringify(reg));
    // a fresh host reads the edited registry
    const fresh = new ObsidianTranslateHost({
      adapter: adapter as never, root: TROOT, fetcher: new FakeFetcher(), settings: () => ({ target: 'en', hover: true }),
      saveTarget: () => {}, client: new FakeClient(), notice: () => {}, sha256: fakeSha256,
    });
    await install(fresh, 'uk', 'en');
    expect(adapter.under(pairDir(TROOT, 'uk-en', old))).toEqual([]);
    expect(adapter.folders.has(pairDir(TROOT, 'uk-en', old))).toBe(false);
    expect(adapter.under(pairDir(TROOT, 'uk-en', UKEN.version))).toHaveLength(UKEN.files.length);
    expect(parseInstalled(adapter.files.get(`${TROOT}/installed.json`) as string)!.pairs['uk-en'].version).toBe(UKEN.version);
  });

  it('a newer engine replaces the old one: the old engine folder is removed', async () => {
    const { host, adapter } = setup('en');
    const oldSha = 'a'.repeat(64);
    await adapter.mkdir(engineDir(TROOT, oldSha));
    adapter.files.set(enginePath(TROOT, oldSha), new ArrayBuffer(9));
    await adapter.mkdir(TROOT);
    adapter.files.set(`${TROOT}/installed.json`, JSON.stringify({ version: 1, engine: { sha256: oldSha, size: 9 }, pairs: {} }));
    await install(host, 'uk', 'en');
    expect(adapter.folders.has(engineDir(TROOT, oldSha))).toBe(false);
    expect(adapter.files.has(enginePath(TROOT, oldSha))).toBe(false);
    expect(adapter.files.has(enginePath(TROOT, ENGINE.file.sha256))).toBe(true);
    expect(parseInstalled(adapter.files.get(`${TROOT}/installed.json`) as string)!.engine).toEqual({
      sha256: ENGINE.file.sha256,
      size: ENGINE.file.size,
    });
  });

  it('a failed engine download removes its folder and records nothing', async () => {
    const { host, adapter, fetcher, notices } = setup('en');
    fetcher.serve(ENGINE.file.url, { body: bodyOf(ENGINE.file, 'tampered') });
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    await expect(host.download(out.offer, {})).rejects.toThrow(CHECKSUM_MISMATCH);
    expect(adapter.folders.has(engineDir(TROOT, ENGINE.file.sha256))).toBe(false);
    expect(adapter.under(`${TROOT}/engine`)).toEqual([]);
    expect(adapter.under(`${TROOT}/models`)).toEqual([]);
    expect(adapter.files.has(`${TROOT}/installed.json`)).toBe(false);
    expect(notices).toEqual([]); // the card shows the checksum error itself
  });

  it('removePair is refused for a leg a running download still needs, even before it is reached', async () => {
    const { host } = setup('de');
    await install(host, 'en', 'de');
    // uk → de goes uk-en (queued behind nothing installed) then en-de (installed)
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    const p = host.download(out.offer, {});
    await pause();
    await expect(host.removePair('en-de')).rejects.toThrow('en-de is still downloading');
    await p;
    await host.removePair('en-de');
    expect(host.downloading()).toBe(false);
  });
});

describe('ObsidianTranslateHost: background downloads (T5)', () => {
  function withNotices() {
    const base = setup('en');
    const shown: { messages: string[]; hidden: boolean }[] = [];
    const host = new ObsidianTranslateHost({
      adapter: base.adapter as never,
      root: TROOT,
      fetcher: base.fetcher,
      settings: () => ({ target: 'en', hover: true }),
      saveTarget: () => {},
      client: base.client,
      notice: (m) => base.notices.push(m),
      progressNotice: (m) => {
        const n = { messages: [m], hidden: false };
        shown.push(n);
        return { setMessage: (x: string) => n.messages.push(x), hide: () => void (n.hidden = true) };
      },
      sha256: fakeSha256,
    });
    return { ...base, host, shown };
  }

  it('a card closing mid-download: the download carries on with a progress Notice, hidden at the end', async () => {
    const { host, shown, notices } = withNotices();
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    const card = new AbortController();
    const p = host.download(out.offer, { signal: card.signal });
    await pause();
    expect(host.isDownloading('uk', 'en')).toBe(true);
    host.background(out.offer); // the card closes: the host joins first …
    card.abort(); // … then the card leaves
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(shown).toHaveLength(1);
    await waitUntil(() => !host.isDownloading('uk', 'en'));
    await pause();
    expect(shown[0].messages[0]).toBe('Українська → English: Downloading…');
    expect(shown[0].messages.some((m) => /^Українська → English: Downloading… [\d.]+ of [\d.]+ MB$/.test(m))).toBe(true);
    expect(shown[0].hidden).toBe(true);
    expect(notices).toEqual(['Українська → English is downloaded. Translation now works offline.']);
    expect(await host.translate({ text: UK })).toMatchObject({ kind: 'done' });
  });

  it('a new card for that pair takes over: the Notice goes, the download goes on', async () => {
    const { host, shown } = withNotices();
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    const first = new AbortController();
    const p1 = host.download(out.offer, { signal: first.signal });
    await pause();
    host.background(out.offer);
    first.abort();
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
    const seen: number[] = [];
    const p2 = host.download(out.offer, { onProgress: (pr) => seen.push(pr.received) });
    expect(shown[0].hidden).toBe(true);
    await p2;
    expect(seen.at(-1)).toBe(out.offer.bytes);
    expect(await host.translate({ text: UK })).toMatchObject({ kind: 'done' });
  });

  it('a download a new card took back says nothing app-wide when it ends (that card shows it)', async () => {
    const { host, notices } = withNotices();
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    const first = new AbortController();
    const p1 = host.download(out.offer, { signal: first.signal });
    await pause();
    host.background(out.offer);
    first.abort();
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
    await host.download(out.offer, {});
    await pause();
    await pause();
    expect(notices).toEqual([]);
  });

  it('a background download that fails says why exactly once', async () => {
    const { host, notices, fetcher } = withNotices();
    fetcher.serve(UKEN.files[1].url, { status: 500 });
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    const card = new AbortController();
    const p = host.download(out.offer, { signal: card.signal });
    await pause();
    host.background(out.offer);
    card.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await waitUntil(() => !host.isDownloading('uk', 'en'));
    await pause();
    await pause();
    expect(notices).toEqual(['Українська → English: The download failed: HTTP 500']);
  });

  it('background() for a pair that is not downloading does nothing', async () => {
    const { host, shown, fetcher } = withNotices();
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    host.background(out.offer);
    expect(shown).toEqual([]);
    expect(fetcher.total()).toBe(0);
    expect(host.isDownloading('uk', 'en')).toBe(false);
  });

  it('a background download that fails hides its progress Notice and says why', async () => {
    const { host, shown, notices, fetcher } = withNotices();
    fetcher.serve(UKEN.files[1].url, { status: 500 });
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    const card = new AbortController();
    const p = host.download(out.offer, { signal: card.signal });
    await pause();
    host.background(out.offer);
    card.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await waitUntil(() => shown[0]?.hidden === true);
    expect(notices).toEqual(['Українська → English: The download failed: HTTP 500']);
  });

  it('dispose hides a background Notice and cancels the download', async () => {
    const { host, shown, adapter } = withNotices();
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    const card = new AbortController();
    const p = host.download(out.offer, { signal: card.signal });
    await pause();
    host.background(out.offer);
    card.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    host.dispose();
    expect(shown[0].hidden).toBe(true);
    await pause();
    await pause();
    expect(adapter.under(`${TROOT}/models`)).toEqual([]);
  });
});

async function waitUntil(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await pause();
  }
}

// ---- T7: startup sweep and Remove all ----
describe('ObsidianTranslateHost: sweep and removeAll (T7)', () => {
  const offerUkEn = async (host: ObsidianTranslateHost) => {
    const out = await host.translate({ text: UK, from: 'uk', to: 'en' });
    if (out.kind !== 'needsDownload') throw new Error(out.kind);
    return out.offer;
  };

  it('sweep removes leftovers; it is skipped while anything downloads', async () => {
    const { adapter, host } = setup('en');
    await adapter.mkdir(`${TROOT}/models/de-en/1.0`);
    adapter.files.set(`${TROOT}/models/de-en/1.0/model.bin.part`, new ArrayBuffer(1));
    const ctl = new AbortController();
    const running = host.download(await offerUkEn(host), { signal: ctl.signal });
    await host.sweep();
    expect(adapter.files.has(`${TROOT}/models/de-en/1.0/model.bin.part`)).toBe(true);
    ctl.abort();
    await running.catch(() => {});
    await pause();
    await host.sweep();
    expect(adapter.files.has(`${TROOT}/models/de-en/1.0/model.bin.part`)).toBe(false);
    expect(adapter.folders.has(`${TROOT}/models/de-en`)).toBe(false);
  });

  it('a download that starts during the sweep waits for it, and its files survive', async () => {
    const { adapter, host } = setup('en');
    await adapter.mkdir(`${TROOT}/models/de-en/1.0`);
    adapter.files.set(`${TROOT}/models/de-en/1.0/model.bin.part`, new ArrayBuffer(1));
    const offer = await offerUkEn(host);
    const sweep = host.sweep();
    const order: string[] = [];
    void sweep.then(() => order.push('swept'));
    const dl = host.download(offer, {
      onProgress: (p) => {
        if (p.received > 0 && !order.includes('bytes')) order.push('bytes');
      },
    });
    await dl;
    await sweep;
    expect(order[0]).toBe('swept');
    expect(adapter.files.has(`${TROOT}/models/de-en/1.0/model.bin.part`)).toBe(false);
  });

  it('while a (slow) sweep runs, a download requests nothing; it starts once the sweep is done', async () => {
    const { adapter, host, fetcher } = setup('en');
    await adapter.mkdir(`${TROOT}/models`);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const list = adapter.list.bind(adapter);
    adapter.list = async (p: string) => {
      await gate;
      return list(p);
    };
    const offer = await offerUkEn(host);
    const sweep = host.sweep();
    const dl = host.download(offer, {});
    for (let i = 0; i < 5; i++) await pause();
    expect(fetcher.total()).toBe(0);
    release();
    await sweep;
    await dl;
    expect(fetcher.total()).toBeGreaterThan(0);
    const out = await host.translate({ text: UK, from: 'uk', to: 'en' });
    expect(out.kind).toBe('done');
  });

  it('removeAll is refused while a download runs; afterwards it removes the pairs, the engine and the cached words', async () => {
    const { adapter, host, client } = setup('en');
    await install(host, 'uk', 'en');
    expect(await host.translateWord('книжка', 'uk', 'en')).toEqual({ kind: 'done', text: '[uk-en] книжка' });
    const ctl = new AbortController();
    const out = await host.translate({ text: EN, from: 'en', to: 'de' });
    if (out.kind !== 'needsDownload') throw new Error(out.kind);
    const running = host.download(out.offer, { signal: ctl.signal });
    await expect(host.removeAll()).rejects.toThrow('A download is still running');
    ctl.abort();
    await running.catch(() => {});
    await pause();
    await host.removeAll();
    expect(adapter.under(`${TROOT}/models`)).toEqual([]);
    expect(adapter.under(`${TROOT}/engine`)).toEqual([]);
    expect(await host.installedSizes()).toEqual([]);
    expect(await host.engineSize()).toBeNull();
    const calls = client.calls.length;
    expect(await host.translateWord('книжка', 'uk', 'en')).toEqual({ kind: 'notInstalled' });
    expect(client.calls.length).toBe(calls);
  });
});

import { vi } from 'vitest';
describe('ObsidianTranslateHost: translateWord signal (T6)', () => {
  it('hands the hover signal to the client, so a request the pointer left is dropped from its queue', async () => {
    const { host, client } = setup('en');
    await install(host, 'uk', 'en');
    const spy = vi.spyOn(client, 'translate');
    const ctl = new AbortController();
    await host.translateWord('книжка', 'uk', 'en', ctl.signal);
    expect(spy).toHaveBeenCalledWith(['uk-en'], ['книжка'], ctl.signal);
  });
});

// ---- T7 review: one maintenance gate; downloading(key) from the call ----
describe('ObsidianTranslateHost: maintenance gate (T7 review)', () => {
  const gateRmdir = (adapter: TestAdapter) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rmdir = adapter.rmdir.bind(adapter);
    adapter.rmdir = async (p: string, r: boolean) => {
      await gate;
      return rmdir(p, r);
    };
    return release;
  };
  const offerFor = async (host: ObsidianTranslateHost, from: string, to: string, text: string) => {
    const out = await host.translate({ text, from, to });
    if (out.kind !== 'needsDownload') throw new Error(out.kind);
    return out.offer;
  };

  it('a download started while removePair is still removing waits for it; the engine is kept for it', async () => {
    const { adapter, host, fetcher } = setup('en');
    await install(host, 'en', 'de');
    const offer = await offerFor(host, 'uk', 'en', UK);
    const release = gateRmdir(adapter);
    const before = fetcher.total();
    const removing = host.removePair('en-de');
    const dl = host.download(offer, {});
    for (let i = 0; i < 5; i++) await pause();
    expect(fetcher.total()).toBe(before);
    release();
    await removing;
    await dl;
    expect(fetcher.total()).toBeGreaterThan(before);
    expect(fetcher.total()).toBe(before + UKEN.files.length); // the engine was kept: no second fetch of it
    expect((await host.translate({ text: UK, from: 'uk', to: 'en' })).kind).toBe('done');
  });

  it('a download started while removeAll is still removing waits for it, then fetches the engine again', async () => {
    const { adapter, host, fetcher } = setup('en');
    await install(host, 'en', 'de');
    const offer = await offerFor(host, 'uk', 'en', UK);
    const release = gateRmdir(adapter);
    const before = fetcher.total();
    const removing = host.removeAll();
    const dl = host.download(offer, {});
    for (let i = 0; i < 5; i++) await pause();
    expect(fetcher.total()).toBe(before);
    release();
    await removing;
    await dl;
    expect(fetcher.total()).toBe(before + 1 + UKEN.files.length);
    expect(await host.engineSize()).toBe(ENGINE.file.size);
  });

  it('folder work handed in at construction (the plugin’s startup sweep) holds downloads back too', async () => {
    const base = setup('en');
    let release!: () => void;
    const startup = new Promise<void>((r) => (release = r));
    const host = new ObsidianTranslateHost({
      adapter: base.adapter as never, root: TROOT, fetcher: base.fetcher, settings: () => ({ target: 'en', hover: true }),
      saveTarget: () => {}, client: new FakeClient(), notice: () => {}, sha256: fakeSha256, maintenance: startup,
    });
    const dl = host.download(await offerFor(host, 'uk', 'en', UK), {});
    for (let i = 0; i < 5; i++) await pause();
    expect(base.fetcher.total()).toBe(0);
    release();
    await dl;
    expect(base.fetcher.total()).toBeGreaterThan(0);
  });

  it('downloading(leg) is true from the download() call itself, so removePair of a pivot leg is refused in the same tick', async () => {
    const { host } = setup('de');
    const offer = await offerFor(host, 'uk', 'de', UK); // uk → en → de
    const ctl = new AbortController();
    const running = host.download(offer, { signal: ctl.signal });
    expect(host.downloading('uk-en')).toBe(true);
    expect(host.downloading('en-de')).toBe(true);
    const refused = host.removePair('uk-en');
    await expect(refused).rejects.toThrow('uk-en is still downloading');
    ctl.abort();
    await running.catch(() => {});
  });
});

// ---- T6 review: keepEngine decided when the remove runs; hover misses that say nothing ----
describe('ObsidianTranslateHost: removes behind the sweep; word misses (T6 review)', () => {
  const offerFor = async (host: ObsidianTranslateHost, from: string, to: string, text: string) => {
    const out = await host.translate({ text, from, to });
    if (out.kind !== 'needsDownload') throw new Error(out.kind);
    return out.offer;
  };

  it('a removePair queued behind a running sweep keeps the engine for a download that started meanwhile', async () => {
    const { adapter, host, fetcher } = setup('en');
    await install(host, 'en', 'de');
    const offer = await offerFor(host, 'uk', 'en', UK);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const list = adapter.list.bind(adapter);
    adapter.list = async (p: string) => {
      await gate;
      return list(p);
    };
    const before = fetcher.total();
    const sweep = host.sweep();
    const removing = host.removePair('en-de'); // nothing downloads yet when it is asked for
    const dl = host.download(offer, {});
    for (let i = 0; i < 5; i++) await pause();
    expect(fetcher.total()).toBe(before);
    release();
    await sweep;
    await removing;
    await dl;
    expect(fetcher.total()).toBe(before + UKEN.files.length);
    expect(await host.engineSize()).toBe(ENGINE.file.size);
    expect(await host.installedSizes()).toEqual([{ key: 'uk-en', bytes: sum(UKEN.files) }]);
  });

  it('a word of a pair that is downloading now says so (not "set it up"), directly and through a pivot leg', async () => {
    const { host, client } = setup('en');
    const ctl = new AbortController();
    const running = host.download(await offerFor(host, 'uk', 'en', UK), { signal: ctl.signal });
    expect(await host.translateWord('книжка', 'uk', 'en')).toEqual({ kind: 'downloading' });
    // uk → de goes through uk → en, which is downloading
    expect(await host.translateWord('книжка', 'uk', 'de')).toEqual({ kind: 'downloading' });
    // en → de shares nothing with it but the engine: not installed
    expect(await host.translateWord('book', 'en', 'de')).toEqual({ kind: 'notInstalled' });
    ctl.abort();
    await running.catch(() => {});
    await pause();
    expect(await host.translateWord('книжка', 'uk', 'en')).toEqual({ kind: 'notInstalled' });
    expect(client.calls).toEqual([]);
  });

  it('a closed host answers unavailable', async () => {
    const { host } = setup('en');
    await install(host, 'uk', 'en');
    host.dispose();
    expect(await host.translateWord('книжка', 'uk', 'en')).toEqual({ kind: 'unavailable' });
  });
});

describe('final review T2–T5', () => {
  it('T2: a pair recorded with other files than the catalog’s (same version) is not installed: a fresh download is offered', async () => {
    const { host, adapter } = setup('en');
    await install(host, 'uk', 'en');
    expect(await host.translate({ text: UK })).toMatchObject({ kind: 'done' });
    const REG = `${TROOT}/installed.json`;
    const good = adapter.files.get(REG) as string;
    // A host reading the registry afresh (the store caches what it read), as after a restart.
    const fresh = () =>
      new ObsidianTranslateHost({
        adapter: adapter as never, root: TROOT, fetcher: new FakeFetcher(), settings: () => ({ target: 'en', hover: true }),
        saveTarget: () => {}, client: new FakeClient(), notice: () => {}, sha256: fakeSha256,
      });
    expect((await fresh().translate({ text: UK })).kind).toBe('done');
    const reg = JSON.parse(good);
    reg.pairs['uk-en'].files[0].sha256 = 'a'.repeat(64);
    adapter.files.set(REG, JSON.stringify(reg));
    const out = await fresh().translate({ text: UK });
    expect(out.kind).toBe('needsDownload');
    if (out.kind === 'needsDownload') expect(out.offer.parts.map((p) => p.label)).toEqual(['Українська → English']);
    // A file missing from the record (a smaller set) counts the same way.
    const fewer = JSON.parse(good);
    fewer.pairs['uk-en'].files = fewer.pairs['uk-en'].files.slice(1);
    adapter.files.set(REG, JSON.stringify(fewer));
    expect((await fresh().translate({ text: UK })).kind).toBe('needsDownload');
  });

  it('T3: an engine wasm whose bytes don’t hash to the catalog’s sha256 is refused', async () => {
    const { host, adapter } = setup('en');
    await install(host, 'uk', 'en');
    const path = enginePath(TROOT, ENGINE.file.sha256);
    expect((await readEngineWasm(adapter as never, TROOT, fakeSha256)).byteLength).toBe(ENGINE.file.size);
    adapter.files.set(path, new ArrayBuffer(ENGINE.file.size)); // same size, other bytes
    await expect(readEngineWasm(adapter as never, TROOT, fakeSha256)).rejects.toThrow(ENGINE_DAMAGED);
  });

  it('T4: a cancel landing after the last file is in place records nothing and leaves no files', async () => {
    const { host, adapter } = setup('en');
    await install(host, 'en', 'de'); // engine in place
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    const ctl = new AbortController();
    const last = modelPath(TROOT, 'uk-en', UKEN.version, UKEN.files[UKEN.files.length - 1].name);
    const rename = adapter.rename.bind(adapter);
    adapter.rename = async (from: string, to: string) => {
      await rename(from, to);
      if (to === last) ctl.abort(); // every byte verified and renamed: only the record is left
    };
    await expect(host.download(out.offer, { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await pause();
    expect(parseInstalled(adapter.files.get(`${TROOT}/installed.json`) as string)?.pairs['uk-en']).toBeUndefined();
    expect(adapter.under(`${TROOT}/models/uk-en`)).toEqual([]);
  });

  it('T4: the same for the engine', async () => {
    const { host, adapter } = setup('en');
    const out = await host.translate({ text: UK });
    if (out.kind !== 'needsDownload') throw new Error('no offer');
    const ctl = new AbortController();
    const engine = enginePath(TROOT, ENGINE.file.sha256);
    const rename = adapter.rename.bind(adapter);
    adapter.rename = async (from: string, to: string) => {
      await rename(from, to);
      if (to === engine) ctl.abort();
    };
    await expect(host.download(out.offer, { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await pause();
    expect(parseInstalled(adapter.files.get(`${TROOT}/installed.json`) as string)?.engine ?? null).toBeNull();
    expect(adapter.under(engineDir(TROOT, ENGINE.file.sha256))).toEqual([]);
  });

  it('T5: a pair removed between the check and the load says so, not the adapter’s error', async () => {
    const { host, client } = setup('en');
    await install(host, 'uk', 'en');
    const ensure = client.ensureModel.bind(client);
    client.ensureModel = async (key, from, to, files) => {
      await host.removePair(key); // Settings → Translation → Remove, mid-translation
      return ensure(key, from, to, files);
    };
    await expect(host.translate({ text: UK })).rejects.toThrow(PAIR_REMOVED);
  });
});
