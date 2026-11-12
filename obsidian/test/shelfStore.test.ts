import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryAdapter } from 'obsidian';
import { BookStore, POSITION_SUMMARY_MS, SUMMARY_COALESCE_MS, summarize, validSummary } from '../src/store/bookStore';
import type { BookFile, IndexFile } from '../src/store/types';
import { pluginAdapter, ROOT } from './helpers';


let adapter: MemoryAdapter;
let clock: number;
let ids: number;
const now = () => new Date(2026, 10, 10, 9, 30, 0, clock++);
const uuid = () => `id-${String(++ids).padStart(3, '0')}`;
const make = (summaryDelayMs = 10_000) => new BookStore(adapter, ROOT, { now, uuid, coalesceMs: 0, summaryDelayMs });
const indexOnDisk = () => JSON.parse(adapter.files.get(`${ROOT}/index.json`) as string) as IndexFile;
const indexWrites = () => adapter.calls.filter((c) => c === `write ${ROOT}/index.json.tmp`).length;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const annotation = (id: string, updatedAt: string) =>
  ({ id, bookId: 'id-001', location: '', quote: 'q', color: 'yellow', note: null, unanchored: false, createdAt: updatedAt, updatedAt }) as BookFile['annotations'][number];
const thought = (id: string, createdAt: string, updatedAt = createdAt) =>
  ({ id, bookId: 'id-001', body: 'b', anchorId: null, location: null, position: 1, createdAt, updatedAt, labelSection: null, labelSnippet: null, labelCustom: null }) as BookFile['thoughts'][number];

beforeEach(() => {
  adapter = pluginAdapter();
  clock = 0;
  ids = 0;
});

describe('summarize', () => {
  it('counts, title, progress, the page of the last location, thoughts by local month and the newest change', () => {
    const f = {
      version: 1,
      book: {
        id: 'id-001', contentHash: '', path: 'a.pdf', format: 'pdf', title: 'A', author: null,
        lastLocation: JSON.stringify({ kind: 'pdf', value: { page: 42, start: 0, end: 0 }, label: 'p. 42' }),
        addedAt: '2026-01-01T00:00:00.000Z', openedAt: '2026-03-01T00:00:00.000Z', zoom: null, progress: 0.4,
      },
      annotations: [annotation('h1', '2026-04-01T00:00:00.000Z')],
      thoughts: [thought('t1', '2026-05-10T12:00:00.000Z'), thought('t2', '2026-05-11T12:00:00.000Z', '2026-06-01T00:00:00.000Z')],
    } as BookFile;
    expect(summarize(f)).toEqual({
      title: 'A', progress: 0.4, page: 42, annotationCount: 1, thoughtCount: 2,
      thoughtsByMonth: { '2026-05': 2 }, updatedAt: '2026-06-01T00:00:00.000Z',
    });
  });
});

describe('BookStore: index summaries', () => {
  it('a book write puts its summary in the index; flush writes it at once', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'A');
    await s.mutate(book.id, (f) => {
      f.book.progress = 0.5;
      f.annotations.push(annotation('h1', '2026-11-10T08:00:00.000Z'));
      f.thoughts.push(thought('t1', '2026-11-10T08:00:00.000Z'));
    });
    expect(indexOnDisk().entries['Books/a.pdf'].summary).toBeUndefined();
    await s.flush();
    expect(indexOnDisk().entries['Books/a.pdf'].summary).toMatchObject({ title: 'A', progress: 0.5, annotationCount: 1, thoughtCount: 1 });
  });

  it('a write changes its own book’s summary only', async () => {
    const s = make();
    await s.load();
    const a = await s.openPath('Books/a.pdf', '1:x', 'A');
    const b = await s.openPath('Books/b.pdf', '2:y', 'B');
    await s.mutate(a.book.id, (f) => void (f.book.progress = 0.1));
    await s.mutate(b.book.id, (f) => void (f.book.progress = 0.2));
    await s.flush();
    await s.mutate(a.book.id, (f) => void (f.book.progress = 0.7));
    await s.flush();
    const entries = indexOnDisk().entries;
    expect(entries['Books/a.pdf'].summary).toMatchObject({ title: 'A', progress: 0.7 });
    expect(entries['Books/b.pdf'].summary).toMatchObject({ title: 'B', progress: 0.2 });
  });

  it('book writes close together become one index write, after the delay, without a flush', async () => {
    const s = make(30);
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'A');
    const before = indexWrites();
    for (const p of [0.1, 0.2, 0.3]) await s.mutate(book.id, (f) => void (f.book.progress = p));
    expect(indexWrites()).toBe(before);
    await wait(80);
    expect(indexWrites()).toBe(before + 1);
    expect(indexOnDisk().entries['Books/a.pdf'].summary?.progress).toBe(0.3);
  });

  it('an unchanged summary writes no index', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'A');
    await s.mutate(book.id, (f) => void (f.book.progress = 0.2));
    await s.flush();
    const before = indexWrites();
    await s.mutate(book.id, (f) => void (f.book.zoom = '125'));
    await s.flush();
    expect(indexWrites()).toBe(before);
  });

  it('an index without summaries loads; the grid reads no book file; the first load of a book fills its summary in', async () => {
    adapter.folders.add(`${ROOT}/books`);
    adapter.folders.add(`${ROOT}/backups`);
    const file: BookFile = {
      version: 1,
      book: { id: 'b1', contentHash: '1:x', path: 'Books/a.pdf', format: 'pdf', title: 'Old', author: null, lastLocation: null, addedAt: '2026-01-01T00:00:00.000Z', openedAt: null, zoom: null, progress: 1 },
      annotations: [annotation('h1', '2026-01-02T00:00:00.000Z')],
      thoughts: [],
    };
    adapter.files.set(`${ROOT}/books/b1.json`, JSON.stringify(file));
    adapter.files.set(`${ROOT}/index.json`, JSON.stringify({ version: 1, entries: { 'Books/a.pdf': { bookId: 'b1', fingerprint: '1:x', missing: false } } }));
    const s = make();
    await s.load();
    const reads = vi.spyOn(adapter, 'read');
    expect(s.shelfEntries()).toEqual([{ path: 'Books/a.pdf', bookId: 'b1', missing: false, openedAt: null, summary: null }]);
    expect(reads).not.toHaveBeenCalled();
    await s.file('b1');
    expect(s.shelfEntries()[0].summary).toMatchObject({ title: 'Old', progress: 1, annotationCount: 1 });
    await s.flush();
    expect(indexOnDisk().entries['Books/a.pdf'].summary).toMatchObject({ title: 'Old', annotationCount: 1 });
    // A new store reads it from the index, not the book file.
    const t = make();
    await t.load();
    reads.mockClear();
    expect(t.shelfEntries()[0].summary).toMatchObject({ title: 'Old', annotationCount: 1 });
    expect(reads).not.toHaveBeenCalled();
  });

  it('a reported page count is kept across later writes of the book', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'A');
    s.setPageCount(book.id, 310);
    s.setPageCount(book.id, 0); // ignored
    await s.flush();
    expect(indexOnDisk().entries['Books/a.pdf'].summary?.pageCount).toBe(310);
    await s.mutate(book.id, (f) => void (f.book.progress = 0.9));
    await s.flush();
    expect(indexOnDisk().entries['Books/a.pdf'].summary).toMatchObject({ pageCount: 310, progress: 0.9 });
    expect(s.shelfEntries()[0].summary?.pageCount).toBe(310);
  });

  it('a summary goes through the index operations: a move queued before it is not undone', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'A');
    await s.mutate(book.id, (f) => void (f.book.progress = 0.4));
    // The summary is waiting; the file moves before it is applied.
    await s.renamePath('Books/a.pdf', 'Shelf/a.pdf');
    await s.flush();
    const entries = indexOnDisk().entries;
    expect(Object.keys(entries)).toEqual(['Shelf/a.pdf']);
    expect(entries['Shelf/a.pdf'].summary?.progress).toBe(0.4);
  });

  it('nothing is written to the index after close()', async () => {
    const s = make(20);
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'A');
    await s.mutate(book.id, (f) => void (f.book.progress = 0.4));
    const before = indexWrites();
    s.close();
    await wait(60);
    expect(indexWrites()).toBe(before);
  });

  it('shelfEntries leaves orphans out and keeps the missing flag; index changes are announced', async () => {
    const s = make();
    await s.load();
    const heard = vi.fn();
    s.onIndexChange(heard);
    await s.openPath('Books/a.pdf', '1:x', 'A');
    await s.openPath('Books/b.pdf', '2:y', 'B');
    await s.markMissing('Books/b.pdf');
    expect(heard).toHaveBeenCalled();
    // b displaced by a rename: it stays as an orphan
    await s.renamePath('Books/a.pdf', 'Books/b.pdf');
    expect(s.shelfEntries().map((e) => [e.path, e.missing])).toEqual([['Books/b.pdf', false]]);
  });
});

// ---- fix round 1 ----

const validStored = { title: 'Kept', progress: 0.5, page: 3, pageCount: 9, annotationCount: 2, thoughtCount: 1, thoughtsByMonth: { '2026-11': 1 }, updatedAt: '2026-11-01T00:00:00.000Z' };

/** A store folder with these book files, and index.json written as this raw text. */
function seed(indexText: string, books: BookFile[] = []) {
  adapter.folders.add(`${ROOT}/books`);
  adapter.folders.add(`${ROOT}/backups`);
  for (const b of books) adapter.files.set(`${ROOT}/books/${b.book.id}.json`, JSON.stringify(b));
  adapter.files.set(`${ROOT}/index.json`, indexText);
}

const bookOf = (id: string, path: string, extra: Partial<BookFile> = {}): BookFile => ({
  version: 1,
  book: { id, contentHash: '1:x', path, format: 'pdf', title: null, author: null, lastLocation: null, addedAt: '2026-01-01T00:00:00.000Z', openedAt: null, zoom: null, progress: null },
  annotations: [],
  thoughts: [],
  ...extra,
});

const pos = (page: number) => JSON.stringify({ kind: 'pdf', value: { page, start: 0, end: 0 }, label: `p. ${page}` });

describe('validSummary', () => {
  it('keeps a well-formed summary (unknown fields dropped) and rejects each bad field', () => {
    expect(validSummary({ ...validStored, openedAt: 'x' })).toEqual(validStored);
    const { pageCount: _unused, ...noCount } = validStored;
    expect(validSummary({ ...noCount, title: null, progress: null, page: null })).toEqual({ ...noCount, title: null, progress: null, page: null });
    for (const bad of [
      'a summary', null, [], 42,
      { ...validStored, title: 5 },
      { ...validStored, progress: Number.NaN },
      { ...validStored, progress: Number.POSITIVE_INFINITY },
      { ...validStored, progress: '0.5' },
      { ...validStored, page: 'p. 3' },
      { ...validStored, pageCount: 0 },
      { ...validStored, pageCount: 2.5 },
      { ...validStored, annotationCount: -1 },
      { ...validStored, thoughtCount: undefined },
      { ...validStored, thoughtsByMonth: null },
      { ...validStored, thoughtsByMonth: [1] },
      { ...validStored, thoughtsByMonth: { '2026-11': '1' } },
      { ...validStored, updatedAt: 0 },
    ]) {
      expect(validSummary(bad)).toBeNull();
    }
  });
});

describe('BookStore: a bad summary in index.json', () => {
  it('is dropped and its entry kept; a good one stays', async () => {
    // Raw text: 1e999 parses as Infinity, which JSON.stringify could never write.
    seed(`{"version":1,"entries":{
      "Books/a.pdf":{"bookId":"a","fingerprint":"1:a","missing":false,"summary":"not a summary"},
      "Books/b.pdf":{"bookId":"b","fingerprint":"1:b","missing":false,"summary":${JSON.stringify(validStored).replace('"progress":0.5', '"progress":1e999')}},
      "Books/c.pdf":{"bookId":"c","fingerprint":"1:c","missing":false,"openedAt":"2026-11-02T00:00:00.000Z","summary":${JSON.stringify({ ...validStored, thoughtsByMonth: { '2026-11': 'many' } })}},
      "Books/d.pdf":{"bookId":"d","fingerprint":"1:d","missing":true,"summary":${JSON.stringify({ ...validStored, openedAt: null })}}
    }}`);
    const s = make();
    const recovered = vi.fn();
    s.onRecovery(recovered);
    await s.load();
    expect(recovered).not.toHaveBeenCalled(); // not a corrupt index: nothing is rebuilt or kept aside
    expect(s.shelfEntries()).toEqual([
      { path: 'Books/a.pdf', bookId: 'a', missing: false, openedAt: null, summary: null },
      { path: 'Books/b.pdf', bookId: 'b', missing: false, openedAt: null, summary: null },
      { path: 'Books/c.pdf', bookId: 'c', missing: false, openedAt: '2026-11-02T00:00:00.000Z', summary: null },
      { path: 'Books/d.pdf', bookId: 'd', missing: true, openedAt: null, summary: validStored },
    ]);
    expect(s.entry('Books/c.pdf')).toEqual({ bookId: 'c', fingerprint: '1:c', missing: false, openedAt: '2026-11-02T00:00:00.000Z' });
  });

  it('summarize never hands on a progress or page that is not a finite number', () => {
    const f = bookOf('a', 'a.pdf');
    f.book.progress = Number.NaN;
    expect(summarize(f).progress).toBeNull();
    const g = bookOf('a', 'a.pdf');
    g.book.progress = Number.POSITIVE_INFINITY;
    g.book.lastLocation = JSON.stringify({ kind: 'pdf', value: { page: 'x', start: 0, end: 0 }, label: '' });
    expect(summarize(g)).toMatchObject({ progress: null, page: null });
  });

  it('a summary that went bad in memory is not copied forward, nor its page count shown', async () => {
    seed(JSON.stringify({ version: 1, entries: {
      'Books/a.pdf': { bookId: 'a', fingerprint: '1:a', missing: false },
      'Books/b.pdf': { bookId: 'b', fingerprint: '1:b', missing: false },
    } }), [bookOf('a', 'Books/a.pdf'), bookOf('b', 'Books/b.pdf')]);
    const s = make();
    await s.load();
    const entries = (s as unknown as { index: IndexFile }).index.entries;
    // a: loaded, with a summary whose page count is not one.
    await s.file('a');
    entries['Books/a.pdf'].summary = { ...validStored, pageCount: 'many' } as never;
    expect(s.shelfEntries()[0].summary?.pageCount).toBeUndefined();
    // b: not loaded, a summary with a bad title; a page count report must not carry it into the index.
    entries['Books/b.pdf'].summary = { ...validStored, title: 5 } as never;
    s.setPageCount('b', 10);
    await s.flush();
    const disk = indexOnDisk().entries;
    // Left as it was (the whole index is written for a's summary), not made into a "summary" with the new count.
    expect(disk['Books/b.pdf'].summary).toEqual({ ...validStored, title: 5 });
    expect(disk['Books/a.pdf'].summary?.pageCount).toBeUndefined();
  });
});

describe('BookStore: reading does not rewrite the index each page', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A store on fake timers: each step runs the timers it needs. */
  async function reading() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = new BookStore(adapter, ROOT, { now, uuid, coalesceMs: 0 });
    const run = async <T>(p: Promise<T>) => {
      await vi.advanceTimersByTimeAsync(1);
      return p;
    };
    await run(s.load());
    const { book } = await run(s.openPath('Books/a.pdf', '1:x', 'A'));
    // Written long before the reading below: an opened time counted as a change would show.
    await run(s.mutate(book.id, (f) => void f.annotations.push(annotation('h1', '2026-01-10T08:00:00.000Z'))));
    await run(s.flush());
    expect(indexOnDisk().entries['Books/a.pdf'].summary).toMatchObject({ annotationCount: 1 });
    const turn = (page: number) =>
      run(s.mutate(book.id, (f) => {
        f.book.lastLocation = pos(page);
        f.book.progress = page / 100;
        f.book.openedAt = now().toISOString();
      }));
    return { s, id: book.id, run, turn };
  }

  it('position-only saves write no index until the long timer', async () => {
    const { turn } = await reading();
    const before = indexWrites();
    for (let p = 1; p <= 10; p++) await turn(p);
    await vi.advanceTimersByTimeAsync(SUMMARY_COALESCE_MS * 4);
    expect(indexWrites()).toBe(before);
    await vi.advanceTimersByTimeAsync(POSITION_SUMMARY_MS);
    expect(indexWrites()).toBe(before + 1);
    expect(indexOnDisk().entries['Books/a.pdf'].summary).toMatchObject({ progress: 0.1, page: 10, annotationCount: 1 });
  });

  it('flush writes waiting position-only summaries', async () => {
    const { s, run, turn } = await reading();
    const before = indexWrites();
    for (let p = 1; p <= 10; p++) await turn(p);
    expect(indexWrites()).toBe(before);
    await run(s.flush());
    expect(indexWrites()).toBe(before + 1);
    expect(indexOnDisk().entries['Books/a.pdf'].summary).toMatchObject({ progress: 0.1, page: 10 });
  });

  it('an annotation change writes within the debounce, carrying the position with it', async () => {
    const { s, id, run, turn } = await reading();
    const before = indexWrites();
    await turn(5);
    await run(s.mutate(id, (f) => void f.annotations.push(annotation('h2', '2026-11-10T09:00:00.000Z'))));
    await vi.advanceTimersByTimeAsync(SUMMARY_COALESCE_MS + 1);
    expect(indexWrites()).toBe(before + 1);
    expect(indexOnDisk().entries['Books/a.pdf'].summary).toMatchObject({ annotationCount: 2, page: 5 });
  });

  it('a page count report is structural', async () => {
    const { s, id } = await reading();
    const before = indexWrites();
    s.setPageCount(id, 300);
    await vi.advanceTimersByTimeAsync(SUMMARY_COALESCE_MS + 1);
    expect(indexWrites()).toBe(before + 1);
  });

  it('a write-count bound: fifty page turns over two minutes, then the view closes: one index write', async () => {
    const { s, run, turn } = await reading();
    const before = indexWrites();
    for (let p = 1; p <= 50; p++) {
      await turn(p);
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(indexWrites()).toBe(before);
    await run(s.flush());
    expect(indexWrites()).toBe(before + 1);
  });

  it('a failed summary write is queued again and lands on the next flush', async () => {
    const { s, run } = await reading();
    s.setPageCount((await run(s.peekFile(s.bookIdForPath('Books/a.pdf')!))).book.id, 300);
    adapter.failOn('write', `${ROOT}/index.json.tmp`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(SUMMARY_COALESCE_MS + 1);
    expect(warn).toHaveBeenCalledWith('margin: could not save book summaries', expect.anything());
    expect(indexOnDisk().entries['Books/a.pdf'].summary?.pageCount).toBeUndefined();
    await run(s.flush());
    expect(indexOnDisk().entries['Books/a.pdf'].summary?.pageCount).toBe(300);
    warn.mockRestore();
  });
});

describe('BookStore: a failed book write', () => {
  it('leaves the index summary as it was', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'A');
    await s.mutate(book.id, (f) => void f.annotations.push(annotation('h1', '2026-11-10T08:00:00.000Z')));
    await s.flush();
    const before = indexOnDisk().entries['Books/a.pdf'].summary;
    expect(before).toMatchObject({ annotationCount: 1 });
    adapter.failOn('write', `${ROOT}/books/${book.id}.json.tmp`);
    await expect(s.mutate(book.id, (f) => void f.annotations.push(annotation('h2', '2026-11-10T09:00:00.000Z')))).rejects.toThrow('write failed');
    await s.flush();
    expect(indexOnDisk().entries['Books/a.pdf'].summary).toEqual(before);
    expect(s.shelfEntries()[0].summary).toMatchObject({ annotationCount: 1 });
  });
});

describe('BookStore: peekFile and the summarize cache', () => {
  it('reads a book without keeping it: no slot, no ids tracked; a loaded book comes back live', async () => {
    const book = bookOf('a', 'Books/a.pdf', { annotations: [annotation('h1', '2026-01-02T00:00:00.000Z')] });
    // The index's summary is what the file gives: reading it queues nothing.
    seed(JSON.stringify({ version: 1, entries: { 'Books/a.pdf': { bookId: 'a', fingerprint: '1:a', missing: false, summary: summarize(book) } } }), [book]);
    const s = make();
    await s.load();
    const writes = indexWrites();
    const f = await s.peekFile('a');
    expect(f.annotations.map((x) => x.id)).toEqual(['h1']);
    expect(s.peek('a')).toBeNull();
    expect(s.ownerOf('h1')).toBeNull();
    expect(await s.peekFile('a')).not.toBe(f); // read again: nothing kept
    await s.flush();
    expect(indexWrites()).toBe(writes); // it had a summary: nothing queued
    const live = await s.file('a');
    expect(await s.peekFile('a')).toBe(live);
    await expect(s.peekFile('nope')).rejects.toThrow('not found: book nope');
  });

  it('fills in a summary the index lacks', async () => {
    seed(JSON.stringify({ version: 1, entries: { 'Books/a.pdf': { bookId: 'a', fingerprint: '1:a', missing: false } } }), [bookOf('a', 'Books/a.pdf', { thoughts: [thought('t1', '2026-01-02T00:00:00.000Z')] })]);
    const s = make();
    await s.load();
    await s.peekFile('a');
    expect(s.peek('a')).toBeNull();
    await s.flush();
    expect(indexOnDisk().entries['Books/a.pdf'].summary).toMatchObject({ thoughtCount: 1 });
  });

  it('a peek queues a summary that is behind the file: structural at once, position-only on the long timer, equal not at all', async () => {
    const book = bookOf('a', 'Books/a.pdf', { annotations: [annotation('h1', '2026-01-02T00:00:00.000Z')] });
    const stored = summarize(book);
    const run = async (summary: unknown, onDisk: BookFile) => {
      adapter = pluginAdapter();
      seed(JSON.stringify({ version: 1, entries: { 'Books/a.pdf': { bookId: 'a', fingerprint: '1:a', missing: false, summary } } }), [onDisk]);
      const s = make(30);
      await s.load();
      const writes = indexWrites();
      await s.peekFile('a');
      return { s, writes };
    };
    // Structural: the file has a highlight the summary does not count. Written after the short delay.
    let r = await run({ ...stored, annotationCount: 0 }, book);
    await wait(120);
    expect(indexWrites()).toBe(r.writes + 1);
    expect(indexOnDisk().entries['Books/a.pdf'].summary).toMatchObject({ annotationCount: 1 });
    // Position only: waits for the long timer (flush brings it).
    r = await run({ ...stored, progress: 0.9, page: 7 }, book);
    await wait(120);
    expect(indexWrites()).toBe(r.writes);
    await r.s.flush();
    expect(indexWrites()).toBe(r.writes + 1);
    expect(indexOnDisk().entries['Books/a.pdf'].summary).toMatchObject({ progress: null, page: null });
    // Equal: nothing, even on flush.
    r = await run(stored, book);
    await wait(120);
    await r.s.flush();
    expect(indexWrites()).toBe(r.writes);
  });

  it('summarize is computed once per book object', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'A');
    const live = s.peek(book.id)!;
    expect(summarize(live)).toBe(summarize(live));
    const first = summarize(live);
    await s.mutate(book.id, (f) => void (f.book.progress = 0.3));
    // A change replaces the live book: a new summary, the old one untouched.
    expect(summarize(s.peek(book.id)!)).not.toBe(first);
    expect(summarize(s.peek(book.id)!).progress).toBe(0.3);
    expect(first.progress).toBeNull();
    // Callers copy before adding a page count: the cached one never gets one.
    s.setPageCount(book.id, 12);
    await s.flush();
    expect(s.shelfEntries()[0].summary?.pageCount).toBe(12);
    expect(summarize(s.peek(book.id)!).pageCount).toBeUndefined();
  });
});

describe('summarize: an epub', () => {
  it('the page of the last location is its section', () => {
    const f = {
      version: 1,
      book: {
        id: 'id-002', contentHash: '', path: 'm.epub', format: 'epub', title: 'M', author: null,
        lastLocation: JSON.stringify({ kind: 'epub', value: { section: 9, start: 0, end: 0 }, label: '§ 9' }),
        addedAt: '2026-01-01T00:00:00.000Z', openedAt: null, zoom: null, progress: 0.1,
      },
      annotations: [],
      thoughts: [],
    } as unknown as BookFile;
    expect(summarize(f).page).toBe(9);
  });
});
