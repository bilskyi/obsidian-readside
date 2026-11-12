import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __installCanvas, type MemoryAdapter } from 'obsidian';
import { CoverManager, MAX_PASTED_BYTES, type CoverDeps } from '../src/covers/covers';
import { dims, epubCoverWebp, isZip } from '../src/covers/epubCover';
import { epubEntries, makeEpub, zipEntries } from '../../src/renderers/epub/testEpub';
import { COVER_MAX_HEIGHT, COVER_QUALITY, COVER_WIDTH, renderFirstPage } from '../src/covers/thumbnail';
import type { PdfjsLib } from '../../src/renderers/pdf/pdfjsProvider';
import { BookStore, validCover } from '../src/store/bookStore';
import type { IndexFile } from '../src/store/types';
import { pluginAdapter, ROOT } from './helpers';

let adapter: MemoryAdapter;
let ids: number;
const make = () => new BookStore(adapter, ROOT, { uuid: () => `id-${++ids}`, coalesceMs: 0, summaryDelayMs: 60_000 });
const indexOnDisk = () => JSON.parse(adapter.files.get(`${ROOT}/index.json`) as string) as IndexFile;
const indexWrites = () => adapter.calls.filter((c) => c === `write ${ROOT}/index.json.tmp`).length;
const COVERS = `${ROOT}/covers`;

beforeEach(() => {
  adapter = pluginAdapter();
  ids = 0;
});

describe('cover fields in index.json', () => {
  it('validCover keeps each kind, cleans unknown fields, refuses anything else', () => {
    expect(validCover({ kind: 'tile', extra: 1 })).toEqual({ kind: 'tile' });
    expect(validCover({ kind: 'page' })).toEqual({ kind: 'page' });
    expect(validCover({ kind: 'vault', path: 'Art/a.png' })).toEqual({ kind: 'vault', path: 'Art/a.png' });
    expect(validCover({ kind: 'pasted', ext: 'png', at: 'x' })).toEqual({ kind: 'pasted', ext: 'png', at: 'x' });
    for (const bad of [
      null, 'tile', [], { kind: 'nope' }, { kind: 'vault' }, { kind: 'vault', path: '' }, { kind: 'vault', path: '/etc/a.png' },
      { kind: 'vault', path: 'a/../../b.png' }, { kind: 'vault', path: 3 }, { kind: 'pasted', ext: 'exe', at: 'x' }, { kind: 'pasted', ext: 'png' },
    ]) {
      expect(validCover(bad)).toBeNull();
    }
  });

  it('a good cover and thumb load; a bad one is dropped and its entry kept (not a corrupt index); old entries load without them', async () => {
    adapter.files.set(`${ROOT}/index.json`, JSON.stringify({
      version: 1,
      entries: {
        'a.pdf': { bookId: 'a', fingerprint: '1:a', missing: false, cover: { kind: 'vault', path: 'Art/a.png' }, thumb: '1:a' },
        'b.pdf': { bookId: 'b', fingerprint: '1:b', missing: false, cover: { kind: 'vault', path: '/abs.png' }, thumb: '' },
        'c.pdf': { bookId: 'c', fingerprint: '1:c', missing: false },
      },
    }));
    adapter.folders.add(`${ROOT}/books`);
    for (const id of ['a', 'b', 'c']) adapter.files.set(`${ROOT}/books/${id}.json`, JSON.stringify({ version: 1, book: { id }, annotations: [], thoughts: [] }));
    const s = make();
    const recovered = vi.fn();
    s.onRecovery(recovered);
    await s.load();
    expect(recovered).not.toHaveBeenCalled();
    expect(s.entry('a.pdf')).toEqual({ bookId: 'a', fingerprint: '1:a', missing: false, cover: { kind: 'vault', path: 'Art/a.png' }, thumb: '1:a' });
    expect(s.entry('b.pdf')).toEqual({ bookId: 'b', fingerprint: '1:b', missing: false });
    expect(s.entry('c.pdf')).toEqual({ bookId: 'c', fingerprint: '1:c', missing: false });
  });

  it('setCover and setThumb write the index once each; the same value again writes nothing; null clears the cover', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'A');
    const before = indexWrites();
    await s.setCover(book.id, { kind: 'tile' });
    await s.setThumb(book.id, '1:x');
    expect(indexWrites()).toBe(before + 2);
    expect(indexOnDisk().entries['Books/a.pdf']).toMatchObject({ cover: { kind: 'tile' }, thumb: '1:x' });
    await s.setCover(book.id, { kind: 'tile' });
    await s.setThumb(book.id, '1:x');
    expect(indexWrites()).toBe(before + 2);
    await s.setCover(book.id, null);
    expect('cover' in indexOnDisk().entries['Books/a.pdf']).toBe(false);
    expect(s.entryOf(book.id)).toMatchObject({ path: 'Books/a.pdf', thumb: '1:x' });
  });

  it('the cover and thumb ride along when the book moves, reattaches or gets new content', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'A');
    await s.setCover(book.id, { kind: 'page' });
    await s.setThumb(book.id, '1:x');
    await s.renamePath('Books/a.pdf', 'Books/b.pdf');
    await s.markMissing('Books/b.pdf');
    await s.openPath('Moved/b.pdf', '1:x', 'B');
    await s.openPath('Moved/b.pdf', '2:y', 'B');
    expect(s.entry('Moved/b.pdf')).toMatchObject({ bookId: book.id, fingerprint: '2:y', cover: { kind: 'page' }, thumb: '1:x' });
  });

  it('a chosen vault image is followed through a file or folder move, and dropped when deleted; others stay', async () => {
    const s = make();
    await s.load();
    const a = (await s.openPath('a.pdf', '1:a', 'A')).book.id;
    const b = (await s.openPath('b.pdf', '1:b', 'B')).book.id;
    const c = (await s.openPath('c.pdf', '1:c', 'C')).book.id;
    await s.setCover(a, { kind: 'vault', path: 'Art/one.png' });
    await s.setCover(b, { kind: 'vault', path: 'Art/sub/two.png' });
    await s.setCover(c, { kind: 'vault', path: 'Artwork/three.png' });
    await s.followCoverMove('Art/one.png', 'Art/uno.png');
    expect(s.entryOf(a)?.cover).toEqual({ kind: 'vault', path: 'Art/uno.png' });
    await s.followCoverMove('Art', 'Pictures');
    expect(s.entryOf(a)?.cover).toEqual({ kind: 'vault', path: 'Pictures/uno.png' });
    expect(s.entryOf(b)?.cover).toEqual({ kind: 'vault', path: 'Pictures/sub/two.png' });
    expect(s.entryOf(c)?.cover).toEqual({ kind: 'vault', path: 'Artwork/three.png' });
    await s.dropCoverPath('Pictures/sub');
    expect(s.entryOf(b)?.cover).toBeUndefined();
    expect(s.entryOf(a)?.cover).toEqual({ kind: 'vault', path: 'Pictures/uno.png' });
    expect(indexOnDisk().entries['b.pdf'].cover).toBeUndefined();
    expect(indexOnDisk().entries['a.pdf'].cover).toEqual({ kind: 'vault', path: 'Pictures/uno.png' });
  });

  it('after close, cover changes reject', async () => {
    const s = make();
    await s.load();
    s.close();
    await expect(s.setCover('x', null)).rejects.toThrow(/turned off/);
  });
});

/** A pdf.js stand-in: one page of `w`×`h` points; records what happened. */
function fakePdf(opts: { w?: number; h?: number; fail?: boolean } = {}) {
  const w = opts.w ?? 600;
  const h = opts.h ?? 800;
  const log = { getDocument: [] as Record<string, unknown>[], render: [] as { viewport: { width: number; height: number }; canvas: HTMLCanvasElement }[], cleanup: 0, destroy: 0 };
  const lib = {
    getDocument(params: Record<string, unknown>) {
      log.getDocument.push(params);
      const doc = {
        getPage: async (n: number) => {
          if (n !== 1) throw new Error('page 1 only');
          return {
            getViewport: ({ scale }: { scale: number }) => ({ width: w * scale, height: h * scale, scale }),
            render: (p: { viewport: { width: number; height: number }; canvas: HTMLCanvasElement }) => {
              log.render.push(p);
              return { promise: Promise.resolve() };
            },
            cleanup: () => void log.cleanup++,
          };
        },
      };
      return {
        promise: opts.fail ? Promise.reject(new Error('Invalid PDF structure')) : Promise.resolve(doc),
        destroy: async () => void log.destroy++,
      };
    },
  } as unknown as PdfjsLib;
  return { lib, log };
}

describe('renderFirstPage', () => {
  let undo: () => void = () => {};
  afterEach(() => undo());

  it('draws page 1 at 320 px wide, encodes WebP at 0.8, passes the host options, and lets everything go', async () => {
    undo = __installCanvas();
    const { lib, log } = fakePdf({ w: 600, h: 800 });
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const out = await renderFirstPage(lib, { isEvalSupported: false }, bytes);
    expect(out).not.toBeNull();
    expect(new TextDecoder().decode(out!)).toBe(`${COVER_WIDTH}x${Math.round((800 * COVER_WIDTH) / 600)}@${COVER_QUALITY}`);
    expect(log.getDocument[0]).toMatchObject({ isEvalSupported: false });
    expect(Array.from(log.getDocument[0].data as Uint8Array)).toEqual([1, 2, 3]);
    expect(log.render[0].viewport.width).toBe(COVER_WIDTH);
    expect(log.cleanup).toBe(1);
    expect(log.destroy).toBe(1);
    // The canvas is emptied once encoded.
    expect(log.render[0].canvas.width).toBe(0);
  });

  it('a very tall first page is drawn no taller than the cap', async () => {
    undo = __installCanvas();
    const { lib } = fakePdf({ w: 100, h: 2000 });
    const out = await renderFirstPage(lib, {}, new ArrayBuffer(1));
    const [w, h] = new TextDecoder().decode(out!).split('@')[0].split('x').map(Number);
    expect(h).toBe(COVER_MAX_HEIGHT);
    expect(w).toBe(32);
  });

  it('null, with the document destroyed, when the PDF does not open, there is no 2D context, or WebP cannot be encoded', async () => {
    undo = __installCanvas();
    const broken = fakePdf({ fail: true });
    expect(await renderFirstPage(broken.lib, {}, new ArrayBuffer(1))).toBeNull();
    expect(broken.log.destroy).toBe(1);
    undo();

    undo = __installCanvas({ noContext: true });
    const noCtx = fakePdf();
    expect(await renderFirstPage(noCtx.lib, {}, new ArrayBuffer(1))).toBeNull();
    expect(noCtx.log.destroy).toBe(1);
    undo();

    undo = __installCanvas({ type: 'image/png' });
    const png = fakePdf();
    expect(await renderFirstPage(png.lib, {}, new ArrayBuffer(1))).toBeNull();
    expect(png.log.destroy).toBe(1);
    undo();

    undo = __installCanvas({ type: null });
    expect(await renderFirstPage(fakePdf().lib, {}, new ArrayBuffer(1))).toBeNull();
  });
});

describe('CoverManager', () => {
  let store: BookStore;
  let render: ReturnType<typeof vi.fn<(b: ArrayBuffer) => Promise<ArrayBuffer | null>>>;
  let readBytes: ReturnType<typeof vi.fn<(p: string) => Promise<ArrayBuffer>>>;
  let images: Map<string, string>;
  let covers: CoverManager;
  const webp = (s = 'webp') => new TextEncoder().encode(s).buffer as ArrayBuffer;

  const setup = async (over: Partial<CoverDeps> = {}) => {
    store = make();
    await store.load();
    render = vi.fn(async () => webp());
    readBytes = vi.fn(async () => new ArrayBuffer(4));
    images = new Map();
    covers = new CoverManager({
      adapter: adapter as unknown as CoverDeps['adapter'],
      root: ROOT,
      index: store,
      ready: async () => {},
      readBytes,
      render,
      vaultImage: (p) => images.get(p) ?? null,
      delayMs: 5,
      ...over,
    });
  };
  afterEach(() => covers?.dispose());

  it('a request makes covers/<id>.webp later, tmp → remove → rename, records the fingerprint, and the card shows it', async () => {
    await setup();
    const id = (await store.openPath('Books/a.pdf', '1:a', 'A')).book.id;
    const onChange = vi.fn();
    covers.onChange(onChange);
    adapter.files.set(`${COVERS}/${id}.webp`, 'old');
    adapter.folders.add(COVERS);
    expect(covers.view({ bookId: id, missing: false })).toEqual({ src: null, wantsThumb: true });
    adapter.calls.length = 0;
    covers.request(id);
    expect(render).not.toHaveBeenCalled(); // later, never during the open
    await covers.idle();
    expect(readBytes).toHaveBeenCalledWith('Books/a.pdf');
    const file = `${COVERS}/${id}.webp`;
    expect(adapter.calls.filter((c) => c.includes(`${id}.webp`))).toEqual([`writeBinary ${file}.tmp`, `exists ${file}`, `remove ${file}`, `rename ${file}.tmp`]);
    expect(new TextDecoder().decode(adapter.files.get(file) as ArrayBuffer)).toBe('webp');
    expect(store.entryOf(id)?.thumb).toBe('1:a');
    expect(onChange).toHaveBeenCalledWith(id);
    const view = covers.view({ bookId: id, missing: false });
    expect(view.wantsThumb).toBe(false);
    expect(view.src).toMatch(new RegExp(`^app://local/${ROOT}/covers/${id}\\.webp\\?\\d+&v=`));
  });

  it('makes the covers folder when it is not there', async () => {
    await setup();
    const id = (await store.openPath('a.pdf', '1:a', 'A')).book.id;
    covers.request(id);
    await covers.idle();
    expect(adapter.folders.has(COVERS)).toBe(true);
    expect(adapter.files.has(`${COVERS}/${id}.webp`)).toBe(true);
  });

  it('one at a time, each book once however often it is asked for', async () => {
    let running = 0;
    let most = 0;
    await setup({
      render: async () => {
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return webp();
      },
    });
    const a = (await store.openPath('a.pdf', '1:a', 'A')).book.id;
    const b = (await store.openPath('b.pdf', '1:b', 'B')).book.id;
    const c = (await store.openPath('c.pdf', '1:c', 'C')).book.id;
    for (const id of [a, b, a, c, b, a]) covers.request(id);
    await covers.idle();
    expect(most).toBe(1);
    expect(readBytes.mock.calls.map(([p]) => p)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  });

  it('skipped when the thumbnail on disk is from the current content; made again for new content or a lost file', async () => {
    await setup();
    const id = (await store.openPath('a.pdf', '1:a', 'A')).book.id;
    covers.request(id);
    await covers.idle();
    expect(render).toHaveBeenCalledTimes(1);
    covers.request(id);
    await covers.idle();
    expect(render).toHaveBeenCalledTimes(1);
    await store.openPath('a.pdf', '2:b', 'A');
    expect(covers.view({ bookId: id, missing: false })).toEqual({ src: null, wantsThumb: true });
    covers.request(id);
    await covers.idle();
    expect(render).toHaveBeenCalledTimes(2);
    expect(store.entryOf(id)?.thumb).toBe('2:b');
    adapter.files.delete(`${COVERS}/${id}.webp`);
    covers.request(id);
    await covers.idle();
    expect(render).toHaveBeenCalledTimes(3);
    expect(adapter.files.has(`${COVERS}/${id}.webp`)).toBe(true);
  });

  it('a first page that cannot be drawn leaves the colour tile and is not tried again for that content', async () => {
    await setup({ render: vi.fn(async () => null) });
    const id = (await store.openPath('a.pdf', '1:a', 'A')).book.id;
    covers.request(id);
    await covers.idle();
    covers.request(id);
    await covers.idle();
    expect(readBytes).toHaveBeenCalledTimes(1);
    expect(covers.view({ bookId: id, missing: false })).toEqual({ src: null, wantsThumb: false });
    expect(store.entryOf(id)?.thumb).toBeUndefined();
    expect([...adapter.files.keys()].some((k) => k.startsWith(COVERS))).toBe(false);
  });

  it('a read that fails is the same as a page that cannot be drawn', async () => {
    await setup();
    readBytes.mockRejectedValueOnce(new Error('gone'));
    const id = (await store.openPath('a.pdf', '1:a', 'A')).book.id;
    covers.request(id);
    await covers.idle();
    expect(render).not.toHaveBeenCalled();
    expect(covers.view({ bookId: id, missing: false }).wantsThumb).toBe(false);
  });

  it('a missing book is not drawn, nor asked for', async () => {
    await setup();
    const id = (await store.openPath('a.pdf', '1:a', 'A')).book.id;
    await store.markMissing('a.pdf');
    expect(covers.view({ bookId: id, missing: true })).toEqual({ src: null, wantsThumb: false });
    covers.request(id);
    await covers.idle();
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('waits for ready: a failed ready skips the job', async () => {
    await setup({ ready: () => Promise.reject(new Error('no pdf.js')) });
    const id = (await store.openPath('a.pdf', '1:a', 'A')).book.id;
    covers.request(id);
    await covers.idle();
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('after dispose nothing starts and a job in flight does not write', async () => {
    let release: () => void = () => {};
    await setup({ render: () => new Promise((r) => (release = () => r(webp()))) });
    const a = (await store.openPath('a.pdf', '1:a', 'A')).book.id;
    covers.request(a);
    await vi.waitFor(() => expect(readBytes).toHaveBeenCalled());
    covers.dispose();
    release();
    await covers.idle();
    covers.request(a);
    await new Promise((r) => setTimeout(r, 20));
    expect(adapter.files.has(`${COVERS}/${a}.webp`)).toBe(false);
    expect(readBytes).toHaveBeenCalledTimes(1);
  });

  it('view: the colour tile, a vault image, a vault image that is gone (automatic), a pasted image', async () => {
    await setup();
    const id = (await store.openPath('a.pdf', '1:a', 'A')).book.id;
    await store.setThumb(id, '1:a');
    await store.setCover(id, { kind: 'tile' });
    expect(covers.view({ bookId: id, missing: false })).toEqual({ src: null, wantsThumb: false });
    images.set('Art/a.png', 'app://local/Art/a.png?1');
    await store.setCover(id, { kind: 'vault', path: 'Art/a.png' });
    expect(covers.view({ bookId: id, missing: false })).toEqual({ src: 'app://local/Art/a.png?1', wantsThumb: false });
    images.clear();
    expect(covers.view({ bookId: id, missing: false }).src).toContain(`/covers/${id}.webp`);
    await store.setCover(id, { kind: 'pasted', ext: 'jpg', at: '2026-11-11T00:00:00.000Z' });
    expect(covers.view({ bookId: id, missing: false }).src).toContain(`/covers/${id}-custom.jpg?0&v=2026-11-11T00%3A00%3A00.000Z`);
    expect(covers.view({ bookId: 'nope', missing: false })).toEqual({ src: null, wantsThumb: false });
  });

  it('paste saves covers/<id>-custom.<ext> and chooses it; another choice removes it; too large is refused', async () => {
    await setup();
    const id = (await store.openPath('a.pdf', '1:a', 'A')).book.id;
    await covers.paste(id, webp('png!'), 'png');
    expect(new TextDecoder().decode(adapter.files.get(`${COVERS}/${id}-custom.png`) as ArrayBuffer)).toBe('png!');
    expect(store.entryOf(id)?.cover).toMatchObject({ kind: 'pasted', ext: 'png' });
    await covers.paste(id, webp('gif!'), 'gif');
    expect(adapter.files.has(`${COVERS}/${id}-custom.png`)).toBe(false);
    expect(adapter.files.has(`${COVERS}/${id}-custom.gif`)).toBe(true);
    await covers.choose(id, { kind: 'tile' });
    expect(adapter.files.has(`${COVERS}/${id}-custom.gif`)).toBe(false);
    await expect(covers.paste(id, new ArrayBuffer(MAX_PASTED_BYTES + 1), 'png')).rejects.toThrow(/10 MB/);
    expect(store.entryOf(id)?.cover).toEqual({ kind: 'tile' });
  });

  it('choosing the first page or automatic asks for the thumbnail; the tile or a vault image does not', async () => {
    await setup();
    const id = (await store.openPath('a.pdf', '1:a', 'A')).book.id;
    const request = vi.spyOn(covers, 'request');
    await covers.choose(id, { kind: 'tile' });
    await covers.choose(id, { kind: 'vault', path: 'x.png' });
    expect(request).not.toHaveBeenCalled();
    await covers.choose(id, { kind: 'page' });
    await covers.choose(id, null);
    expect(request).toHaveBeenCalledTimes(2);
    expect(store.entryOf(id)?.cover).toBeUndefined();
  });

  it('the sweep removes covers of books the index does not know, unused pasted images and cut-short writes; keeps the rest', async () => {
    await setup();
    const a = (await store.openPath('a.pdf', '1:a', 'A')).book.id;
    const b = (await store.openPath('b.pdf', '1:b', 'B')).book.id;
    await store.setCover(b, { kind: 'pasted', ext: 'jpg', at: 'x' });
    await store.setCover(a, { kind: 'tile' });
    adapter.folders.add(COVERS);
    const keep = [`${COVERS}/${a}.webp`, `${COVERS}/${b}.webp`, `${COVERS}/${b}-custom.jpg`];
    const go = [`${COVERS}/gone.webp`, `${COVERS}/gone-custom.png`, `${COVERS}/${a}-custom.png`, `${COVERS}/${b}-custom.png`, `${COVERS}/${a}.webp.tmp`, `${COVERS}/${a}.png`, `${COVERS}/notes.txt`];
    for (const f of [...keep, ...go]) adapter.files.set(f, 'x');
    await covers.sweep();
    expect([...adapter.files.keys()].filter((k) => k.startsWith(`${COVERS}/`)).sort()).toEqual([...keep].sort());
  });

  it('the sweep keeps a pasted image of a known book whose cover the index lost (index recovery); a known book with another valid choice loses it', async () => {
    await setup();
    const a = (await store.openPath('a.pdf', '1:a', 'A')).book.id; // cover unset: the index was rebuilt
    const b = (await store.openPath('b.pdf', '1:b', 'B')).book.id;
    await store.setCover(b, { kind: 'tile' });
    adapter.folders.add(COVERS);
    for (const f of [`${COVERS}/${a}-custom.png`, `${COVERS}/${b}-custom.png`, `${COVERS}/orphan-custom.png`]) adapter.files.set(f, 'x');
    await covers.sweep();
    expect([...adapter.files.keys()].filter((k) => k.endsWith('.png')).sort()).toEqual([`${COVERS}/${a}-custom.png`]);
  });

  it('the sweep leaves a recent .tmp (a write may be in flight) and removes an old one', async () => {
    await setup();
    const a = (await store.openPath('a.pdf', '1:a', 'A')).book.id;
    adapter.folders.add(COVERS);
    adapter.files.set(`${COVERS}/${a}.webp.tmp`, 'young');
    adapter.mtimes.set(`${COVERS}/${a}.webp.tmp`, Date.now() - 5_000);
    adapter.files.set(`${COVERS}/${a}-custom.png.tmp`, 'old');
    adapter.mtimes.set(`${COVERS}/${a}-custom.png.tmp`, Date.now() - 120_000);
    await covers.sweep();
    expect([...adapter.files.keys()].filter((k) => k.endsWith('.tmp'))).toEqual([`${COVERS}/${a}.webp.tmp`]);
  });

  it('a thumbnail whose rename fails leaves no tmp, records nothing, and is made on the next request', async () => {
    await setup();
    const id = (await store.openPath('a.pdf', '1:a', 'A')).book.id;
    adapter.failOn('rename', (p) => p.endsWith('.webp.tmp'));
    covers.request(id);
    await covers.idle();
    expect([...adapter.files.keys()].filter((k) => k.startsWith(COVERS))).toEqual([]);
    expect(store.entryOf(id)?.thumb).toBeUndefined();
    covers.request(id);
    await covers.idle();
    expect(render).toHaveBeenCalledTimes(2);
    expect(adapter.files.has(`${COVERS}/${id}.webp`)).toBe(true);
    expect(store.entryOf(id)?.thumb).toBe('1:a');
  });

  it('no thumbnail is made for a book whose cover shows none (tile, pasted, a vault image that is there); a vault image that is gone still gets one', async () => {
    await setup();
    const ids = [];
    for (const n of ['t', 'p', 'v', 'g']) ids.push((await store.openPath(`${n}.pdf`, `1:${n}`, n)).book.id);
    await store.setCover(ids[0], { kind: 'tile' });
    await store.setCover(ids[1], { kind: 'pasted', ext: 'png', at: 'x' });
    await store.setCover(ids[2], { kind: 'vault', path: 'Art/here.png' });
    await store.setCover(ids[3], { kind: 'vault', path: 'Art/gone.png' });
    images.set('Art/here.png', 'app://local/Art/here.png');
    for (const id of ids) covers.request(id);
    await covers.idle();
    expect(readBytes.mock.calls.map((c) => c[0])).toEqual(['g.pdf']);
  });

  it('queued thumbnail jobs are spaced by a pause', async () => {
    await setup({ gapMs: 60 });
    const a = (await store.openPath('a.pdf', '1:a', 'A')).book.id;
    const b = (await store.openPath('b.pdf', '1:b', 'B')).book.id;
    const at: number[] = [];
    render.mockImplementation(async () => (at.push(Date.now()), webp()));
    covers.request(a);
    covers.request(b);
    await covers.idle();
    expect(at).toHaveLength(2);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(55);
  });

  it('paste: the old -custom file stays until the index took the new choice; a failed choice removes the temp file and keeps everything', async () => {
    await setup();
    const id = (await store.openPath('a.pdf', '1:a', 'A')).book.id;
    await covers.paste(id, webp('one'), 'png');
    const file = `${COVERS}/${id}-custom.png`;
    expect(new TextDecoder().decode(adapter.files.get(file) as ArrayBuffer)).toBe('one');
    const before = store.entryOf(id)?.cover;
    const spy = vi.spyOn(store, 'setCover').mockRejectedValueOnce(new Error('index write failed'));
    await expect(covers.paste(id, webp('two'), 'png')).rejects.toThrow('index write failed');
    expect(new TextDecoder().decode(adapter.files.get(file) as ArrayBuffer)).toBe('one');
    expect([...adapter.files.keys()].filter((k) => k.endsWith('.tmp'))).toEqual([]);
    expect(store.entryOf(id)?.cover).toEqual(before);
    spy.mockRestore();
    await covers.paste(id, webp('three'), 'png');
    expect(new TextDecoder().decode(adapter.files.get(file) as ArrayBuffer)).toBe('three');
    expect([...adapter.files.keys()].filter((k) => k.endsWith('.tmp'))).toEqual([]);
  });

  it('the sweep does nothing without a covers folder', async () => {
    await setup();
    adapter.calls.length = 0;
    await covers.sweep();
    expect(adapter.calls).toEqual([`exists ${COVERS}`]);
  });
});

describe('EPUB covers', () => {
  let undo: () => void = () => {};
  const realBitmap = (globalThis as any).createImageBitmap;
  let closed: number;
  let decoded: { type: string; size: number }[];
  let bitmapFail = false;
  beforeEach(() => {
    closed = 0;
    decoded = [];
    bitmapFail = false;
    (globalThis as any).createImageBitmap = async (b: Blob) => {
      decoded.push({ type: b.type, size: b.size });
      if (bitmapFail) throw new Error('undecodable');
      return { width: 600, height: 900, close: () => void closed++ };
    };
    undo = __installCanvas();
    (HTMLCanvasElement.prototype as any).getContext = function (this: HTMLCanvasElement) {
      return { fillStyle: '', fillRect: () => {}, drawImage: () => {} };
    };
  });
  afterEach(() => {
    undo();
    (globalThis as any).createImageBitmap = realBitmap;
  });

  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const png = (w: number, h: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...u32(w), ...u32(h), 8, 6, 0, 0, 0]);
  const gif = (w: number, h: number) => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0]);
  // SOI, an APP0 segment (length 4), a DHT (C4, skipped), then SOF2.
  const jpeg = (w: number, h: number) =>
    new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc4, 0, 3, 0, 0xff, 0xc2, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0]);
  const riff = (kind: string, body: number[]) => new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, ...[...kind].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...body]);
  const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
  const webpX = (w: number, h: number) => riff('VP8X', [0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
  const webpL = (w: number, h: number) => {
    const bits = (w - 1) | ((h - 1) << 14);
    return riff('VP8L', [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255]);
  };
  const webpLossy = (w: number, h: number) => riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, w & 255, w >> 8, h & 255, h >> 8]);
  const PNG = png(600, 900);
  const JPG = jpeg(600, 900);
  const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
  const sections = [{ name: 'c.xhtml', html: '<p>hi</p>' }];
  const opts = { width: COVER_WIDTH, quality: COVER_QUALITY };

  it('draws the cover at 320 px wide, encodes WebP at 0.8, and closes the bitmap', async () => {
    const out = await epubCoverWebp(makeEpub({ sections, cover: { name: 'c.png', bytes: PNG, method: 'properties' } }), opts);
    expect(new TextDecoder().decode(out!)).toBe(`${COVER_WIDTH}x${Math.round((900 * COVER_WIDTH) / 600)}@${COVER_QUALITY}`);
    expect(decoded).toEqual([{ type: 'image/png', size: PNG.length }]);
    expect(closed).toBe(1);
  });

  it('a cover is found by the legacy meta and by the first image, too', async () => {
    for (const method of ['meta', 'img'] as const) {
      decoded = [];
      expect(await epubCoverWebp(makeEpub({ sections, cover: { name: 'c.jpg', bytes: JPG, method } }), opts)).not.toBeNull();
      expect(decoded).toEqual([{ type: 'image/jpeg', size: JPG.length }]);
    }
  });

  it('null when the book has no cover (nothing decoded)', async () => {
    expect(await epubCoverWebp(makeEpub({ sections }), opts)).toBeNull();
    expect(decoded).toEqual([]);
  });

  it('null for an SVG cover, whatever the manifest says, and for bytes that are not the type claimed; nothing is decoded', async () => {
    // The manifest says image/svg+xml.
    const e1 = epubEntries({ sections, cover: { name: 'c.png', bytes: SVG, method: 'properties' } });
    e1['OEBPS/content.opf'] = new TextEncoder().encode(new TextDecoder().decode(e1['OEBPS/content.opf']).replace('image/png', 'image/svg+xml'));
    expect(await epubCoverWebp(zipEntries(e1), opts)).toBeNull();
    // The manifest says image/svg+xml but the bytes are a real PNG: the declared type is refused too.
    const e2 = epubEntries({ sections, cover: { name: 'c.png', bytes: PNG, method: 'properties' } });
    e2['OEBPS/content.opf'] = new TextEncoder().encode(new TextDecoder().decode(e2['OEBPS/content.opf']).replace('image/png', 'image/svg+xml'));
    expect(await epubCoverWebp(zipEntries(e2), opts)).toBeNull();
    // The manifest says image/png (the helper's type for .png) but the bytes are SVG.
    expect(await epubCoverWebp(makeEpub({ sections, cover: { name: 'c.png', bytes: SVG, method: 'properties' } }), opts)).toBeNull();
    // Raster manifest type, junk bytes.
    expect(await epubCoverWebp(makeEpub({ sections, cover: { name: 'c.jpg', bytes: new Uint8Array([1, 2, 3]), method: 'properties' } }), opts)).toBeNull();
    expect(decoded).toEqual([]);
  });

  it('null, without throwing, when the cover will not decode (and the bitmap is not leaked), is not an EPUB, or WebP cannot be encoded', async () => {
    bitmapFail = true;
    expect(await epubCoverWebp(makeEpub({ sections, cover: { name: 'c.png', bytes: PNG, method: 'properties' } }), opts)).toBeNull();
    bitmapFail = false;
    expect(await epubCoverWebp(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9]).buffer, opts)).toBeNull();
    undo();
    undo = __installCanvas({ type: 'image/png' });
    (HTMLCanvasElement.prototype as any).getContext = () => ({ fillStyle: '', fillRect: () => {}, drawImage: () => {} });
    expect(await epubCoverWebp(makeEpub({ sections, cover: { name: 'c.png', bytes: PNG, method: 'properties' } }), opts)).toBeNull();
    expect(closed).toBe(1); // only the encode-failure run got a bitmap, and it was released
  });

  it('reads the declared size of each format', () => {
    expect(dims(png(600, 900), 'image/png')).toEqual({ w: 600, h: 900 });
    expect(dims(gif(300, 450), 'image/gif')).toEqual({ w: 300, h: 450 });
    expect(dims(jpeg(600, 900), 'image/jpeg')).toEqual({ w: 600, h: 900 });
    expect(dims(webpX(601, 901), 'image/webp')).toEqual({ w: 601, h: 901 });
    expect(dims(webpL(602, 902), 'image/webp')).toEqual({ w: 602, h: 902 });
    expect(dims(webpLossy(603, 903), 'image/webp')).toEqual({ w: 603, h: 903 });
    // The top two bits of a lossy WebP size are a scale hint, not size.
    expect(dims(webpLossy(603 | 0x4000, 903 | 0x8000), 'image/webp')).toEqual({ w: 603, h: 903 });
    // A PNG side wider than 16 bits.
    expect(dims(png(10, 70000), 'image/png')).toEqual({ w: 10, h: 70000 });
  });

  it('refuses an oversized declared size in every format, and a malformed header, before anything is decoded', async () => {
    const big: [string, Uint8Array][] = [
      ['c.png', png(40000, 40000)],
      ['c.gif', gif(60000, 60000)],
      ['c.jpg', jpeg(60000, 60000)],
      ['c.webp', webpX(16000, 16000)],
      ['c.webp', webpL(16000, 16000)],
      ['c.webp', webpLossy(16000, 16000)],
      ['c.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 1, 2, 3, 4, 5, 6])], // segment length runs off the end
      ['c.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0])], // image data, no frame header
      ['c.png', png(0, 10)],
    ];
    for (const [name, bytes] of big) {
      const type = name.endsWith('gif') ? 'image/gif' : 'image/jpeg';
      const e = epubEntries({ sections, cover: { name, bytes, method: 'properties' } });
      e['OEBPS/content.opf'] = new TextEncoder().encode(new TextDecoder().decode(e['OEBPS/content.opf']).replace(/media-type="image\/(png|jpeg)"/, `media-type="${/\.png$/.test(name) ? 'image/png' : type}"`));
      expect(await epubCoverWebp(zipEntries(e), opts)).toBeNull();
    }
    expect(decoded).toEqual([]);
    // Just under the cap still decodes.
    expect(await epubCoverWebp(makeEpub({ sections, cover: { name: 'c.png', bytes: png(6000, 6000), method: 'properties' } }), opts)).not.toBeNull();
  });

  it('isZip is the PK\\x03\\x04 magic', () => {
    expect(isZip(new Uint8Array([0x50, 0x4b, 3, 4]).buffer)).toBe(true);
    expect(isZip(new TextEncoder().encode('%PDF-1.7').buffer as ArrayBuffer)).toBe(false);
    expect(isZip(new ArrayBuffer(2))).toBe(false);
  });

  describe('on the shelf', () => {
    let store: BookStore;
    let covers: CoverManager;
    afterEach(() => covers?.dispose());
    const build = async (bytes: ArrayBuffer, renderEpub: CoverDeps['renderEpub']) => {
      store = make();
      await store.load();
      const render = vi.fn(async () => new TextEncoder().encode('pdf').buffer as ArrayBuffer);
      covers = new CoverManager({
        adapter: adapter as unknown as CoverDeps['adapter'],
        root: ROOT,
        index: store,
        ready: async () => {},
        readBytes: async () => bytes,
        render,
        renderEpub,
        vaultImage: () => null,
        delayMs: 5,
      });
      return render;
    };

    it('a zip routes to the EPUB cover, a PDF to the first page', async () => {
      const epub = vi.fn(async () => new TextEncoder().encode('epub').buffer as ArrayBuffer);
      let render = await build(new Uint8Array([0x50, 0x4b, 3, 4, 0]).buffer, epub);
      let id = (await store.openPath('a.epub', '1:a', 'A')).book.id;
      covers.request(id);
      await covers.idle();
      expect(epub).toHaveBeenCalledTimes(1);
      expect(render).not.toHaveBeenCalled();
      expect(new TextDecoder().decode(adapter.files.get(`${COVERS}/${id}.webp`) as ArrayBuffer)).toBe('epub');
      covers.dispose();

      epub.mockClear();
      render = await build(new TextEncoder().encode('%PDF-1.7').buffer as ArrayBuffer, epub);
      id = (await store.openPath('b.pdf', '1:b', 'B')).book.id;
      covers.request(id);
      await covers.idle();
      expect(render).toHaveBeenCalledTimes(1);
      expect(epub).not.toHaveBeenCalled();
    });

    it('an EPUB with no usable cover keeps the colour tile and is not tried again this session', async () => {
      const epub = vi.fn(async () => null);
      await build(new Uint8Array([0x50, 0x4b, 3, 4, 0]).buffer, epub);
      const id = (await store.openPath('a.epub', '1:a', 'A')).book.id;
      covers.request(id);
      await covers.idle();
      expect(covers.view({ bookId: id, missing: false })).toEqual({ src: null, wantsThumb: false });
      covers.request(id);
      await covers.idle();
      expect(epub).toHaveBeenCalledTimes(1);
      expect(adapter.files.has(`${COVERS}/${id}.webp`)).toBe(false);
    });
  });
});
