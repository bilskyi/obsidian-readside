import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryAdapter } from 'obsidian';
import { pdfLocation, serializeLocation } from '../../src/lib/location';
import { isValidZoom, NOT_IN_OBSIDIAN, VaultBackend } from '../src/backend/vaultBackend';
import { BookStore } from '../src/store/bookStore';
import { pluginAdapter, ROOT } from './helpers';

let adapter: MemoryAdapter;
let store: BookStore;
let backend: VaultBackend;
let deps: { readBytes: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn> };
let b1: string;
let b2: string;
let clock: number;
let ids: number;

const LOC = pdfLocation({ page: 3, start: 5, end: 9 });
const now = () => new Date(Date.UTC(2026, 10, 10, 12, 0, 0, clock++));
const uuid = () => `id-${String(++ids).padStart(3, '0')}`;
const ann = (bookId = b1, extra = {}) =>
  backend.createAnnotation({ bookId, location: LOC, quote: 'Hello', color: 'yellow', ...extra });
const message = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return String(e);
  }
  throw new Error('expected a rejection');
};

beforeEach(async () => {
  adapter = pluginAdapter();
  clock = 0;
  ids = 0;
  store = new BookStore(adapter, ROOT, { now, uuid, coalesceMs: 0 });
  await store.load();
  b1 = (await store.openPath('Books/a.pdf', '3:aaa', 'a')).book.id;
  b2 = (await store.openPath('Books/b.pdf', '3:bbb', 'b')).book.id;
  deps = { readBytes: vi.fn(async () => new ArrayBuffer(4)), confirm: vi.fn(async () => true) };
  backend = new VaultBackend(store, deps);
});

describe('VaultBackend — books', () => {
  it('progress keeps the maximum, clamped to 0–1, and rejects a non-number', async () => {
    await backend.setBookProgress(b1, 0.4);
    await backend.setBookProgress(b1, 0.2);
    expect((await store.file(b1)).book.progress).toBe(0.4);
    await backend.setBookProgress(b1, 7);
    expect((await store.file(b1)).book.progress).toBe(1);
    await backend.setBookProgress(b2, -3);
    expect((await store.file(b2)).book.progress).toBe(0);
    expect(await message(backend.setBookProgress(b1, Number.NaN))).toBe('invalid progress NaN');
  });

  it('zoom accepts fit-width, fit-page and whole 50–300 without a leading zero; null clears', async () => {
    for (const z of ['fit-width', 'fit-page', '50', '125', '300']) expect(isValidZoom(z)).toBe(true);
    for (const z of ['49', '301', '050', '1000', 'abc', '', '12.5']) expect(isValidZoom(z)).toBe(false);
    await backend.setBookZoom(b1, '125');
    expect((await store.file(b1)).book.zoom).toBe('125');
    expect(await message(backend.setBookZoom(b1, '301'))).toBe('invalid zoom "301"');
    expect((await store.file(b1)).book.zoom).toBe('125');
    await backend.setBookZoom(b1, null);
    expect((await store.file(b1)).book.zoom).toBeNull();
  });

  it('setLastLocation stores the location JSON and the opened time', async () => {
    await backend.setLastLocation(b1, LOC);
    const { book } = await store.file(b1);
    expect(book.lastLocation).toBe(serializeLocation(LOC));
    expect(book.openedAt).toMatch(/^2026-11-10T12:00:00\.\d{3}Z$/);
  });

  it('unknown books are "not found: book <id>"; reading bytes goes through the book’s current path', async () => {
    expect(await message(backend.setBookZoom('ghost', null))).toBe('not found: book ghost');
    await store.renamePath('Books/a.pdf', 'Books/moved.pdf');
    await backend.readBookBytes(b1);
    expect(deps.readBytes).toHaveBeenCalledWith('Books/moved.pdf');
  });

  it('importing and relocating are not available; listing books comes from the store', async () => {
    expect(await message(backend.importBooks(['/x.pdf']))).toBe(NOT_IN_OBSIDIAN);
    expect(await message(backend.relocateBook(b1, '/x.pdf', true))).toBe(NOT_IN_OBSIDIAN);
    expect((await backend.listBooks()).map((b) => b.id).sort()).toEqual([b1, b2].sort());
  });
});

describe('VaultBackend — annotations', () => {
  it('create stores a trimmed note, unanchored false, equal timestamps; rejects an unknown color and a blank quote', async () => {
    const a = await ann(b1, { note: '  why  ' });
    expect(a).toMatchObject({ bookId: b1, location: serializeLocation(LOC), quote: 'Hello', color: 'yellow', note: 'why', unanchored: false });
    expect(a.createdAt).toBe(a.updatedAt);
    expect((await ann(b1, { note: '   ' })).note).toBeNull();
    expect(await message(ann(b1, { color: 'orange' }))).toBe('unknown color: orange');
    expect(await message(ann(b1, { quote: '   ' }))).toBe('quote must not be empty');
  });

  it('list is ordered by createdAt then id; an unknown book lists nothing', async () => {
    const x = await ann();
    const y = await ann();
    expect((await backend.listAnnotations(b1)).map((a) => a.id)).toEqual([x.id, y.id]);
    expect(await backend.listAnnotations('ghost')).toEqual([]);
  });

  it('update changes only given fields: null keeps, "" clears the note; updatedAt moves, createdAt stays', async () => {
    const a = await ann(b1, { note: 'n' });
    const u = await backend.updateAnnotation(a.id, { color: 'blue' });
    expect(u).toMatchObject({ color: 'blue', note: 'n', location: a.location, createdAt: a.createdAt });
    expect(u.updatedAt > a.updatedAt).toBe(true);
    const kept = await backend.updateAnnotation(a.id, { note: null as unknown as string });
    expect(kept.note).toBe('n');
    expect((await backend.updateAnnotation(a.id, { note: '' })).note).toBeNull();
    const moved = pdfLocation({ page: 4, start: 0, end: 3 });
    expect((await backend.updateAnnotation(a.id, { location: moved, unanchored: true })).location).toBe(serializeLocation(moved));
    expect(await message(backend.updateAnnotation(a.id, { color: 'orange' as never }))).toBe('unknown color: orange');
    expect(await message(backend.updateAnnotation('ghost', { color: 'blue' }))).toBe('not found: annotation ghost');
  });

  it('get returns a copy; a missing one is not found', async () => {
    const a = await ann();
    const got = await backend.getAnnotation(a.id);
    got.quote = 'changed';
    expect((await backend.getAnnotation(a.id)).quote).toBe('Hello');
    expect(await message(backend.getAnnotation('ghost'))).toBe('not found: annotation ghost');
  });

  it('delete gives its thoughts its location and unlinks them, leaving their updatedAt; a second delete is not found', async () => {
    const a = await ann();
    const t = await backend.createThought({ bookId: b1, anchorId: a.id });
    await backend.deleteAnnotation(a.id);
    const [after] = await backend.listThoughts(b1);
    expect(after).toMatchObject({ id: t.id, anchorId: null, location: serializeLocation(LOC), updatedAt: t.updatedAt });
    expect(await backend.listAnnotations(b1)).toEqual([]);
    expect(await message(backend.deleteAnnotation(a.id))).toBe(`not found: annotation ${a.id}`);
  });
});

describe('VaultBackend — thoughts', () => {
  it('create: defaults, positions max + 1 per book', async () => {
    const first = await backend.createThought({ bookId: b1 });
    const second = await backend.createThought({ bookId: b1, body: 'An idea', location: LOC });
    const elsewhere = await backend.createThought({ bookId: b2 });
    expect(first).toMatchObject({
      bookId: b1, body: '', anchorId: null, location: null, position: 1,
      labelSection: null, labelSnippet: null, labelCustom: null,
    });
    expect(first.createdAt).toBe(first.updatedAt);
    expect(second).toMatchObject({ position: 2, body: 'An idea', location: serializeLocation(LOC) });
    expect(elsewhere.position).toBe(1);
    await backend.updateThought(first.id, { position: 10 });
    expect((await backend.createThought({ bookId: b1 })).position).toBe(11);
  });

  it('an anchor must be an annotation of the same book', async () => {
    const mine = await ann(b1);
    const foreign = await ann(b2);
    expect(await message(backend.createThought({ bookId: b1, anchorId: 'ghost' }))).toBe('unknown annotation ghost');
    expect(await message(backend.createThought({ bookId: b1, anchorId: foreign.id }))).toBe(
      `annotation ${foreign.id} belongs to another book`,
    );
    expect((await backend.createThought({ bookId: b1, anchorId: mine.id })).anchorId).toBe(mine.id);
  });

  it('a deleted annotation of another book is an unknown anchor, not a foreign one (ownerOf is never pruned)', async () => {
    const foreign = await ann(b2);
    await backend.deleteAnnotation(foreign.id);
    expect(await message(backend.createThought({ bookId: b1, anchorId: foreign.id }))).toBe(`unknown annotation ${foreign.id}`);
    const t = await backend.createThought({ bookId: b1, location: LOC });
    expect(await message(backend.updateThought(t.id, { anchorId: foreign.id }))).toBe(`unknown annotation ${foreign.id}`);
    expect(await message(backend.updateAnnotation(foreign.id, { color: 'blue' }))).toBe(`not found: annotation ${foreign.id}`);
    expect(await message(backend.getAnnotation(foreign.id))).toBe(`not found: annotation ${foreign.id}`);
  });

  it('list is ordered by position, then id', async () => {
    const x = await backend.createThought({ bookId: b1 });
    const y = await backend.createThought({ bookId: b1 });
    await backend.updateThought(y.id, { position: 0.5 });
    expect((await backend.listThoughts(b1)).map((t) => t.id)).toEqual([y.id, x.id]);
    await backend.updateThought(x.id, { position: 0.5 });
    expect((await backend.listThoughts(b1)).map((t) => t.id)).toEqual([x.id, y.id]);
    expect(await backend.listThoughts('ghost')).toEqual([]);
  });

  it('update: absent keeps, null clears or unlinks; body and position null keep; updatedAt moves, labels stay', async () => {
    const a = await ann();
    const t = await backend.createThought({ bookId: b1, anchorId: a.id, body: 'b' });
    await backend.setThoughtAutoLabels(t.id, 'Ch 1', 'p. 3');
    const u = await backend.updateThought(t.id, { body: 'Edited [[Link]]\n' });
    expect(u).toMatchObject({ body: 'Edited [[Link]]\n', anchorId: a.id, location: null, position: t.position, createdAt: t.createdAt });
    expect(u.updatedAt > t.updatedAt).toBe(true);
    expect(u).toMatchObject({ labelSection: 'Ch 1', labelSnippet: 'p. 3' });
    const unlinked = await backend.updateThought(t.id, { anchorId: null, location: LOC, position: 0.5 });
    expect(unlinked).toMatchObject({ anchorId: null, location: serializeLocation(LOC), position: 0.5 });
    const kept = await backend.updateThought(t.id, { body: null as unknown as string, position: null as unknown as number });
    expect(kept).toMatchObject({ body: 'Edited [[Link]]\n', position: 0.5 });
    expect((await backend.updateThought(t.id, { location: null })).location).toBeNull();
  });

  it('anchoring clears the location, even when the same patch names one; a foreign anchor changes nothing', async () => {
    const a = await ann(b1);
    const foreign = await ann(b2);
    const t = await backend.createThought({ bookId: b1, location: LOC });
    expect(await backend.updateThought(t.id, { anchorId: a.id, location: LOC })).toMatchObject({ anchorId: a.id, location: null });
    const u = await backend.createThought({ bookId: b1, location: LOC, body: 'x' });
    expect(await message(backend.updateThought(u.id, { anchorId: foreign.id, body: 'y' }))).toBe(
      `annotation ${foreign.id} belongs to another book`,
    );
    expect((await backend.listThoughts(b1)).find((x) => x.id === u.id)).toMatchObject({ anchorId: null, body: 'x', location: serializeLocation(LOC) });
  });

  it('a custom label is stored trimmed; null or blank restores the automatic one; absent keeps it', async () => {
    const t = await backend.createThought({ bookId: b1 });
    expect((await backend.updateThought(t.id, { labelCustom: '  My idea ' })).labelCustom).toBe('My idea');
    expect((await backend.updateThought(t.id, { body: 'b' })).labelCustom).toBe('My idea');
    expect((await backend.updateThought(t.id, { labelCustom: '   ' })).labelCustom).toBeNull();
    await backend.updateThought(t.id, { labelCustom: 'x' });
    expect((await backend.updateThought(t.id, { labelCustom: null })).labelCustom).toBeNull();
    expect(await message(backend.updateThought('ghost', { body: 'x' }))).toBe('not found: thought ghost');
  });

  it('automatic labels: trimmed, blank section is null, blank snippet rejected first; body, custom label and updatedAt untouched', async () => {
    const t = await backend.createThought({ bookId: b1, body: 'An idea' });
    const named = await backend.updateThought(t.id, { labelCustom: 'Mine' });
    const u = await backend.setThoughtAutoLabels(t.id, ' Chapter 2 ', ' p. 42 · “The law…” ');
    expect(u).toMatchObject({ labelSection: 'Chapter 2', labelSnippet: 'p. 42 · “The law…”', labelCustom: 'Mine', body: 'An idea', updatedAt: named.updatedAt });
    expect((await backend.setThoughtAutoLabels(t.id, '  ', 'p. 3')).labelSection).toBeNull();
    expect(await message(backend.setThoughtAutoLabels(t.id, null, '  '))).toBe('an automatic label needs a snippet');
    expect((await backend.listThoughts(b1))[0].labelSnippet).toBe('p. 3');
    expect(await message(backend.setThoughtAutoLabels('ghost', null, '  '))).toBe('an automatic label needs a snippet');
    expect(await message(backend.setThoughtAutoLabels('ghost', null, 'p. 1'))).toBe('not found: thought ghost');
  });

  it('delete, then not found', async () => {
    const t = await backend.createThought({ bookId: b1 });
    await backend.deleteThought(t.id);
    expect(await backend.listThoughts(b1)).toEqual([]);
    expect(await message(backend.deleteThought(t.id))).toBe(`not found: thought ${t.id}`);
  });

  it('a deleted thought stays not found for every call, though ownerOf still names its book', async () => {
    const t = await backend.createThought({ bookId: b1, body: 'gone' });
    await backend.deleteThought(t.id);
    expect(store.ownerOf(t.id)).toBe(b1);
    expect(await message(backend.updateThought(t.id, { body: 'x' }))).toBe(`not found: thought ${t.id}`);
    expect(await message(backend.setThoughtAutoLabels(t.id, null, 'p. 1'))).toBe(`not found: thought ${t.id}`);
    expect(await backend.listThoughts(b1)).toEqual([]);
  });

  it('a failed write rejects the call and leaves the stored body as it was (bodySaves then retries)', async () => {
    const t = await backend.createThought({ bookId: b1, body: 'saved' });
    adapter.failOn('write', `${ROOT}/books/${b1}.json.tmp`);
    await expect(backend.updateThought(t.id, { body: 'lost?' })).rejects.toThrow('write failed');
    expect((await backend.listThoughts(b1))[0].body).toBe('saved');
    await backend.updateThought(t.id, { body: 'retried' });
    expect((await backend.listThoughts(b1))[0].body).toBe('retried');
  });

  it('confirm goes to the host dialog', async () => {
    await expect(backend.confirm('Delete?', { title: 'Delete Thought', kind: 'warning' })).resolves.toBe(true);
    expect(deps.confirm).toHaveBeenCalledWith('Delete?', { title: 'Delete Thought', kind: 'warning' });
  });
});

describe('VaultBackend — list order and empty anchor', () => {
  const scripted = async (times: number[], idq: string[]) => {
    let cur = 0;
    let u = 0;
    let scriptedOn = false;
    const st = new BookStore(pluginAdapter(), ROOT, {
      now: () => new Date(Date.UTC(2026, 10, 10, 12, 0, 0, scriptedOn ? cur : 0)),
      uuid: () => (scriptedOn ? idq[u++] : `book-${++ids}`),
      coalesceMs: 0,
    });
    await st.load();
    const bk = (await st.openPath('Books/q.pdf', '3:qqq', 'q')).book.id;
    scriptedOn = true;
    const be = new VaultBackend(st, deps);
    return { be, bk, make: (be2: VaultBackend, b: string) => Promise.all([]).then(async () => {
      for (const ms of times) {
        cur = ms;
        await be2.createAnnotation({ bookId: b, location: LOC, quote: 'q', color: 'yellow' });
      }
    }) };
  };
  it('annotations with the same createdAt sort by id, opposite to insertion order', async () => {
    const { be, bk, make } = await scripted([5, 5, 5], ['z', 'm', 'a']);
    await make(be, bk);
    expect((await be.listAnnotations(bk)).map((x) => x.id)).toEqual(['a', 'm', 'z']);
  });

  it('annotations sort by createdAt, which differs from both insertion order and id order', async () => {
    // insertion: a(30) b(10) c(20); id order a<b<c; createdAt order b, c, a
    const { be, bk, make } = await scripted([30, 10, 20], ['a', 'b', 'c']);
    await make(be, bk);
    expect((await be.listAnnotations(bk)).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('thoughts at equal position sort by id, opposite to insertion order', async () => {
    const t1 = await backend.createThought({ bookId: b1, body: 'one' });
    const t2 = await backend.createThought({ bookId: b1, body: 'two' });
    // force equal positions and ids that sort opposite to insertion order
    await store.mutate(b1, (f) => {
      f.thoughts[0].id = 'zz';
      f.thoughts[1].id = 'aa';
      f.thoughts[0].position = f.thoughts[1].position = 5;
    });
    expect(t1.id).not.toBe(t2.id);
    expect((await backend.listThoughts(b1)).map((t) => t.id)).toEqual(['aa', 'zz']);
  });

  it('an empty anchorId is validated and rejected like any unknown annotation', async () => {
    expect(await message(backend.createThought({ bookId: b1, anchorId: '' }))).toBe('unknown annotation ');
    const t = await backend.createThought({ bookId: b1, body: 'x' });
    expect(await message(backend.updateThought(t.id, { anchorId: '' }))).toBe('unknown annotation ');
  });
});

describe('VaultBackend — a merged highlight (H1)', () => {
  it('says it takes a quote; update replaces quote and location together, keeps the id; a blank quote is refused and changes nothing', async () => {
    expect(backend.patchesQuote).toBe(true);
    const a = await ann();
    const union = pdfLocation({ page: 3, start: 2, end: 14 });
    const u = await backend.updateAnnotation(a.id, { location: union, quote: 'llo, world!', color: 'green' });
    expect(u).toMatchObject({ id: a.id, location: serializeLocation(union), quote: 'llo, world!', color: 'green' });
    expect((await backend.listAnnotations(b1)).map((x) => x.quote)).toEqual(['llo, world!']);
    expect(await message(backend.updateAnnotation(a.id, { quote: '  ', location: LOC }))).toBe('quote must not be empty');
    expect(await backend.getAnnotation(a.id)).toMatchObject({ quote: 'llo, world!', location: serializeLocation(union) });
    expect((await backend.updateAnnotation(a.id, { quote: null as unknown as string })).quote).toBe('llo, world!');
  });
});
