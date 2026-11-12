import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryAdapter } from 'obsidian';
import { BACKUPS_KEPT, BookStore, WRITE_COALESCE_MS, type RecoveryEvent } from '../src/store/bookStore';
import { fingerprint, sha256Hex } from '../src/store/hash';
import type { BookFile } from '../src/store/types';
import { pluginAdapter, ROOT } from './helpers';

let adapter: MemoryAdapter;
let clock: number;
let ids: number;
const now = () => new Date(2026, 10, 10, 9, 30, 0, clock++);
const uuid = () => `id-${String(++ids).padStart(3, '0')}`;
const make = (coalesceMs = 0) => new BookStore(adapter, ROOT, { now, uuid, coalesceMs });
const onDisk = (id: string) => JSON.parse(adapter.files.get(`${ROOT}/books/${id}.json`) as string) as BookFile;

beforeEach(() => {
  adapter = pluginAdapter();
  clock = 0;
  ids = 0;
});

describe('BookStore', () => {
  it('load() creates the books and backups folders and starts with an empty index', async () => {
    const s = make();
    await s.load();
    expect(adapter.folders.has(`${ROOT}/books`)).toBe(true);
    expect(adapter.folders.has(`${ROOT}/backups`)).toBe(true);
    expect(s.bookIdForPath('Books/a.pdf')).toBeNull();
  });

  it('openPath creates a book from the file and persists it with its index entry', async () => {
    const s = make();
    await s.load();
    const f = await s.openPath('Books/Walden.pdf', '10:abc', 'Walden');
    expect(f.version).toBe(1);
    expect(f.book).toEqual({
      id: 'id-001', contentHash: '10:abc', path: 'Books/Walden.pdf', format: 'pdf', title: 'Walden', author: null,
      lastLocation: null, addedAt: f.book.addedAt, openedAt: null, zoom: null, progress: null,
    });
    expect(f.book.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(onDisk('id-001')).toEqual({ version: 1, book: f.book, annotations: [], thoughts: [] });
    expect(JSON.parse(adapter.files.get(`${ROOT}/index.json`) as string)).toEqual({
      version: 1,
      entries: { 'Books/Walden.pdf': { bookId: 'id-001', fingerprint: '10:abc', missing: false } },
    });
  });

  it('opening the same path again returns the same book', async () => {
    const s = make();
    await s.load();
    const a = await s.openPath('Books/a.pdf', '1:x', 'a');
    const b = await s.openPath('Books/a.pdf', '1:x', 'a');
    expect(b.book.id).toBe(a.book.id);
  });

  it('mutate shows at once and resolves after the write; the index survives a new store', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
    const p = s.mutate(book.id, (f) => {
      f.book.zoom = '125';
      return 'done';
    });
    expect(s.peek(book.id)?.book.zoom).toBe('125');
    await expect(p).resolves.toBe('done');
    expect(onDisk(book.id).book.zoom).toBe('125');
    const again = make();
    await again.load();
    expect(again.bookIdForPath('Books/a.pdf')).toBe(book.id);
    expect((await again.file(book.id)).book.zoom).toBe('125');
  });

  it('coalesces mutations made close together into one write', async () => {
    const s = make(20);
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
    adapter.calls.length = 0;
    await Promise.all([1, 2, 3].map((n) => s.mutate(book.id, (f) => void (f.book.progress = n / 10))));
    expect(adapter.calls.filter((c) => c === `write ${ROOT}/books/${book.id}.json.tmp`)).toHaveLength(1);
    expect(onDisk(book.id).book.progress).toBe(0.3);
  });

  it('writes atomically: tmp, remove the old file, rename the tmp into place', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
    adapter.calls.length = 0;
    await s.mutate(book.id, (f) => void (f.book.zoom = 'fit-page'));
    const main = `${ROOT}/books/${book.id}.json`;
    const io = adapter.calls.filter((c) => c.endsWith(main) || c.endsWith(`${main}.tmp`));
    expect(io).toEqual([`write ${main}.tmp`, `exists ${main}`, `remove ${main}`, `rename ${main}.tmp`]);
  });

  it('a failed write rejects its mutations and rolls back to what is on disk; the next one still lands', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
    adapter.failOn('write', `${ROOT}/books/${book.id}.json.tmp`);
    await expect(s.mutate(book.id, (f) => void (f.book.zoom = '200'))).rejects.toThrow('write failed');
    expect(s.peek(book.id)?.book.zoom).toBeNull();
    await s.mutate(book.id, (f) => void (f.book.zoom = '150'));
    expect(onDisk(book.id).book.zoom).toBe('150');
  });

  it('a mutation queued while a write fails is re-applied and written next', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const write = adapter.write.bind(adapter);
    let first = true;
    adapter.write = async (path: string, data: string) => {
      if (first && path.endsWith('.json.tmp')) {
        first = false;
        await gate;
        throw new Error('disk full');
      }
      return write(path, data);
    };
    const failing = s.mutate(book.id, (f) => void (f.book.zoom = '200'));
    await new Promise((r) => setTimeout(r, 5));
    const later = s.mutate(book.id, (f) => void (f.book.progress = 0.5));
    release();
    await expect(failing).rejects.toThrow('disk full');
    await later;
    expect(onDisk(book.id).book).toMatchObject({ zoom: null, progress: 0.5 });
  });

  it('a mutation that throws rejects and changes nothing', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
    adapter.calls.length = 0;
    await expect(
      s.mutate(book.id, (f) => {
        f.book.zoom = '300';
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect(s.peek(book.id)?.book.zoom).toBeNull();
    expect(adapter.calls.some((c) => c.startsWith('write'))).toBe(false);
  });

  it('load() recovers a lone tmp file and removes a tmp that has its main file', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
    const main = `${ROOT}/books/${book.id}.json`;
    adapter.files.set(`${main}.tmp`, adapter.files.get(main) as string);
    adapter.files.delete(main);
    adapter.files.set(`${ROOT}/books/other.json`, '{}');
    adapter.files.set(`${ROOT}/books/other.json.tmp`, 'partial');
    await make().load();
    expect(adapter.files.has(main)).toBe(true);
    expect(adapter.files.has(`${main}.tmp`)).toBe(false);
    expect(adapter.files.get(`${ROOT}/books/other.json`)).toBe('{}');
    expect(adapter.files.has(`${ROOT}/books/other.json.tmp`)).toBe(false);
  });

  it('a tmp that parses, next to its main file, is the newer copy: it goes into place and the old main is kept as .prev-', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
    await s.mutate(book.id, (f) => void (f.book.zoom = 'fit-page'));
    await s.flush();
    const main = `${ROOT}/books/${book.id}.json`;
    const older = adapter.files.get(main) as string;
    // Crash between writing the tmp and removing the main: the tmp has the last batch.
    const newer = JSON.stringify({ ...JSON.parse(older), annotations: [{ id: 'h-last' }] }, null, 2);
    adapter.files.set(`${main}.tmp`, newer);
    adapter.calls.length = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = make();
    await t.load();
    warn.mockRestore();
    expect(adapter.files.get(main)).toBe(newer);
    expect(adapter.files.has(`${main}.tmp`)).toBe(false);
    const prev = [...adapter.files.keys()].filter((k) => k.startsWith(`${main}.prev-`));
    expect(prev).toHaveLength(1);
    expect(adapter.files.get(prev[0])).toBe(older);
    expect((await t.file(book.id)).annotations.map((a) => a.id)).toEqual(['h-last']);
    expect(adapter.calls.some((c) => c.startsWith('remove ') && (c.endsWith(main) || c.endsWith(`${main}.tmp`)))).toBe(false);
  });

  it('an index tmp that parses, next to the index, goes into place; the old index is kept as .prev-', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
    const idx = `${ROOT}/index.json`;
    const older = adapter.files.get(idx) as string;
    const newer = JSON.stringify({ version: 1, entries: { 'Moved/a.pdf': { bookId: book.id, fingerprint: '1:x', missing: false } } });
    adapter.files.set(`${idx}.tmp`, newer);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = make();
    await t.load();
    warn.mockRestore();
    expect(t.bookIdForPath('Moved/a.pdf')).toBe(book.id);
    expect(adapter.files.has(`${idx}.tmp`)).toBe(false);
    const prev = [...adapter.files.keys()].filter((k) => k.startsWith(`${idx}.prev-`));
    expect(prev.map((k) => adapter.files.get(k))).toEqual([older]);
  });

  it('the first save of a day backs up the replaced content; later saves that day do not; 7 are kept', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
    for (let d = 1; d <= 8; d++) adapter.files.set(`${ROOT}/backups/${book.id}-2026-10-0${d}.json`, 'old');
    const before = adapter.files.get(`${ROOT}/books/${book.id}.json`);
    await s.mutate(book.id, (f) => void (f.book.zoom = '125'));
    await s.mutate(book.id, (f) => void (f.book.zoom = '150'));
    const today = `${ROOT}/backups/${book.id}-2026-11-10.json`;
    expect(adapter.files.get(today)).toBe(before);
    const mine = (await adapter.list(`${ROOT}/backups`)).files.filter((f) => f.includes(book.id));
    expect(mine).toHaveLength(BACKUPS_KEPT);
    expect(mine[0]).toBe(`${ROOT}/backups/${book.id}-2026-10-03.json`);
    expect(mine).toContain(today);
  });

  it('renamePath moves the index entry and the book path; a title that was the file name follows', async () => {
    const s = make();
    await s.load();
    const a = await s.openPath('Books/a.pdf', '1:x', 'a');
    const b = await s.openPath('Books/b.pdf', '1:y', 'b');
    await s.mutate(b.book.id, (f) => void (f.book.title = 'My Title'));
    await s.renamePath('Books/a.pdf', 'Books/z.pdf');
    await s.renamePath('Books/b.pdf', 'Books/y.pdf');
    expect(s.bookIdForPath('Books/z.pdf')).toBe(a.book.id);
    expect(s.bookIdForPath('Books/a.pdf')).toBeNull();
    expect(onDisk(a.book.id).book).toMatchObject({ path: 'Books/z.pdf', title: 'z' });
    expect(onDisk(b.book.id).book).toMatchObject({ path: 'Books/y.pdf', title: 'My Title' });
  });

  it('a readable file-name title follows a rename readable; a raw one stays raw', async () => {
    const s = make();
    await s.load();
    const a = await s.openPath('Books/Deep_Work.pdf', '1:x', 'Deep Work');
    const b = await s.openPath('Books/Old_Entry.pdf', '1:y', 'Old_Entry');
    await s.renamePath('Books/Deep_Work.pdf', 'Books/Slow_Productivity.pdf');
    await s.renamePath('Books/Old_Entry.pdf', 'Books/Old_Entry_2.pdf');
    expect(onDisk(a.book.id).book.title).toBe('Slow Productivity');
    expect(onDisk(b.book.id).book.title).toBe('Old_Entry_2');
  });

  it('renaming a folder moves every book inside it', async () => {
    const s = make();
    await s.load();
    const a = await s.openPath('Books/a.pdf', '1:x', 'a');
    const c = await s.openPath('Books/sub/c.pdf', '1:z', 'c');
    await s.renamePath('Books', 'Library');
    expect(s.bookIdForPath('Library/a.pdf')).toBe(a.book.id);
    expect(s.bookIdForPath('Library/sub/c.pdf')).toBe(c.book.id);
    expect(onDisk(c.book.id).book.path).toBe('Library/sub/c.pdf');
  });

  it('a deleted file keeps its book (marked missing) and the same content elsewhere reattaches it', async () => {
    const s = make();
    await s.load();
    const a = await s.openPath('Books/a.pdf', '1:x', 'a');
    await s.markMissing('Books/a.pdf');
    expect(s.entry('Books/a.pdf')?.missing).toBe(true);
    const back = await s.openPath('Archive/a-copy.pdf', '1:x', 'a-copy');
    expect(back.book.id).toBe(a.book.id);
    expect(back.book.path).toBe('Archive/a-copy.pdf');
    expect(s.entry('Archive/a-copy.pdf')).toEqual({ bookId: a.book.id, fingerprint: '1:x', missing: false });
    expect(s.entry('Books/a.pdf')).toBeNull();
  });

  describe('a file moved while Margin was not watching (pathExists)', () => {
    let vaultFiles: Set<string>;
    const watching = () => new BookStore(adapter, ROOT, { now, uuid, coalesceMs: 0, pathExists: (p) => vaultFiles.has(p) });
    beforeEach(() => {
      vaultFiles = new Set();
    });

    it('reattaches the book from its stale entry and keeps its highlights; the old entry goes', async () => {
      const s = watching();
      await s.load();
      vaultFiles.add('Books/a.pdf');
      const a = await s.openPath('Books/a.pdf', '1:x', 'a');
      await s.mutate(a.book.id, (f) => void f.annotations.push({ id: 'h1' } as BookFile['annotations'][number]));
      await s.flush();
      // Restart: the file moved in Finder while Obsidian was closed. The index still has it at the old path.
      vaultFiles.delete('Books/a.pdf');
      vaultFiles.add('Archive/a.pdf');
      const t = watching();
      await t.load();
      expect(t.entry('Books/a.pdf')?.missing).toBe(false);
      const back = await t.openPath('Archive/a.pdf', '1:x', 'a');
      expect(back.book.id).toBe(a.book.id);
      expect(back.annotations.map((x) => x.id)).toEqual(['h1']);
      expect(back.book.path).toBe('Archive/a.pdf');
      expect(t.entry('Archive/a.pdf')).toEqual({ bookId: a.book.id, fingerprint: '1:x', missing: false, summary: expect.objectContaining({ annotationCount: 1 }) });
      expect(t.entry('Books/a.pdf')).toBeNull();
      expect(indexOnDisk().entries['Books/a.pdf']).toBeUndefined();
      expect(onDisk(a.book.id).book.path).toBe('Archive/a.pdf');
    });

    it('a copy (the original is still there) gets a new book', async () => {
      const s = watching();
      await s.load();
      vaultFiles.add('Books/a.pdf');
      const a = await s.openPath('Books/a.pdf', '1:x', 'a');
      vaultFiles.add('Archive/a copy.pdf');
      const copy = await s.openPath('Archive/a copy.pdf', '1:x', 'a copy');
      expect(copy.book.id).not.toBe(a.book.id);
      expect(s.bookIdForPath('Books/a.pdf')).toBe(a.book.id);
    });

    it('a missing entry still reattaches, ahead of a stale one with the same content', async () => {
      const s = watching();
      await s.load();
      vaultFiles.add('Books/a.pdf');
      vaultFiles.add('Books/b.pdf');
      const a = await s.openPath('Books/a.pdf', '1:x', 'a');
      const b = await s.openPath('Books/b.pdf', '1:x', 'b');
      await s.markMissing('Books/b.pdf');
      vaultFiles.delete('Books/a.pdf');
      vaultFiles.delete('Books/b.pdf');
      vaultFiles.add('New/c.pdf');
      const back = await s.openPath('New/c.pdf', '1:x', 'c');
      expect(back.book.id).toBe(b.book.id);
      expect(s.bookIdForPath('Books/a.pdf')).toBe(a.book.id);
    });

    it('without pathExists a stale entry is left alone (new book), as before', async () => {
      const s = make();
      await s.load();
      const a = await s.openPath('Books/a.pdf', '1:x', 'a');
      const other = await s.openPath('Archive/a.pdf', '1:x', 'a');
      expect(other.book.id).not.toBe(a.book.id);
    });
  });

  it('different content at a new path is a new book', async () => {
    const s = make();
    await s.load();
    const a = await s.openPath('Books/a.pdf', '1:x', 'a');
    await s.markMissing('Books/a.pdf');
    const other = await s.openPath('Books/b.pdf', '2:other', 'b');
    expect(other.book.id).not.toBe(a.book.id);
  });

  it('listBooks gives every book with its missing flag, most recently opened first', async () => {
    const s = make();
    await s.load();
    const a = await s.openPath('Books/a.pdf', '1:x', 'a');
    const b = await s.openPath('Books/b.pdf', '1:y', 'b');
    await s.mutate(a.book.id, (f) => void (f.book.openedAt = '2099-01-01T00:00:00.000Z'));
    await s.markMissing('Books/b.pdf');
    const list = await s.listBooks();
    expect(list.map((x) => [x.id, x.missing])).toEqual([
      [a.book.id, false],
      [b.book.id, true],
    ]);
  });

  it('onChange reports the book of every mutation; flush() writes pending changes at once', async () => {
    const s = make(10_000);
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
    const seen: string[] = [];
    const off = s.onChange((id) => seen.push(id));
    const p = s.mutate(book.id, (f) => void (f.book.zoom = '75'));
    await s.flush();
    await p;
    expect(onDisk(book.id).book.zoom).toBe('75');
    expect(seen).toEqual([book.id]);
    off();
  });

  it('close() makes every later change reject and leaves memory unchanged; reads and flush still work', async () => {
    const s = make(10_000);
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
    const pending = s.mutate(book.id, (f) => void (f.book.zoom = '75'));
    await s.flush();
    await pending;
    s.close();
    await expect(s.mutate(book.id, (f) => void (f.book.zoom = '90'))).rejects.toThrow('turned off');
    await expect(s.openPath('Books/b.pdf', '2:y', 'b')).rejects.toThrow('turned off');
    await expect(s.renamePath('Books/a.pdf', 'Books/c.pdf')).rejects.toThrow('turned off');
    await expect(s.markMissing('Books/a.pdf')).rejects.toThrow('turned off');
    expect(s.peek(book.id)?.book.zoom).toBe('75');
    expect(s.bookIdForPath('Books/a.pdf')).toBe(book.id);
    expect(s.entry('Books/a.pdf')?.missing).toBe(false);
    await expect(s.flush()).resolves.toBeUndefined();
    expect(onDisk(book.id).book.zoom).toBe('75');
  });

  it('fingerprint is the size plus the SHA-256 of the first 256 KiB', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const abc = new Uint8Array([97, 98, 99]).buffer;
    expect(await fingerprint(abc)).toBe('3:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const big = (tail: number) => {
      const b = new Uint8Array(300 * 1024);
      b[b.length - 1] = tail;
      return b.buffer;
    };
    expect(await fingerprint(big(1))).toBe(await fingerprint(big(2)));
    expect(await fingerprint(big(1))).not.toBe(await fingerprint(new Uint8Array(301 * 1024).buffer));
  });
});

const FP = (c: string) => `10:${c.repeat(64)}`;
const indexOnDisk = () =>
  JSON.parse(adapter.files.get(`${ROOT}/index.json`) as string) as { entries: Record<string, { bookId: string; fingerprint: string; missing: boolean }> };
const bookFiles = () => [...adapter.files.keys()].filter((k) => k.startsWith(`${ROOT}/books/`) && k.endsWith('.json')).sort();
const filesLike = (prefix: string) => [...adapter.files.keys()].filter((k) => k.startsWith(prefix));
/** A book file written straight to disk, as an earlier session left it. */
const putBook = (id: string, path: string, contentHash: string) => {
  const file: BookFile = {
    version: 1,
    book: {
      id, contentHash, path, format: 'pdf', title: id, author: null, lastLocation: null,
      addedAt: '2026-01-01T00:00:00.000Z', openedAt: null, zoom: null, progress: null,
    },
    annotations: [],
    thoughts: [],
  };
  adapter.files.set(`${ROOT}/books/${id}.json`, JSON.stringify(file, null, 2));
};
const putIndex = (entries: Record<string, { bookId: string; fingerprint: string; missing: boolean }>) =>
  adapter.files.set(`${ROOT}/index.json`, JSON.stringify({ version: 1, entries }, null, 2));

describe('BookStore: no book becomes unreachable', () => {
  it('two concurrent opens of the same new path give one book and one book file', async () => {
    const s = make();
    await s.load();
    const [a, b] = await Promise.all([s.openPath('Books/a.pdf', '1:x', 'a'), s.openPath('Books/a.pdf', '1:x', 'a')]);
    expect(b.book.id).toBe(a.book.id);
    expect(bookFiles()).toEqual([`${ROOT}/books/${a.book.id}.json`]);
    expect(indexOnDisk().entries).toEqual({ 'Books/a.pdf': { bookId: a.book.id, fingerprint: '1:x', missing: false } });
  });

  it('openPath interleaved with renamePath leaves exactly one entry for the book', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
    const t = make();
    await t.load(); // the book is not loaded yet: openPath awaits reading it
    const opening = t.openPath('Books/a.pdf', '2:changed', 'a');
    const renaming = t.renamePath('Books/a.pdf', 'Books/z.pdf');
    await Promise.all([opening, renaming]);
    await t.flush();
    expect(Object.keys(indexOnDisk().entries)).toEqual(['Books/z.pdf']);
    expect(t.bookIdForPath('Books/z.pdf')).toBe(book.id);
    expect(t.bookIdForPath('Books/a.pdf')).toBeNull();
    expect(bookFiles()).toEqual([`${ROOT}/books/${book.id}.json`]);
  });

  it("a second store saving on the same day leaves that day's backup unchanged", async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
    await s.mutate(book.id, (f) => void (f.book.zoom = '125'));
    const today = `${ROOT}/backups/${book.id}-2026-11-10.json`;
    const first = adapter.files.get(today);
    expect(first).toBeDefined();
    const t = make();
    await t.load();
    await t.mutate(book.id, (f) => void (f.book.zoom = '150'));
    expect(onDisk(book.id).book.zoom).toBe('150');
    expect(adapter.files.get(today)).toBe(first);
  });

  it('renamePath(p, p) changes nothing', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
    await expect(s.renamePath('Books/a.pdf', 'Books/a.pdf')).resolves.toBeUndefined();
    expect(s.entry('Books/a.pdf')).toEqual({ bookId: book.id, fingerprint: '1:x', missing: false });
    expect(onDisk(book.id).book.path).toBe('Books/a.pdf');
  });

  it('renaming onto the path of a missing book keeps that book, reachable by its fingerprint', async () => {
    const s = make();
    await s.load();
    const a = await s.openPath('Books/a.pdf', '1:x', 'a');
    await s.markMissing('Books/a.pdf');
    const b = await s.openPath('Books/b.pdf', '1:y', 'b');
    await s.renamePath('Books/b.pdf', 'Books/a.pdf');
    expect(s.entry('Books/a.pdf')).toEqual({ bookId: b.book.id, fingerprint: '1:y', missing: false });
    // its stored path is the one just taken, so it waits under an orphan key
    expect(s.entry(`margin-missing:${a.book.id}`)).toEqual({ bookId: a.book.id, fingerprint: '1:x', missing: true });
    expect(indexOnDisk().entries[`margin-missing:${a.book.id}`]).toEqual({ bookId: a.book.id, fingerprint: '1:x', missing: true });
    expect(onDisk(a.book.id).book.path).toBe('Books/a.pdf');
    const t = make();
    await t.load();
    const back = await t.openPath('Archive/a.pdf', '1:x', 'a');
    expect(back.book.id).toBe(a.book.id);
    expect(t.entry(`margin-missing:${a.book.id}`)).toBeNull();
  });

  it('a displaced missing book is keyed by its unique orphan key even when its stored path is free', async () => {
    putBook('id-a', 'Old/a.pdf', '1:x');
    putBook('id-b', 'Books/b.pdf', '1:y');
    putIndex({
      'Books/a.pdf': { bookId: 'id-a', fingerprint: '1:x', missing: true },
      'Books/b.pdf': { bookId: 'id-b', fingerprint: '1:y', missing: false },
    });
    const s = make();
    await s.load();
    await s.renamePath('Books/b.pdf', 'Books/a.pdf');
    expect(s.entry('Books/a.pdf')?.bookId).toBe('id-b');
    expect(s.entry('Old/a.pdf')).toBeNull();
    expect(s.entry('margin-missing:id-a')).toEqual({ bookId: 'id-a', fingerprint: '1:x', missing: true });
    expect(Object.keys(indexOnDisk().entries).sort()).toEqual(['Books/a.pdf', 'margin-missing:id-a']);
    expect((await s.listBooks()).find((b) => b.id === 'id-a')?.missing).toBe(true);
  });

  it('load() puts every book file the index does not reference back as a missing entry', async () => {
    putBook('id-a', 'Books/a.pdf', FP('a'));
    putBook('id-b', 'Books/b.pdf', FP('b'));
    putBook('id-c', 'Books/c.pdf', '1:x'); // not the index fingerprint format
    putBook('id-d', 'Books/b.pdf', FP('d')); // its stored path is taken
    adapter.files.set(`${ROOT}/books/other.json`, '{}');
    putIndex({ 'Books/b.pdf': { bookId: 'id-b', fingerprint: FP('b'), missing: false } });
    const before = new Map(bookFiles().map((k) => [k, adapter.files.get(k)]));
    const s = make();
    await s.load();
    const expected = {
      'Books/b.pdf': { bookId: 'id-b', fingerprint: FP('b'), missing: false },
      'margin-missing:id-a': { bookId: 'id-a', fingerprint: FP('a'), missing: true },
      'margin-missing:id-c': { bookId: 'id-c', fingerprint: '', missing: true },
      'margin-missing:id-d': { bookId: 'id-d', fingerprint: FP('d'), missing: true },
    };
    expect(indexOnDisk().entries).toEqual(expected);
    expect(new Map(bookFiles().map((k) => [k, adapter.files.get(k)]))).toEqual(before);
    expect((await s.openPath('New/d.pdf', FP('d'), 'd')).book.id).toBe('id-d');
    expect((await s.openPath('Books/c.pdf', '9:new', 'c')).book.id).not.toBe('id-c');
  });

  it('an unrelated file opened at a swept book\'s old path gets a new book, and the swept book stays missing', async () => {
    putBook('id-a', 'Books/a.pdf', FP('a'));
    putIndex({});
    const s = make();
    await s.load();
    const fresh = await s.openPath('Books/a.pdf', FP('zzz'), 'a');
    expect(fresh.book.id).not.toBe('id-a');
    expect(s.entry('Books/a.pdf')?.bookId).toBe(fresh.book.id);
    expect(s.entry('margin-missing:id-a')).toEqual({ bookId: 'id-a', fingerprint: FP('a'), missing: true });
    expect((await s.listBooks()).find((b) => b.id === 'id-a')?.missing).toBe(true);
  });

  it('flush() also waits for index operations still in flight', async () => {
    const s = make();
    await s.load();
    const a = await s.openPath('Books/a.pdf', '1:x', 'a');
    const op = s.renamePath('Books/a.pdf', 'Books/z.pdf');
    await s.flush();
    expect(indexOnDisk().entries['Books/z.pdf']?.bookId).toBe(a.book.id);
    expect(onDisk(a.book.id).book.path).toBe('Books/z.pdf');
    await op;
  });

  it('a corrupt index is kept aside and rebuilt from the book files; no book file changes', async () => {
    const s = make();
    await s.load();
    const a = await s.openPath('Books/a.pdf', FP('a'), 'a');
    const b = await s.openPath('Books/sub/b.pdf', FP('b'), 'b');
    adapter.files.set(`${ROOT}/index.json`, 'garbage{');
    const before = new Map(bookFiles().map((k) => [k, adapter.files.get(k)]));
    const t = make();
    await t.load();
    const kept = filesLike(`${ROOT}/index.json.corrupt-`);
    expect(kept).toHaveLength(1);
    expect(adapter.files.get(kept[0])).toBe('garbage{');
    expect(t.entry(`margin-missing:${a.book.id}`)).toEqual({ bookId: a.book.id, fingerprint: FP('a'), missing: true });
    expect(t.entry(`margin-missing:${b.book.id}`)).toEqual({ bookId: b.book.id, fingerprint: FP('b'), missing: true });
    expect(new Map(bookFiles().map((k) => [k, adapter.files.get(k)]))).toEqual(before);
    expect((await t.openPath('Books/a.pdf', FP('a'), 'a')).book.id).toBe(a.book.id);
    expect(t.entry('Books/a.pdf')?.missing).toBe(false);
  });

  it('an index of the wrong shape counts as corrupt; a lost index is rebuilt too', async () => {
    putBook('id-a', 'Books/a.pdf', FP('a'));
    adapter.files.set(`${ROOT}/index.json`, '{"version":1,"entries":[]}');
    const s = make();
    await s.load();
    expect(filesLike(`${ROOT}/index.json.corrupt-`)).toHaveLength(1);
    expect(s.bookIdForPath('margin-missing:id-a')).toBe('id-a');
    adapter.files.delete(`${ROOT}/index.json`);
    const t = make();
    await t.load();
    expect(indexOnDisk().entries).toEqual({ 'margin-missing:id-a': { bookId: 'id-a', fingerprint: FP('a'), missing: true } });
  });

  it('a lone tmp that does not parse is kept aside and the book falls back to its newest readable backup', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
    const original = adapter.files.get(`${ROOT}/books/${book.id}.json`) as string;
    await s.mutate(book.id, (f) => void (f.book.zoom = '125')); // backs up `original` for 2026-11-10
    const older = original.replace('"zoom": null', '"zoom": "75"');
    adapter.files.set(`${ROOT}/backups/${book.id}-2026-11-01.json`, older);
    adapter.files.set(`${ROOT}/backups/${book.id}-2026-11-12.json`, 'not json'); // newest, unreadable: skipped
    const main = `${ROOT}/books/${book.id}.json`;
    adapter.files.delete(main);
    adapter.files.set(`${main}.tmp`, '{"version":1,"bo');
    adapter.files.delete(`${ROOT}/index.json`);
    adapter.files.set(`${ROOT}/index.json.tmp`, '{"entr');
    const t = make();
    await t.load();
    expect(adapter.files.get(main)).toBe(original);
    expect(adapter.files.has(`${main}.tmp`)).toBe(false);
    const kept = filesLike(`${main}.corrupt-`);
    expect(kept).toHaveLength(1);
    expect(adapter.files.get(kept[0])).toBe('{"version":1,"bo');
    expect(adapter.files.get(filesLike(`${ROOT}/index.json.corrupt-`)[0])).toBe('{"entr');
    expect(t.bookIdForPath(`margin-missing:${book.id}`)).toBe(book.id);
  });

  it('a lone tmp that does not parse, with no backup, is kept aside and nothing is invented', async () => {
    putIndex({ 'Books/a.pdf': { bookId: 'id-a', fingerprint: '1:x', missing: false } });
    adapter.files.set(`${ROOT}/books/id-a.json.tmp`, 'nope');
    const s = make();
    await s.load();
    expect(adapter.files.has(`${ROOT}/books/id-a.json`)).toBe(false);
    expect(adapter.files.get(filesLike(`${ROOT}/books/id-a.json.corrupt-`)[0])).toBe('nope');
  });

  it('flush() writes the mutations of a book that is still loading', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
    const t = make(10_000);
    await t.load();
    const p = t.mutate(book.id, (f) => void (f.book.zoom = '75'));
    await t.flush();
    expect(onDisk(book.id).book.zoom).toBe('75');
    await p;
  });

  it('a book that cannot be serialised rejects its batch and the next write still lands', { timeout: 2000 }, async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
    const bad = s.mutate(book.id, (f) => void ((f.book as unknown as { progress: unknown }).progress = 1n));
    await expect(bad).rejects.toThrow(TypeError);
    expect(s.peek(book.id)?.book.progress).toBeNull();
    await s.mutate(book.id, (f) => void (f.book.zoom = '150'));
    expect(onDisk(book.id).book).toMatchObject({ zoom: '150', progress: null });
  });

  it('names the backup by the local date, also near midnight', async () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const late = new Date('2026-11-11T02:30:00.000Z'); // 21:30 on 10 November in New York
      expect(late.getDate()).toBe(10);
      const s = new BookStore(adapter, ROOT, { now: () => late, uuid, coalesceMs: 0 });
      await s.load();
      const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
      await s.mutate(book.id, (f) => void (f.book.zoom = '125'));
      expect(filesLike(`${ROOT}/backups/`)).toEqual([`${ROOT}/backups/${book.id}-2026-11-10.json`]);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it('coalesces for 50 ms by default', async () => {
    expect(WRITE_COALESCE_MS).toBe(50);
    const s = new BookStore(adapter, ROOT, { now, uuid });
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'a');
    const tmpWrites = () => adapter.calls.filter((c) => c === `write ${ROOT}/books/${book.id}.json.tmp`).length;
    adapter.calls.length = 0;
    vi.useFakeTimers();
    try {
      const p = s.mutate(book.id, (f) => void (f.book.zoom = '125'));
      await vi.advanceTimersByTimeAsync(49);
      expect(tmpWrites()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(tmpWrites()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BookStore: load() reports what it recovered', () => {
  const recorded = (s: BookStore) => {
    const events: RecoveryEvent[] = [];
    s.onRecovery((e) => events.push(e));
    return events;
  };

  it('a clean load reports nothing', async () => {
    putBook('id-a', 'Books/a.pdf', FP('a'));
    putIndex({ 'Books/a.pdf': { bookId: 'id-a', fingerprint: FP('a'), missing: false } });
    const s = make();
    const events = recorded(s);
    await s.load();
    expect(events).toEqual([]);
  });

  it('a damaged book restored from its backup, named by its title', async () => {
    const s = make();
    await s.load();
    const { book } = await s.openPath('Books/a.pdf', '1:x', 'Walden');
    await s.mutate(book.id, (f) => void (f.book.zoom = '125')); // backs up the first version
    const main = `${ROOT}/books/${book.id}.json`;
    adapter.files.delete(main);
    adapter.files.set(`${main}.tmp`, '{"version":1,"bo');
    const t = make();
    const events = recorded(t);
    await t.load();
    expect(events).toEqual([
      {
        kind: 'backup-restored',
        bookId: book.id,
        name: 'Walden',
        keptAs: filesLike(`${main}.corrupt-`)[0],
        backup: `${ROOT}/backups/${book.id}-2026-11-10.json`,
      },
    ]);
  });

  it('a damaged book with no backup, named by its vault path', async () => {
    putIndex({ 'Books/a.pdf': { bookId: 'id-a', fingerprint: '1:x', missing: false } });
    adapter.files.set(`${ROOT}/books/id-a.json.tmp`, 'nope');
    const s = make();
    const events = recorded(s);
    await s.load();
    expect(events).toEqual([
      { kind: 'book-kept-aside', bookId: 'id-a', name: 'Books/a.pdf', keptAs: filesLike(`${ROOT}/books/id-a.json.corrupt-`)[0] },
    ]);
  });

  it('a corrupt index kept aside and rebuilt, then the books it swept back, by title', async () => {
    putBook('id-a', 'Books/a.pdf', FP('a'));
    putBook('id-b', 'Books/b.pdf', FP('b'));
    adapter.files.set(`${ROOT}/index.json`, 'garbage{');
    const s = make();
    const events = recorded(s);
    await s.load();
    // One event: the swept books are folded into the rebuilt index's report.
    expect(events).toEqual([
      {
        kind: 'index-rebuilt',
        keptAs: filesLike(`${ROOT}/index.json.corrupt-`)[0],
        books: [
          { bookId: 'id-a', name: 'id-a' },
          { bookId: 'id-b', name: 'id-b' },
        ],
      },
    ]);
  });

  it('a lone unreadable index tmp counts as a rebuilt index', async () => {
    adapter.files.set(`${ROOT}/index.json.tmp`, '{"entr');
    const s = make();
    const events = recorded(s);
    await s.load();
    expect(events).toEqual([{ kind: 'index-rebuilt', keptAs: filesLike(`${ROOT}/index.json.corrupt-`)[0], books: [] }]);
  });

  it('a listener that throws does not stop the load or the other listeners; unsubscribing stops reports', async () => {
    adapter.files.set(`${ROOT}/index.json`, 'garbage{');
    const s = make();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    s.onRecovery(() => {
      throw new Error('boom');
    });
    const events = recorded(s);
    const gone: RecoveryEvent[] = [];
    s.onRecovery((e) => gone.push(e))();
    await expect(s.load()).resolves.toBeUndefined();
    expect(events.map((e) => e.kind)).toEqual(['index-rebuilt']);
    expect(gone).toEqual([]);
    err.mockRestore();
  });
});

describe('BookStore: when each book was opened, from the index alone', () => {
  it('an index written before openedAt existed loads; markOpened records the time and it survives a new store', async () => {
    putBook('id-a', 'Books/a.pdf', '1:x');
    putBook('id-b', 'Books/b.pdf', '1:y');
    putIndex({ 'Books/a.pdf': { bookId: 'id-a', fingerprint: '1:x', missing: false }, 'Books/b.pdf': { bookId: 'id-b', fingerprint: '1:y', missing: false } });
    const s = make();
    await s.load();
    expect(s.bookIdForPath('Books/a.pdf')).toBe('id-a');
    expect(s.openedAtByPath()).toEqual(new Map());
    await s.markOpened('Books/b.pdf');
    await s.markOpened('Books/nowhere.pdf'); // no entry: nothing happens
    const at = s.entry('Books/b.pdf')!.openedAt!;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(indexOnDisk().entries['Books/b.pdf']).toEqual({ bookId: 'id-b', fingerprint: '1:y', missing: false, openedAt: at });
    expect(indexOnDisk().entries['Books/a.pdf']).toEqual({ bookId: 'id-a', fingerprint: '1:x', missing: false });
    // Read straight from the index: no book file is loaded.
    const reads = adapter.calls.length;
    expect(s.openedAtByPath()).toEqual(new Map([['Books/b.pdf', at]]));
    expect(adapter.calls.length).toBe(reads);
    expect(s.peek('id-a')).toBeNull();
    const t = make();
    await t.load();
    expect(t.openedAtByPath()).toEqual(new Map([['Books/b.pdf', at]]));
  });

  it('the time follows a rename; a closed store refuses to record one', async () => {
    const s = make();
    await s.load();
    await s.openPath('Books/a.pdf', '1:x', 'a');
    await s.markOpened('Books/a.pdf');
    const at = s.entry('Books/a.pdf')!.openedAt!;
    await s.renamePath('Books', 'Library');
    expect(s.openedAtByPath()).toEqual(new Map([['Library/a.pdf', at]]));
    s.close();
    await expect(s.markOpened('Library/a.pdf')).rejects.toThrow('turned off');
  });
});

describe('BookStore: EPUB books (E7)', () => {
  it('a new .epub book has format epub and its OPF title and author', async () => {
    const s = make();
    await s.load();
    const f = await s.openPath('Books/Moby.EPUB', '10:m', 'Moby', () => ({ title: ' Moby-Dick ', author: 'Herman Melville' }));
    expect(f.book.format).toBe('epub');
    expect(f.book.title).toBe('Moby-Dick');
    expect(f.book.author).toBe('Herman Melville');
    expect(onDisk(f.book.id).book).toMatchObject({ format: 'epub', title: 'Moby-Dick', author: 'Herman Melville' });
  });

  it('without OPF metadata (or a blank title) the file-name title stays; a PDF stays a PDF', async () => {
    const s = make();
    await s.load();
    expect((await s.openPath('Books/a.epub', '1:a', 'a', () => ({ title: '  ', author: null }))).book).toMatchObject({ format: 'epub', title: 'a', author: null });
    expect((await s.openPath('Books/b.epub', '1:b', 'b')).book).toMatchObject({ format: 'epub', title: 'b', author: null });
    expect((await s.openPath('Books/c.pdf', '1:c', 'c')).book.format).toBe('pdf');
  });

  it('re-opening never overwrites the title (or author) of an existing book, nor reads its metadata', async () => {
    const s = make();
    await s.load();
    const first = await s.openPath('Books/Moby.epub', '10:m', 'Moby', () => ({ title: 'Moby-Dick', author: 'Herman Melville' }));
    const meta = vi.fn(() => ({ title: 'Other Title', author: 'Someone' }));
    const again = await s.openPath('Books/Moby.epub', '10:m', 'Moby', meta);
    expect(meta).not.toHaveBeenCalled();
    expect(again.book.id).toBe(first.book.id);
    expect(again.book.title).toBe('Moby-Dick');
    expect(again.book.author).toBe('Herman Melville');
  });
});
