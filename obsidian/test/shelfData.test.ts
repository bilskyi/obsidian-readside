import { describe, expect, it, vi } from 'vitest';
import type { ShelfEntry } from '../src/store/bookStore';
import type { BookFile } from '../src/store/types';
import {
  LOAD_CONCURRENCY,
  MAX_HITS_PER_BOOK,
  MAX_RECENT_BOOKS,
  MAX_RESURFACE_BOOKS,
  ago,
  countsLabel,
  coverColor,
  loadBooks,
  plainText,
  recentThoughts,
  resurface,
  searchBooks,
  searchOrder,
  shelfBooks,
  shelfNotes,
  ALL_NOTES,
  snippetAround,
  summaryLine,
  whereLabel,
  type LoadedBooks,
  type ShelfBook,
} from '../src/shelf/shelfData';
import { cardLabel, placeOf } from '../src/shelf/shelfData';
import { epubLocation, pdfLocation } from '../../src/lib/location';

const pdf = (page: number) => JSON.stringify({ kind: 'pdf', value: { page, start: 0, end: 1 }, label: `p. ${page}` });


function book(id: string, over: Partial<ShelfBook> = {}): ShelfBook {
  return {
    path: `Books/${id}.pdf`, bookId: id, missing: false, title: id, progress: 0, page: null, pageCount: null,
    annotationCount: 1, thoughtCount: 1, thoughtsByMonth: {}, sortKey: '', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
  };
}

function file(id: string, parts: { annotations?: Partial<BookFile['annotations'][number]>[]; thoughts?: Partial<BookFile['thoughts'][number]>[] } = {}): BookFile {
  return {
    version: 1,
    book: { id, contentHash: '', path: `Books/${id}.pdf`, format: 'pdf', title: id, author: null, lastLocation: null, addedAt: '2026-01-01T00:00:00.000Z', openedAt: null, zoom: null, progress: null },
    annotations: (parts.annotations ?? []).map((a, i) => ({
      id: `${id}-h${i}`, bookId: id, location: pdf(i + 1), quote: 'quote', color: 'yellow', note: null, unanchored: false,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...a,
    })) as BookFile['annotations'],
    thoughts: (parts.thoughts ?? []).map((t, i) => ({
      id: `${id}-t${i}`, bookId: id, body: 'body', anchorId: null, location: null, position: i + 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', labelSection: null, labelSnippet: null, labelCustom: null, ...t,
    })) as BookFile['thoughts'],
  };
}

const sourceOf = (files: BookFile[]) => {
  const byId = new Map(files.map((f) => [f.book.id, f]));
  return {
    file: vi.fn(async (id: string) => {
      const f = byId.get(id);
      if (!f) throw new Error(`not found: book ${id}`);
      return f;
    }),
  };
};

describe('cards', () => {
  it('a cover colour is the same for the same title and differs between titles', () => {
    expect(coverColor('Deep Work')).toBe(coverColor('Deep Work'));
    expect(coverColor('Deep Work')).not.toBe(coverColor('Thinking, Fast and Slow'));
    expect(coverColor('Deep Work')).toMatch(/^hsl\(\d{1,3} 28% 32%\)$/);
  });

  it('where: finished, page of pages, page alone, not started', () => {
    expect(whereLabel({ progress: 1, page: 300, pageCount: 310 })).toBe('Finished');
    expect(whereLabel({ progress: 0.99, page: 42, pageCount: 310 })).toBe('p. 42 of 310');
    expect(whereLabel({ progress: 0.2, page: 42, pageCount: null })).toBe('p. 42');
    expect(whereLabel({ progress: 0, page: null, pageCount: 310 })).toBe('Not started');
  });

  it('counts are plain words, singular when one, empty when not known', () => {
    expect(countsLabel({ annotationCount: 1, thoughtCount: 7 })).toBe('1 highlight · 7 thoughts');
    expect(countsLabel({ annotationCount: null, thoughtCount: null })).toBe('');
  });

  it('shelfBooks: titles from the summary or the file name, last opened first', () => {
    const entries: ShelfEntry[] = [
      { path: 'Books/old_one.pdf', bookId: 'a', missing: false, openedAt: '2026-01-01T00:00:00.000Z', summary: null },
      {
        path: 'Books/b.pdf', bookId: 'b', missing: true, openedAt: '2026-05-01T00:00:00.000Z',
        summary: { title: 'Deep Work', progress: 2, page: 4, pageCount: 9, annotationCount: 3, thoughtCount: 1, thoughtsByMonth: {}, openedAt: null, updatedAt: 'x' },
      },
    ];
    const [first, second] = shelfBooks(entries);
    expect(first).toMatchObject({ title: 'Deep Work', missing: true, progress: 1, page: 4, pageCount: 9, annotationCount: 3 });
    expect(second).toMatchObject({ title: 'old one', annotationCount: null, thoughtCount: null });
  });

  it('the summary line counts books, every highlight, and this month’s thoughts', () => {
    const books = [
      book('a', { annotationCount: 60, thoughtsByMonth: { '2026-11': 20, '2026-10': 5 } }),
      book('b', { annotationCount: 1, thoughtsByMonth: { '2026-11': 3 } }),
    ];
    expect(summaryLine(books, new Date(2026, 10, 11))).toBe('2 books in this vault · 61 highlights · 23 thoughts this month');
    expect(summaryLine([book('a', { annotationCount: 1, thoughtsByMonth: { '2026-11': 1 } })], new Date(2026, 10, 1))).toBe(
      '1 book in this vault · 1 highlight · 1 thought this month',
    );
  });

  it('ago reads in days, weeks, months, years', () => {
    const now = new Date('2026-11-11T12:00:00.000Z');
    expect(ago('2026-11-11T08:00:00.000Z', now)).toBe('today');
    expect(ago('2026-11-10T08:00:00.000Z', now)).toBe('yesterday');
    expect(ago('2026-10-28T12:00:00.000Z', now)).toBe('2 weeks ago');
    expect(ago('2026-08-11T12:00:00.000Z', now)).toBe('3 months ago');
    expect(ago('2024-11-01T12:00:00.000Z', now)).toBe('2 years ago');
  });
});

describe('loading book files', () => {
  it('reads at most LOAD_CONCURRENCY at a time, skips what is loaded, leaves out unreadable books', async () => {
    let inFlight = 0;
    let most = 0;
    const source = {
      file: vi.fn(async (id: string) => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        if (id === 'bad') throw new Error('unreadable');
        return file(id);
      }),
    };
    const into: LoadedBooks = new Map([['done', file('done')]]);
    await loadBooks(source, ['a', 'b', 'c', 'd', 'e', 'bad', 'done'], into);
    expect(most).toBe(LOAD_CONCURRENCY);
    expect(source.file).not.toHaveBeenCalledWith('done');
    expect([...into.keys()].sort()).toEqual(['a', 'b', 'c', 'd', 'done', 'e']);
  });

  it('stops when told to', async () => {
    const source = sourceOf(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => file(id)));
    let stop = false;
    source.file.mockImplementation(async (id: string) => {
      stop = true;
      return file(id);
    });
    await loadBooks(source, ['a', 'b', 'c', 'd', 'e', 'f'], new Map(), () => stop);
    expect(source.file.mock.calls.length).toBeLessThanOrEqual(LOAD_CONCURRENCY);
  });
});

describe('search', () => {
  it('finds highlights (text or note) and thoughts, ignoring case, grouped by book in shelf order, with snippets and places', () => {
    const books = [book('x'), book('y'), book('gone', { missing: true })];
    const loaded: LoadedBooks = new Map([
      ['x', file('x', { annotations: [{ quote: 'Friction decides more than motivation' }, { quote: 'nothing', note: 'design the FRICTION out' }] })],
      ['y', file('y', { annotations: [{ id: 'yh', quote: 'unrelated', location: pdf(9) }], thoughts: [{ body: '**Friction** again', anchorId: 'yh' }] })],
      ['gone', file('gone', { annotations: [{ quote: 'friction' }] })],
    ]);
    const groups = searchBooks('  friction ', books, loaded);
    expect(groups.map((g) => g.book.bookId)).toEqual(['x', 'y']);
    expect(groups[0].hits.map((h) => [h.kind, h.page, h.snippet.match])).toEqual([
      ['highlight', 1, 'Friction'],
      ['highlight', 2, 'FRICTION'],
    ]);
    expect(groups[1].hits).toEqual([
      { kind: 'thought', id: 'y-t0', snippet: { before: '', match: 'Friction', after: ' again' }, location: JSON.parse(pdf(9)), page: 9 },
    ]);
    expect(searchBooks('   ', books, loaded)).toEqual([]);
  });

  it('shows a few matches per book and counts the rest', () => {
    const loaded: LoadedBooks = new Map([['x', file('x', { annotations: Array.from({ length: MAX_HITS_PER_BOOK + 3 }, () => ({ quote: 'match' })) })]]);
    const [g] = searchBooks('match', [book('x')], loaded);
    expect(g.hits).toHaveLength(MAX_HITS_PER_BOOK);
    expect(g.more).toBe(3);
  });

  it('a snippet is cut at words around the match, with … where cut', () => {
    const text = `${'word '.repeat(30)}needle${' tail'.repeat(30)}`;
    const s = snippetAround(text, text.indexOf('needle'), 6);
    expect(s.match).toBe('needle');
    expect(s.before.startsWith('…word')).toBe(true);
    expect(s.after.endsWith('tail…')).toBe(true);
  });

  it('reads only books that can match and can be opened', () => {
    const order = searchOrder([
      book('old', { updatedAt: '2026-01-01' }),
      book('new', { updatedAt: '2026-06-01' }),
      book('empty', { annotationCount: 0, thoughtCount: 0 }),
      book('gone', { missing: true }),
      book('unknown', { annotationCount: null, thoughtCount: null, updatedAt: '' }),
    ]);
    expect(order).toEqual(['new', 'old', 'unknown']);
  });

  it('thought text is plain: links, emphasis and list marks dropped', () => {
    expect(plainText('# Title\n- see [[Note|that note]] and [x](http://a) **bold**')).toBe('Title see that note and x bold');
  });
});

describe('recent thoughts', () => {
  it('the newest five by updatedAt, coloured by their highlight; books that cannot hold newer ones are not read', async () => {
    const t = (d: number) => `2026-03-${String(d).padStart(2, '0')}T00:00:00.000Z`;
    const files = [
      file('a', { annotations: [{ id: 'ah', color: 'green' }], thoughts: [1, 2, 3].map((d) => ({ updatedAt: t(d + 20), anchorId: 'ah' })) }),
      file('b', { thoughts: [1, 2, 3].map((d) => ({ updatedAt: t(d + 10), location: pdf(5) })) }),
      file('c', { thoughts: [{ updatedAt: t(1) }] }),
      file('d', { thoughts: [{ updatedAt: t(2) }] }),
      file('e', { thoughts: [{ updatedAt: t(3) }] }),
    ];
    const books = [
      book('a', { updatedAt: t(23) }),
      book('b', { updatedAt: t(13) }),
      book('none', { thoughtCount: 0, updatedAt: t(30) }),
      book('gone', { missing: true, updatedAt: t(31) }),
      book('c', { updatedAt: t(1) }),
      book('d', { updatedAt: t(2) }),
      book('e', { updatedAt: t(3) }),
    ];
    const source = sourceOf(files);
    const recent = await recentThoughts(books, source, new Map());
    expect(recent.map((r) => r.updatedAt)).toEqual([t(23), t(22), t(21), t(13), t(12)]);
    expect(recent[0]).toMatchObject({ color: 'green', page: 1, book: { bookId: 'a' } });
    expect(recent[3]).toMatchObject({ color: null, page: 5 });
    // a, b and e (one chunk of LOAD_CONCURRENCY) were read; c and d are older than the fifth found.
    expect(source.file.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b', 'e']);
  });
});

describe('recent thoughts: bounded', () => {
  it('reads at most MAX_RECENT_BOOKS book files, missing ones never', async () => {
    const ids = Array.from({ length: MAX_RECENT_BOOKS + 10 }, (_, i) => `b${i}`);
    // Books whose summaries are not known yet: nothing bounds them but the cap.
    const source = sourceOf(ids.map((id) => file(id)));
    const books = [...ids.map((id) => book(id, { thoughtCount: null, annotationCount: null })), book('gone', { missing: true })];
    expect(await recentThoughts(books, source, new Map())).toEqual([]);
    expect(source.file.mock.calls.length).toBe(MAX_RECENT_BOOKS);
    expect(source.file).not.toHaveBeenCalledWith('gone');
  });
});

describe('from your shelf, a while ago', () => {
  const now = new Date('2026-11-11T12:00:00.000Z');
  const oldDay = '2026-10-01T00:00:00.000Z';
  const recentDay = '2026-11-05T00:00:00.000Z';

  it('a highlight at least two weeks old; never a newer one', async () => {
    const source = sourceOf([file('a', { annotations: [{ id: 'new', createdAt: recentDay }, { id: 'old', createdAt: oldDay, quote: ' As  you become skilled ' }] })]);
    const r = await resurface([book('a')], source, new Map(), now, () => 0.99);
    expect(r).toMatchObject({ id: 'old', quote: 'As you become skilled', page: 2, book: { bookId: 'a' } });
    const none = await resurface([book('a')], sourceOf([file('a', { annotations: [{ createdAt: recentDay }] })]), new Map(), now, () => 0);
    expect(none).toBeNull();
  });

  it('“Show another” skips the one on screen while there is another; with one only, it stays', async () => {
    const source = sourceOf([file('a', { annotations: [{ id: 'one', createdAt: oldDay }, { id: 'two', createdAt: oldDay }] })]);
    for (const x of [0, 0.5, 0.99]) {
      expect((await resurface([book('a')], source, new Map(), now, () => x, 'one'))?.id).toBe('two');
    }
    const single = sourceOf([file('a', { annotations: [{ id: 'one', createdAt: oldDay }] })]);
    expect((await resurface([book('a')], single, new Map(), now, () => 0, 'one'))?.id).toBe('one');
  });

  it('reads a bounded number of books, missing ones never', async () => {
    const ids = Array.from({ length: MAX_RESURFACE_BOOKS + 10 }, (_, i) => `b${i}`);
    const source = sourceOf(ids.map((id) => file(id, { annotations: [{ createdAt: recentDay }] })));
    const r = await resurface([...ids.map((id) => book(id)), book('gone', { missing: true })], source, new Map(), now, Math.random);
    expect(r).toBeNull();
    expect(source.file.mock.calls.length).toBe(MAX_RESURFACE_BOOKS);
    expect(source.file).not.toHaveBeenCalledWith('gone');
  });
});

describe('recent thoughts: an epub', () => {
  it('a thought in an epub reports its section as its page', async () => {
    const epub = JSON.stringify({ kind: 'epub', value: { section: 6, start: 2, end: 2, y: 0.3 }, label: '§ 6' });
    const recent = await recentThoughts([book('m')], sourceOf([file('m', { thoughts: [{ updatedAt: '2026-03-01T00:00:00.000Z', location: epub }] })]), new Map());
    expect(recent).toHaveLength(1);
    expect(recent[0].page).toBe(6);
  });
});

describe('shelf: EPUB books (E7)', () => {
  it('shelfBooks reads the format from the file extension', () => {
    const [a, b] = shelfBooks([
      { path: 'Books/m.EPUB', bookId: 'm', missing: false, openedAt: '2026-02-01T00:00:00.000Z', summary: null },
      { path: 'Books/w.pdf', bookId: 'w', missing: false, openedAt: '2026-01-01T00:00:00.000Z', summary: null },
    ]);
    expect(a.format).toBe('epub');
    expect(b.format).toBe('pdf');
  });

  it('whereLabel: an EPUB says how far in it is, else its section; never pages', () => {
    expect(whereLabel({ format: 'epub', progress: 0.42, page: 7, pageCount: 40 })).toBe('42%');
    expect(whereLabel({ format: 'epub', progress: 0.001, page: 1, pageCount: 40 })).toBe('1%');
    expect(whereLabel({ format: 'epub', progress: 0, page: 3, pageCount: 40 })).toBe('§ 3');
    expect(whereLabel({ format: 'epub', progress: 0, page: 1, pageCount: 40 })).toBe('Not started');
    expect(whereLabel({ format: 'epub', progress: 1, page: 40, pageCount: 40 })).toBe('Finished');
    // A PDF is as before.
    expect(whereLabel({ format: 'pdf', progress: 0.42, page: 7, pageCount: 40 })).toBe('p. 7 of 40');
    expect(cardLabel({ ...book('m'), path: 'Books/m.epub', format: 'epub', progress: 0.5, page: 2, pageCount: 9 })).toBe('m, 50%, 1 highlight · 1 thought');
  });

  it('placeOf names a place by its kind: p. N, § N; null without one', () => {
    expect(placeOf(pdfLocation({ page: 4, start: 0, end: 1 }))).toBe('p. 4');
    expect(placeOf(epubLocation({ section: 6, start: 0, end: 1 }))).toBe('§ 6');
    expect(placeOf(null)).toBeNull();
  });
});

describe('shelfNotes: highlights & thoughts across books', () => {
  const T = (d: number) => `2026-02-${String(d).padStart(2, '0')}T00:00:00.000Z`;
  const a = book('a', { updatedAt: T(20) });
  const b = book('b', { updatedAt: T(10) });
  const gone = book('gone', { missing: true });
  const loaded: LoadedBooks = new Map([
    ['a', file('a', {
      annotations: [
        { quote: 'second  place', location: pdf(9), color: 'green', createdAt: T(1), updatedAt: T(1) },
        { quote: 'first place', location: pdf(2), color: 'pink', note: ' a note ', createdAt: T(2), updatedAt: T(2) },
      ],
      thoughts: [
        { body: '**later** thought', anchorId: 'a-h0', createdAt: T(8), updatedAt: T(8) },
        { body: 'at a place', location: pdf(5), createdAt: T(3), updatedAt: T(3) },
        { body: '   ', anchorId: 'a-h1', createdAt: T(4), updatedAt: T(30) },
      ],
    })],
    ['b', file('b', { annotations: [{ quote: 'b quote', location: pdf(1), color: 'yellow', createdAt: T(5), updatedAt: T(5) }] })],
    ['gone', file('gone', { annotations: [{ quote: 'hidden' }] })],
  ]);
  const ids = (ns: ReturnType<typeof shelfNotes>) => ns.map((n) => n.id);

  it('a highlight carries its note and its thoughts; a thought at a place stands alone; empty thoughts and missing books are left out', () => {
    const ns = shelfNotes([a, b, gone], loaded, ALL_NOTES);
    expect(ns).toHaveLength(4);
    const h0 = ns.find((n) => n.id === 'a-h0')!;
    expect(h0).toMatchObject({ quote: 'second place', color: 'green', note: null, thoughts: [{ id: 'a-t0', text: 'later thought' }], updatedAt: T(8) });
    expect(ns.find((n) => n.id === 'a-h1')).toMatchObject({ note: 'a note', thoughts: [] });
    expect(ns.find((n) => n.id === 'a-t1')).toMatchObject({ quote: null, color: null, thoughts: [{ id: 'a-t1', text: 'at a place' }], page: 5 });
  });

  it('newest change first across books (a thought makes its highlight newer)', () => {
    expect(ids(shelfNotes([a, b], loaded, ALL_NOTES))).toEqual(['a-h0', 'b-h0', 'a-t1', 'a-h1']);
  });

  it('by book: shelf order, then reading order within a book', () => {
    expect(ids(shelfNotes([a, b], loaded, { ...ALL_NOTES, sort: 'book' }))).toEqual(['a-h1', 'a-t1', 'a-h0', 'b-h0']);
  });

  it('filters by kind, colour and book', () => {
    expect(ids(shelfNotes([a, b], loaded, { ...ALL_NOTES, kind: 'highlights' }))).toEqual(['a-h0', 'b-h0', 'a-h1']);
    expect(ids(shelfNotes([a, b], loaded, { ...ALL_NOTES, kind: 'notes' }))).toEqual(['a-h1']);
    expect(ids(shelfNotes([a, b], loaded, { ...ALL_NOTES, kind: 'thoughts' }))).toEqual(['a-h0', 'a-t1']);
    // A colour leaves out thoughts at a place (they have none).
    expect(ids(shelfNotes([a, b], loaded, { ...ALL_NOTES, colors: ['pink', 'yellow'] }))).toEqual(['b-h0', 'a-h1']);
    expect(ids(shelfNotes([a, b], loaded, { ...ALL_NOTES, bookId: 'b' }))).toEqual(['b-h0']);
  });

  it('a recent thought says which highlight it hangs off', async () => {
    const files = [file('a', { annotations: [{ quote: 'the  quote' }], thoughts: [{ body: 'on it', anchorId: 'a-h0' }, { body: 'free', location: pdf(3) }] })];
    const recent = await recentThoughts([book('a')], sourceOf(files), new Map());
    expect(recent.map((r) => [r.text, r.quote])).toEqual(expect.arrayContaining([['on it', 'the quote'], ['free', null]]));
  });
});
