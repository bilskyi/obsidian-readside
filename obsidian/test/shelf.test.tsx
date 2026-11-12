import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderers/pdf/PdfRenderer', async () => ({ PdfRenderer: (await import('./fakeRenderer')).FakePdfRenderer }));

import { Modal, Notice, type App } from 'obsidian';
import * as bodySaves from '../../src/features/notebook/bodySaves';
import { backend, setBackend } from '../../src/lib/backend';
import { parseLocation } from '../../src/lib/location';
import MarginPlugin from '../src/main';
import { PdfPicker } from '../src/open';
import { Shelf, type ShelfSource } from '../src/shelf/Shelf';
import { REFRESH_DEBOUNCE_MS, SEARCH_CHUNK, SEARCH_DEBOUNCE_MS } from '../src/shelf/shelfData';
import { SUMMARY_COALESCE_MS, type ShelfEntry } from '../src/store/bookStore';
import { SHELF_VIEW_TYPE, ShelfView } from '../src/shelf/ShelfView';
import type { BookFile, BookSummary, IndexFile } from '../src/store/types';
import { VIEW_TYPE } from '../src/view/MarginView';
import { makeApp, manifest, pdfBytes, ROOT } from './helpers';

let app: App;
let plugin: MarginPlugin | null = null;

const pdfLoc = (page: number) => JSON.stringify({ kind: 'pdf', value: { page, start: 0, end: 4 }, label: `p. ${page}` });
const OLD = '2026-01-05T10:00:00.000Z';

function bookFile(id: string, path: string, title: string, parts: Partial<Pick<BookFile, 'annotations' | 'thoughts'>> = {}): BookFile {
  return {
    version: 1,
    book: { id, contentHash: '1:x', path, format: 'pdf', title, author: null, lastLocation: null, addedAt: OLD, openedAt: null, zoom: null, progress: null },
    annotations: parts.annotations ?? [],
    thoughts: parts.thoughts ?? [],
  };
}

const summary = (over: Partial<BookSummary>): BookSummary => ({
  title: null, progress: null, page: null, annotationCount: 0, thoughtCount: 0, thoughtsByMonth: {}, updatedAt: OLD, ...over,
});

/**
 * A vault with Margin's files already written: `books` go to books/<id>.json, `index` to index.json.
 * Every PDF named in the index exists in the vault unless its entry is missing.
 */
async function setup(store: { books?: BookFile[]; index?: IndexFile['entries']; indexText?: string } = {}) {
  app = makeApp();
  const a = app.vault.adapter;
  for (const f of [`${ROOT}/books`, `${ROOT}/backups`]) a.folders.add(f);
  for (const b of store.books ?? []) a.files.set(`${ROOT}/books/${b.book.id}.json`, JSON.stringify(b));
  if (store.index) a.files.set(`${ROOT}/index.json`, store.indexText ?? JSON.stringify({ version: 1, entries: store.index }));
  for (const [path, e] of Object.entries(store.index ?? {})) if (!e.missing) app.vault.addBinary(path, pdfBytes(path));
  plugin = new MarginPlugin(app, manifest);
  plugin.savedData = {};
  await plugin.onload();
  await plugin.ready;
  return plugin;
}

const shelfLeaves = () => app.workspace.getLeavesOfType(SHELF_VIEW_TYPE);

afterEach(async () => {
  vi.useRealTimers();
  if (plugin) {
    plugin.unload();
    await plugin.unloading;
    await app.workspace.viewsClosing;
  }
  plugin = null;
  setBackend(null);
  bodySaves.resetBodySavesForTests();
  document.body.replaceChildren();
});

describe('opening the shelf', () => {
  it('the command and the ribbon open one shelf tab, inside a .margin-app root', async () => {
    const p = await setup();
    p.ribbonIcons[0].el.click();
    await waitFor(() => expect(shelfLeaves()).toHaveLength(1));
    expect(Modal.opened).toHaveLength(0);
    p.command('open-shelf').callback!();
    await p.openShelf();
    expect(shelfLeaves()).toHaveLength(1);
    const view = shelfLeaves()[0].view;
    expect(view).toBeInstanceOf(ShelfView);
    expect(view.getDisplayText()).toBe('Readside shelf');
    expect(view.getIcon()).toBe('book-open');
    const heading = await screen.findByRole('heading', { level: 1, name: 'Readside shelf' });
    expect(heading.closest('.margin-app')?.parentElement).toBe((view as ShelfView).contentEl);
  });

  it('no books yet: an empty state whose button opens the picker', async () => {
    const p = await setup();
    await p.openShelf();
    expect(await screen.findByText('Open a PDF or EPUB in Readside to start your shelf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open a book…' }));
    await waitFor(() => expect(Modal.opened[0]).toBeInstanceOf(PdfPicker));
  });
});

describe('the grid', () => {
  const index: IndexFile['entries'] = {
    'Books/Thinking.pdf': {
      bookId: 'b1', fingerprint: '1:a', missing: false, openedAt: '2026-11-10T10:00:00.000Z',
      summary: summary({ title: 'Thinking, Fast and Slow', progress: 0.14, page: 42, pageCount: 310, annotationCount: 18, thoughtCount: 7, thoughtsByMonth: { '2026-11': 2 } }),
    },
    'Books/Deep_Work.pdf': {
      bookId: 'b2', fingerprint: '1:b', missing: false, openedAt: '2026-11-01T10:00:00.000Z',
      summary: summary({ progress: 1, page: 200, annotationCount: 3, thoughtCount: 1, thoughtsByMonth: { '2026-11': 1 } }),
    },
    'Books/Gone.pdf': { bookId: 'b3', fingerprint: '1:c', missing: true, summary: summary({ title: 'Gone Book', page: 3 }) },
  };

  it('draws every card from the index alone: no book file is read', async () => {
    const p = await setup({ index });
    const reads = vi.spyOn(app.vault.adapter, 'read');
    const listBooks = vi.spyOn(p.store, 'listBooks');
    await p.openShelf();
    const cards = await screen.findAllByRole('listitem');
    expect(cards.map((c) => c.textContent)).toEqual([
      'Thinking, Fast and Slowp. 42 of 31018 highlights · 7 thoughts',
      'Deep WorkFinished3 highlights · 1 thought',
      'Gone BookFile missing0 highlights · 0 thoughts',
    ]);
    expect(screen.getByText(/^2 books in this vault, 1 missing · 21 highlights · \d+ thoughts? this month$/)).toBeTruthy();
    // Let the background lists run: nothing in these summaries asks for a book file.
    await screen.findByText('Your thoughts on what you read will show up here.');
    expect(reads).not.toHaveBeenCalled();
    expect(listBooks).not.toHaveBeenCalled();
  });

  it('a card opens its book where it was left; a missing book is dimmed and not a button', async () => {
    const p = await setup({ index });
    const open = vi.spyOn(p, 'openInMargin').mockResolvedValue();
    await p.openShelf();
    fireEvent.click(await screen.findByRole('button', { name: /Thinking, Fast and Slow/ }));
    expect(open).toHaveBeenCalledWith(app.vault.getFileByPath('Books/Thinking.pdf'), null, false);
    expect(screen.queryByRole('button', { name: /Gone Book/ })).toBeNull();
    const gone = screen.getByText('Gone Book').closest('.shelf-card')!;
    expect(gone.classList.contains('is-missing')).toBe(true);
    expect(within(gone as HTMLElement).getByText('File missing')).toBeTruthy();
  });

  it('a book whose file left the vault unnoticed says so instead of opening', async () => {
    const p = await setup({ index });
    const open = vi.spyOn(p, 'openInMargin');
    await p.openShelf();
    await app.vault.delete(app.vault.getFileByPath('Books/Deep_Work.pdf')!);
    // Before the store marks it missing, the card may still be there.
    p.shelfHost.openBook('Books/Deep_Work.pdf', null);
    expect(open).not.toHaveBeenCalled();
    expect(Notice.messages.at(-1)).toBe("Readside can't find Books/Deep_Work.pdf in this vault.");
  });

  it('follows the store: a new highlight and a deleted file show without reopening the shelf', async () => {
    const p = await setup({ books: [bookFile('b1', 'Books/Thinking.pdf', 'Thinking, Fast and Slow')], index });
    await p.openShelf();
    await screen.findByText('18 highlights · 7 thoughts');
    await backend().createAnnotation({ bookId: 'b1', location: parseLocation(pdfLoc(1))!, quote: 'new', color: 'blue' });
    // The book is loaded now: its card follows the live book (one highlight on disk, the summary said 18).
    expect(await screen.findByText('1 highlight · 0 thoughts')).toBeTruthy();
    await app.vault.delete(app.vault.getFileByPath('Books/Deep_Work.pdf')!);
    await waitFor(() => expect(screen.getByText('Deep Work').closest('.shelf-card')!.classList.contains('is-missing')).toBe(true));
  });

  it('an index from before summaries: cards show from the path, and fill in once the books load', async () => {
    const p = await setup({
      books: [bookFile('b1', 'Books/Walden.pdf', 'Walden', { thoughts: [{ id: 't1', bookId: 'b1', body: 'Simplify', anchorId: null, location: null, position: 1, createdAt: OLD, updatedAt: OLD, labelSection: null, labelSnippet: null, labelCustom: null }] })],
      index: { 'Books/Walden.pdf': { bookId: 'b1', fingerprint: '1:x', missing: false } },
    });
    await p.openShelf();
    expect(await screen.findByRole('button', { name: /Walden/ })).toBeTruthy();
    // The recent-thoughts pass reads the book in the background; its summary goes into the index.
    expect(await screen.findByText('Simplify')).toBeTruthy();
    await screen.findByText('0 highlights · 1 thought');
    await p.store.flush();
    expect((JSON.parse(app.vault.adapter.files.get(`${ROOT}/index.json`) as string) as IndexFile).entries['Books/Walden.pdf'].summary).toMatchObject({ thoughtCount: 1 });
  });
});

describe('search', () => {
  const books = [
    bookFile('b1', 'Books/A.pdf', 'Book A', {
      annotations: [{ id: 'h1', bookId: 'b1', location: pdfLoc(7), quote: 'Friction decides more than motivation', color: 'yellow', note: null, unanchored: false, createdAt: OLD, updatedAt: OLD }],
    }),
    bookFile('b2', 'Books/B.pdf', 'Book B', {
      thoughts: [{ id: 't1', bookId: 'b2', body: 'Design out the friction', anchorId: null, location: pdfLoc(3), position: 1, createdAt: OLD, updatedAt: OLD, labelSection: null, labelSnippet: null, labelCustom: null }],
    }),
  ];
  const index: IndexFile['entries'] = {
    'Books/A.pdf': { bookId: 'b1', fingerprint: '1:a', missing: false, openedAt: '2026-11-02T00:00:00.000Z', summary: summary({ title: 'Book A', annotationCount: 1 }) },
    'Books/B.pdf': { bookId: 'b2', fingerprint: '1:b', missing: false, openedAt: '2026-11-01T00:00:00.000Z', summary: summary({ title: 'Book B', thoughtCount: 1 }) },
  };

  it('has a label; waits for typing to pause; groups matches by book; a match opens the book at its place', async () => {
    const p = await setup({ books, index });
    const open = vi.spyOn(p, 'openInMargin').mockResolvedValue();
    await p.openShelf();
    const field = await screen.findByLabelText('Search all highlights and thoughts');
    const file = vi.spyOn(p.store, 'file');
    fireEvent.change(field, { target: { value: 'FRICTION' } });
    // Debounced: nothing is read or searched yet.
    expect(screen.getByRole('status').textContent).toBe('Searching…');
    expect(file).not.toHaveBeenCalled();
    expect(await screen.findByText('2 matches in 2 books', {}, { timeout: SEARCH_DEBOUNCE_MS + 1000 })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Book A', 'Book B']);
    expect([...document.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['Friction', 'friction']);
    fireEvent.click(screen.getByRole('button', { name: /Thought · p\. 3/ }));
    expect(open).toHaveBeenCalledWith(app.vault.getFileByPath('Books/B.pdf'), parseLocation(pdfLoc(3)), false);
    // Escape clears the search and the grid comes back.
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(await screen.findByRole('button', { name: /Book A/ })).toBeTruthy();
  });

  it('says when nothing matches', async () => {
    const p = await setup({ books, index });
    await p.openShelf();
    fireEvent.change(await screen.findByLabelText('Search all highlights and thoughts'), { target: { value: 'zebra' } });
    expect(await screen.findByText('Nothing matches “zebra”.', {}, { timeout: SEARCH_DEBOUNCE_MS + 1000 })).toBeTruthy();
  });
});

describe('recent thoughts and a highlight from a while ago', () => {
  const thought = (id: string, body: string, updatedAt: string, extra: Partial<BookFile['thoughts'][number]> = {}) =>
    ({ id, bookId: 'b1', body, anchorId: null, location: pdfLoc(4), position: 1, createdAt: updatedAt, updatedAt, labelSection: null, labelSnippet: null, labelCustom: null, ...extra });
  const highlight = (id: string, quote: string, page: number, createdAt: string) =>
    ({ id, bookId: 'b1', location: pdfLoc(page), quote, color: 'green' as const, note: null, unanchored: false, createdAt, updatedAt: createdAt });

  it('lists the newest thoughts and resurfaces an old highlight; both open the book at their place', async () => {
    const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const p = await setup({
      books: [
        bookFile('b1', 'Books/A.pdf', 'Book A', {
          annotations: [highlight('h-old', 'As you become skilled', 42, days(90)), highlight('h-old2', 'Energy diminishes', 43, days(60)), highlight('h-new', 'Fresh', 1, days(1))],
          thoughts: Array.from({ length: 7 }, (_, i) => thought(`t${i}`, `Thought number ${i}`, days(10 - i))),
        }),
      ],
      index: { 'Books/A.pdf': { bookId: 'b1', fingerprint: '1:a', missing: false, summary: summary({ title: 'Book A', annotationCount: 3, thoughtCount: 7, updatedAt: days(1) }) } },
    });
    const open = vi.spyOn(p, 'openInMargin').mockResolvedValue();
    await p.openShelf();
    const recent = await screen.findByRole('region', { name: 'Recent thoughts' });
    await within(recent).findByText('Thought number 6');
    expect(within(recent).getAllByRole('button').map((b) => b.textContent)).toEqual(
      [6, 5, 4, 3, 2].map((i) => `Book A · p. 4Thought number ${i}`),
    );
    fireEvent.click(within(recent).getAllByRole('button')[0]);
    expect(open).toHaveBeenLastCalledWith(app.vault.getFileByPath('Books/A.pdf'), parseLocation(pdfLoc(4)), false);

    const old = screen.getByRole('region', { name: 'From your shelf, a while ago' });
    const quote = await within(old).findByText(/^“(As you become skilled|Energy diminishes)”$/);
    expect(quote.textContent).not.toContain('Fresh');
    const first = quote.textContent;
    fireEvent.click(within(old).getByRole('button', { name: 'Show another' }));
    await waitFor(() => expect(within(old).getByText(/^“/).textContent).not.toBe(first));
    const page = within(old).getByText(/^“/).textContent === '“As you become skilled”' ? 42 : 43;
    expect(within(old).getByText(new RegExp(`^Book A · p\\. ${page} · highlighted \\d+ (weeks|months) ago$`))).toBeTruthy();
    fireEvent.click(within(old).getByRole('button', { name: 'Open at this spot' }));
    expect(open).toHaveBeenLastCalledWith(app.vault.getFileByPath('Books/A.pdf'), parseLocation(pdfLoc(page)), false);
  });
});

describe('page count', () => {
  it('the reader reports how many pages the book has; the index summary keeps it', async () => {
    const p = await setup();
    app.vault.addBinary('Books/Walden.pdf', pdfBytes('walden'));
    await p.openInMargin(app.vault.getFileByPath('Books/Walden.pdf')!);
    await screen.findByRole('heading', { name: 'Walden' });
    const id = p.store.bookIdForPath('Books/Walden.pdf')!;
    await waitFor(async () => {
      await p.store.flush();
      expect(p.store.entry('Books/Walden.pdf')?.summary?.pageCount).toBe(3); // the fake renderer's page count
    });
    expect(app.workspace.getLeavesOfType(VIEW_TYPE)).toHaveLength(1);
    expect(id).toBeTruthy();
  });
});

describe('teardown', () => {
  it('closing the shelf unmounts it and stops listening to the store', async () => {
    const p = await setup();
    let active = 0;
    const real = p.store.onIndexChange.bind(p.store);
    vi.spyOn(p.store, 'onIndexChange').mockImplementation((l) => {
      active++;
      const off = real(l);
      return () => {
        active--;
        off();
      };
    });
    await p.openShelf();
    await screen.findByText('Open a PDF or EPUB in Readside to start your shelf');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // One subscription, even though StrictMode runs the shelf's effects twice.
    expect(active).toBe(1);
    const leaf = shelfLeaves()[0];
    await act(async () => {
      await leaf.detach();
    });
    expect(document.querySelector('[data-margin-shelf]')).toBeNull();
    expect(active).toBe(0);
  });
});

// ---- fix round 1 ----

const hl = (bookId: string, id: string, quote: string, createdAt = OLD) =>
  ({ id, bookId, location: pdfLoc(1), quote, color: 'yellow' as const, note: null, unanchored: false, createdAt, updatedAt: createdAt });
const th = (bookId: string) =>
  ({ id: `t-${bookId}`, bookId, body: `a thought in ${bookId}`, anchorId: null, location: null, position: 1, createdAt: OLD, updatedAt: OLD, labelSection: null, labelSnippet: null, labelCustom: null }) as BookFile['thoughts'][number];
const readIndex = () => JSON.parse(app.vault.adapter.files.get(`${ROOT}/index.json`) as string) as IndexFile;

describe('a bad summary', () => {
  it('a string summary and a NaN progress: the shelf still draws, the book named from its file', async () => {
    const good = summary({ title: 'Fine Book', annotationCount: 2 });
    // Raw text: 1e999 parses as Infinity (JSON cannot hold NaN), a progress no bar can draw.
    const indexText = `{"version":1,"entries":{
      "Books/Deep_Work.pdf":{"bookId":"b1","fingerprint":"1:a","missing":false,"openedAt":"2026-11-03T00:00:00.000Z","summary":"garbage"},
      "Books/Slow_Reading.pdf":{"bookId":"b2","fingerprint":"1:b","missing":false,"openedAt":"2026-11-02T00:00:00.000Z","summary":${JSON.stringify(summary({ title: 'Real Title', annotationCount: 1 })).replace('"progress":null', '"progress":1e999')}},
      "Books/Fine.pdf":{"bookId":"b3","fingerprint":"1:c","missing":false,"openedAt":"2026-11-01T00:00:00.000Z","summary":${JSON.stringify(good)}}
    }}`;
    await setup({ index: { 'Books/Deep_Work.pdf': {} as never, 'Books/Slow_Reading.pdf': {} as never, 'Books/Fine.pdf': {} as never }, indexText });
    await plugin!.openShelf();
    const cards = await screen.findAllByRole('listitem');
    expect(cards.map((c) => c.textContent)).toEqual(['Deep WorkNot started', 'Slow ReadingNot started', 'Fine BookNot started2 highlights · 0 thoughts']);
    expect(screen.queryByText("Readside couldn't show the shelf.")).toBeNull();
  });

  it('a summary that slips past the checks: the shelf says it could not draw and Reload brings it back', async () => {
    const p = await setup({ index: { 'Books/A.pdf': { bookId: 'b1', fingerprint: '1:a', missing: false, summary: summary({ title: 'Book A' }) } } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const real = p.store.shelfEntries.bind(p.store);
    // An entry that throws when the grid reads it: the kind of surprise no check foresaw.
    const broken = (e: ShelfEntry) =>
      Object.defineProperty({ ...e }, 'summary', {
        get() {
          throw new Error('boom');
        },
      });
    const bad = vi.spyOn(p.store, 'shelfEntries').mockImplementation(() => real().map(broken));
    await p.openShelf();
    expect(await screen.findByText("Readside couldn't show the shelf.")).toBeTruthy();
    bad.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByRole('button', { name: /Book A/ })).toBeTruthy();
    expect(screen.queryByText("Readside couldn't show the shelf.")).toBeNull();
    err.mockRestore();
  });
});

describe('opening books from the shelf', () => {
  const index: IndexFile['entries'] = {
    'Books/A.pdf': { bookId: 'b1', fingerprint: '1:a', missing: false, summary: summary({ title: 'Book A', annotationCount: 1 }) },
  };

  it('⌘/Ctrl-click and middle-click ask for a new tab; a plain click for the shelf’s own', async () => {
    const p = await setup({ books: [bookFile('b1', 'Books/A.pdf', 'Book A', { annotations: [hl('b1', 'h1', 'Friction everywhere')] })], index });
    const open = vi.spyOn(p, 'openInMargin').mockResolvedValue();
    await p.openShelf();
    const card = await screen.findByRole('button', { name: /Book A/ });
    const file = app.vault.getFileByPath('Books/A.pdf');
    fireEvent.click(card, { metaKey: true });
    expect(open).toHaveBeenLastCalledWith(file, null, 'tab');
    fireEvent.click(card, { ctrlKey: true, altKey: true });
    expect(open).toHaveBeenLastCalledWith(file, null, 'split');
    fireEvent(card, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(open).toHaveBeenLastCalledWith(file, null, 'tab');
    const calls = open.mock.calls.length;
    fireEvent(card, new MouseEvent('auxclick', { bubbles: true, button: 2 })); // a right click opens nothing
    expect(open.mock.calls.length).toBe(calls);
    fireEvent.click(card);
    expect(open).toHaveBeenLastCalledWith(file, null, false);
    // A search result too.
    fireEvent.change(screen.getByLabelText('Search all highlights and thoughts'), { target: { value: 'friction' } });
    const hit = await screen.findByRole('button', { name: /Highlight · p\. 1/ }, { timeout: SEARCH_DEBOUNCE_MS + 1000 });
    fireEvent.click(hit, { ctrlKey: true });
    expect(open).toHaveBeenLastCalledWith(file, parseLocation(pdfLoc(1)), 'tab');
  });

  it('a new tab leaves the shelf where it is; a plain open replaces it', async () => {
    const p = await setup({ books: [bookFile('b1', 'Books/A.pdf', 'Book A')], index });
    await p.openShelf();
    await screen.findByRole('button', { name: /Book A/ });
    await p.openInMargin(app.vault.getFileByPath('Books/A.pdf')!, null, 'tab');
    expect(app.workspace.getLeavesOfType(VIEW_TYPE)).toHaveLength(1);
    expect(shelfLeaves()).toHaveLength(1);
    expect(app.workspace.getLeavesOfType(VIEW_TYPE)[0]).not.toBe(shelfLeaves()[0]);
  });

  it('Back restores the search and the scroll (getState / setState)', async () => {
    await setup({
      books: [bookFile('b1', 'Books/A.pdf', 'Book A', { annotations: [hl('b1', 'h1', 'Friction everywhere')] })],
      index,
    });
    await plugin!.openShelf();
    const leaf = shelfLeaves()[0];
    fireEvent.change(await screen.findByLabelText('Search all highlights and thoughts'), { target: { value: 'friction' } });
    await screen.findByText('1 match in 1 book', {}, { timeout: SEARCH_DEBOUNCE_MS + 1000 });
    const scroller = document.querySelector('[data-margin-shelf] .shelf') as HTMLElement;
    scroller.scrollTop = 140;
    fireEvent.scroll(scroller);
    expect(leaf.getViewState().state).toMatchObject({ query: 'friction', scroll: 140 });
    // What Obsidian does on Back: a new shelf view, given the state it recorded.
    const back = app.workspace.getLeaf('tab');
    await act(async () => {
      await back.setViewState({ type: SHELF_VIEW_TYPE, state: { query: 'friction', scroll: 140 } });
    });
    const restored = (back.view as ShelfView).contentEl;
    expect((await within(restored).findByLabelText<HTMLInputElement>('Search all highlights and thoughts')).value).toBe('friction');
    expect(await within(restored).findByText('1 match in 1 book')).toBeTruthy();
    expect((restored.querySelector('.shelf') as HTMLElement).scrollTop).toBe(140);
    expect(back.getViewState().state).toMatchObject({ query: 'friction', scroll: 140 });
  });
});

describe('cards for assistive tech', () => {
  it('each card is named title, where, counts; a missing one says so in text; one status region is always there', async () => {
    await setup({
      index: {
        'Books/Thinking.pdf': { bookId: 'b1', fingerprint: '1:a', missing: false, openedAt: '2026-11-10T10:00:00.000Z', summary: summary({ title: 'Thinking', page: 42, pageCount: 310, annotationCount: 18, thoughtCount: 7 }) },
        'Books/Gone.pdf': { bookId: 'b3', fingerprint: '1:c', missing: true, summary: summary({ title: 'Gone Book', annotationCount: 1 }) },
      },
    });
    await plugin!.openShelf();
    expect(await screen.findByRole('button', { name: 'Thinking, p. 42 of 310, 18 highlights · 7 thoughts' })).toBeTruthy();
    const gone = screen.getByRole('group', { name: 'Gone Book, File missing, 1 highlight · 0 thoughts' });
    expect(within(gone).getByText('File missing')).toBeTruthy();
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    fireEvent.change(screen.getByLabelText('Search all highlights and thoughts'), { target: { value: 'x' } });
    // The same element announces the search.
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toBe('Searching…');
  });
});

describe('the shelf’s reads', () => {
  it('a search over many books leaves the store with no book loaded', async () => {
    const books = Array.from({ length: 30 }, (_, i) => bookFile(`b${i}`, `Books/B${i}.pdf`, `Book ${i}`, { annotations: [hl(`b${i}`, `h${i}`, `quote ${i} needle`)] }));
    const index = Object.fromEntries(books.map((b, i) => [b.book.path, { bookId: b.book.id, fingerprint: `1:${i}`, missing: false, summary: summary({ title: b.book.title, annotationCount: 1 }) }]));
    const p = await setup({ books, index });
    await p.openShelf();
    // The background lists have run (they read through the same uncached path).
    await screen.findByText(/^“quote \d+ needle”$/);
    fireEvent.change(await screen.findByLabelText('Search all highlights and thoughts'), { target: { value: 'needle' } });
    await screen.findByText('30 matches in 30 books', {}, { timeout: SEARCH_DEBOUNCE_MS + 2000 });
    for (const b of books) expect(p.store.peek(b.book.id)).toBeNull();
  });

  it('a hidden shelf does not refresh; shown again, it does', async () => {
    const p = await setup({ books: [bookFile('b1', 'Books/A.pdf', 'Book A')], index: { 'Books/A.pdf': { bookId: 'b1', fingerprint: '1:a', missing: false, summary: summary({ title: 'Book A' }) } } });
    await p.openShelf();
    await screen.findByText('0 highlights · 0 thoughts');
    const shelf = shelfLeaves()[0];
    // Another tab comes to the front.
    const other = app.workspace.getLeaf('tab');
    app.workspace.setActiveLeaf(other);
    const entries = vi.spyOn(p.store, 'shelfEntries');
    await backend().createAnnotation({ bookId: 'b1', location: parseLocation(pdfLoc(1))!, quote: 'new', color: 'blue' });
    // Past the refresh debounce and the index summary write (another change the shelf hears).
    await act(async () => {
      await new Promise((r) => setTimeout(r, SUMMARY_COALESCE_MS + REFRESH_DEBOUNCE_MS + 300));
    });
    expect(entries).not.toHaveBeenCalled();
    expect(screen.queryByText('1 highlight · 0 thoughts')).toBeNull();
    act(() => app.workspace.setActiveLeaf(shelf));
    expect(await screen.findByText('1 highlight · 0 thoughts')).toBeTruthy();
    expect(entries).toHaveBeenCalled();
  });
});

describe('teardown: the unload tail', () => {
  it('writes a summary that was only waiting on the long timer', async () => {
    const p = await setup({ books: [bookFile('b1', 'Books/A.pdf', 'Book A')], index: { 'Books/A.pdf': { bookId: 'b1', fingerprint: '1:a', missing: false } } });
    await p.store.file('b1');
    await p.store.flush();
    expect(readIndex().entries['Books/A.pdf'].summary?.progress).toBeNull();
    await p.store.mutate('b1', (f) => void (f.book.progress = 0.4));
    await new Promise((r) => setTimeout(r, 600));
    expect(readIndex().entries['Books/A.pdf'].summary?.progress).toBeNull(); // position only: still waiting
    p.unload();
    await p.unloading;
    plugin = null;
    expect(readIndex().entries['Books/A.pdf'].summary?.progress).toBe(0.4);
  });
});

// ---- the shelf alone, with a source whose reads the test releases ----

interface Gate {
  id: string;
  resolve: (f: BookFile) => void;
}

function gatedSource(entries: ShelfEntry[]) {
  const gates: Gate[] = [];
  const reads = { count: 0, ids: [] as string[] };
  let onChange: (bookId?: string) => void = () => {};
  const files = new Map<string, BookFile>();
  let auto = true;
  const source: ShelfSource = {
    entries: () => [...entries],
    subscribe: (l) => {
      onChange = l;
      return () => {};
    },
    file: (id) => {
      reads.count++;
      reads.ids.push(id);
      return auto && files.has(id) ? Promise.resolve(files.get(id)!) : new Promise<BookFile>((resolve) => gates.push({ id, resolve }));
    },
  };
  return {
    source,
    reads,
    gates,
    files,
    manual: () => void (auto = false),
    change: (bookId?: string) => onChange(bookId),
    release: (pred: (g: Gate) => boolean, file: (id: string) => BookFile) => {
      for (const g of gates.filter(pred)) {
        gates.splice(gates.indexOf(g), 1);
        g.resolve(file(g.id));
      }
    },
  };
}

const entryOf = (i: number, over: Partial<BookSummary> = {}): ShelfEntry => ({
  path: `Books/${String.fromCharCode(65 + (i % 26))}${i}.pdf`,
  bookId: `b${i}`,
  missing: false,
  openedAt: null,
  summary: summary({ title: `Book ${String(i).padStart(2, '0')}`, annotationCount: 1, ...over }),
});

const settle = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

describe('search, with reads released by hand', () => {
  it('shows what it has found after each chunk of books', async () => {
    const entries = Array.from({ length: SEARCH_CHUNK + 1 }, (_, i) => entryOf(i));
    const g = gatedSource(entries);
    g.manual();
    render(<Shelf source={g.source} ready={Promise.resolve()} onOpen={() => {}} onPick={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Search all highlights and thoughts'), { target: { value: 'needle' } });
    await act(async () => {
      await new Promise((res) => setTimeout(res, SEARCH_DEBOUNCE_MS + 50));
    });
    const withNeedle = (id: string) => bookFile(id, `${id}.pdf`, id, { annotations: [hl(id, `h-${id}`, `a needle in ${id}`)] });
    // Every read but the last book's lands (the background lists read too); the first chunk is complete.
    const last = `b${SEARCH_CHUNK}`;
    for (let n = 0; n < 50 && screen.getByRole('status').textContent === 'Searching…'; n++) {
      await act(async () => g.release((x) => x.id !== last, withNeedle));
      await settle();
    }
    expect(screen.getByRole('status').textContent).toBe(`${SEARCH_CHUNK} matches in ${SEARCH_CHUNK} books so far…`);
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(SEARCH_CHUNK);
    await waitFor(() => expect(g.gates.some((x) => x.id === last)).toBe(true));
    await act(async () => g.release(() => true, withNeedle));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(`${SEARCH_CHUNK + 1} matches in ${SEARCH_CHUNK + 1} books`));
  });

  it('a query whose reads land late does not replace a newer search', async () => {
    const g = gatedSource([entryOf(0)]);
    g.manual();
    render(<Shelf source={g.source} ready={Promise.resolve()} onOpen={() => {}} onPick={() => {}} />);
    const field = await screen.findByLabelText('Search all highlights and thoughts');
    // The background list's read (resurfacing) is asked for first; it is never released.
    await waitFor(() => expect(g.gates).toHaveLength(1));
    const typed = async (q: string) => {
      const before = g.gates.length;
      fireEvent.change(field, { target: { value: q } });
      await waitFor(() => expect(g.gates.length).toBe(before + 1), { timeout: SEARCH_DEBOUNCE_MS + 1000 });
      return g.gates[before];
    };
    const first = await typed('apple'); // first read: the book as it was
    await typed('pear');
    const third = await typed('apple'); // third read: the book as it is now
    const version = (quote: string) => (id: string) => bookFile(id, `${id}.pdf`, id, { annotations: [hl(id, 'h', quote)] });
    await act(async () => g.release((x) => x === third, version('apple, the new note')));
    expect(await screen.findByText(/the new note/)).toBeTruthy();
    await act(async () => g.release((x) => x === first, version('apple, the stale note')));
    await settle();
    expect(screen.queryByText(/the stale note/)).toBeNull();
    expect(screen.getByText(/the new note/)).toBeTruthy();
  });
});

describe('Show another, with reads released by hand', () => {
  it('only the newest request shows, whichever lands last', async () => {
    const entries = [0, 1, 2].map((i) => entryOf(i));
    const g = gatedSource(entries);
    const quotes = ['Alpha line', 'Beta line', 'Gamma line'];
    entries.forEach((e, i) => g.files.set(e.bookId, bookFile(e.bookId, e.path, `Book ${i}`, { annotations: [hl(e.bookId, `h${i}`, quotes[i])] })));
    let r = 0;
    render(<Shelf source={g.source} ready={Promise.resolve()} onOpen={() => {}} onPick={() => {}} random={() => r} />);
    const old = await screen.findByRole('region', { name: 'From your shelf, a while ago' });
    // r = 0 shuffles the three books to [1, 2, 0] and picks the first: Beta.
    expect(await within(old).findByText('“Beta line”')).toBeTruthy();
    // A store change empties what was read; the shown highlight is checked (its book read again) and stays.
    const before = g.reads.count;
    act(() => entries.forEach((e) => g.change(e.bookId)));
    await waitFor(() => expect(g.reads.count).toBe(before + 1), { timeout: REFRESH_DEBOUNCE_MS + 1000 });
    await settle();
    g.manual();
    fireEvent.click(within(old).getByRole('button', { name: 'Show another' }));
    fireEvent.click(within(old).getByRole('button', { name: 'Show another' }));
    await waitFor(() => expect(g.gates).toHaveLength(4)); // books 2 and 0, for each request
    const [a1, b1, a2, b2] = [...g.gates];
    const fileOf = (id: string) => g.files.get(id)!;
    // The second request lands first and picks the last of [Gamma, Alpha]…
    r = 0.99;
    await act(async () => g.release((x) => x === a2 || x === b2, fileOf));
    expect(await within(old).findByText('“Alpha line”')).toBeTruthy();
    // …then the first one lands, picking Gamma: it is dropped.
    r = 0;
    await act(async () => g.release((x) => x === a1 || x === b1, fileOf));
    await settle();
    expect(within(old).getByText('“Alpha line”')).toBeTruthy();
    expect(within(old).queryByText('“Gamma line”')).toBeNull();
  });
});

describe('a visible shelf and a reading save', () => {
  const three = () => {
    const entries = [0, 1, 2].map((i) => entryOf(i, { thoughtCount: 1 }));
    const g = gatedSource(entries);
    for (const e of entries) g.files.set(e.bookId, bookFile(e.bookId, e.path, e.bookId, { annotations: [hl(e.bookId, `h-${e.bookId}`, `a needle in ${e.bookId}`)], thoughts: [th(e.bookId)] }));
    return { entries, g };
  };
  const search = async (g: ReturnType<typeof gatedSource>, visibility?: unknown) => {
    const view = render(<Shelf source={g.source} ready={Promise.resolve()} onOpen={() => {}} onPick={() => {}} visibility={visibility as never} />);
    fireEvent.change(await screen.findByLabelText('Search all highlights and thoughts'), { target: { value: 'needle' } });
    await screen.findByText('3 matches in 3 books', {}, { timeout: SEARCH_DEBOUNCE_MS + 1000 });
    await settle();
    return view;
  };
  const afterRefresh = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, REFRESH_DEBOUNCE_MS + 300));
    });
    await settle();
  };

  it('a position save on one book reads at most that book again, with the query still typed', async () => {
    const { g } = three();
    await search(g);
    g.reads.ids.length = 0;
    act(() => g.change('b1'));
    await afterRefresh();
    expect(g.reads.ids.length).toBeGreaterThan(0); // the changed book is read again (its search could change)
    expect(new Set(g.reads.ids)).toEqual(new Set(['b1']));
    expect(screen.getByText('3 matches in 3 books')).toBeTruthy();
  });

  it('an index change that does not add, move or remove an entry reads no book', async () => {
    const { g } = three();
    await search(g);
    g.reads.ids.length = 0;
    act(() => g.change());
    await afterRefresh();
    expect(g.reads.ids).toEqual([]);
  });

  it('an index change that adds a book refreshes fully', async () => {
    const { entries, g } = three();
    await search(g);
    g.reads.ids.length = 0;
    entries.push(entryOf(3));
    g.files.set('b3', bookFile('b3', entries[3].path, 'b3', { annotations: [hl('b3', 'h-b3', 'a needle in b3')] }));
    act(() => g.change());
    await screen.findByText('4 matches in 4 books', {}, { timeout: REFRESH_DEBOUNCE_MS + SEARCH_DEBOUNCE_MS + 1500 });
    expect(new Set(g.reads.ids)).toEqual(new Set(['b0', 'b1', 'b2', 'b3']));
  });

  it('the plugin: a position save reads no other book file', async () => {
    const books = [1, 2, 3].map((i) => bookFile(`b${i}`, `Books/B${i}.pdf`, `Book ${i}`, { annotations: [hl(`b${i}`, `h${i}`, `needle ${i}`)] }));
    const index = Object.fromEntries(books.map((b, i) => [b.book.path, { bookId: b.book.id, fingerprint: `1:${i}`, missing: false, summary: summary({ title: b.book.title, annotationCount: 1 }) }]));
    const p = await setup({ books, index });
    await p.openShelf();
    fireEvent.change(await screen.findByLabelText('Search all highlights and thoughts'), { target: { value: 'needle' } });
    await screen.findByText('3 matches in 3 books', {}, { timeout: SEARCH_DEBOUNCE_MS + 2000 });
    await settle();
    const peeks = vi.spyOn(p.store, 'peekFile');
    await backend().setLastLocation('b1', parseLocation(pdfLoc(5))!);
    await afterRefresh();
    expect(peeks.mock.calls.length).toBeGreaterThan(0);
    expect(new Set(peeks.mock.calls.map((c) => c[0]))).toEqual(new Set(['b1']));
  });

  it('emptying the query lets the read books go: the next change reads them again', async () => {
    const { g } = three();
    await search(g);
    fireEvent.keyDown(screen.getByLabelText('Search all highlights and thoughts'), { key: 'Escape' });
    await settle();
    await screen.findByText('Recent thoughts');
    await settle();
    g.reads.ids.length = 0;
    act(() => g.change('b1'));
    await afterRefresh();
    expect(new Set(g.reads.ids)).toEqual(new Set(['b0', 'b1', 'b2']));
  });

  it('a shelf that goes out of sight lets the read books go', async () => {
    const { g } = three();
    let shown = true;
    const listeners = new Set<() => void>();
    const visibility = { visible: () => shown, onShow: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)) };
    await search(g, visibility);
    shown = false;
    act(() => listeners.forEach((l) => l()));
    shown = true;
    g.reads.ids.length = 0;
    act(() => g.change('b1'));
    await afterRefresh();
    expect(new Set(g.reads.ids)).toEqual(new Set(['b0', 'b1', 'b2']));
  });
});

describe('the shelf in a split, restoring, and the middle button', () => {
  const index: IndexFile['entries'] = { 'Books/A.pdf': { bookId: 'b1', fingerprint: '1:a', missing: false, summary: summary({ title: 'Book A', annotationCount: 1 }) } };

  it('a shelf in a split beside the active leaf is on screen: it refreshes', async () => {
    const p = await setup({ books: [bookFile('b1', 'Books/A.pdf', 'Book A')], index });
    await p.openShelf();
    await screen.findByText('0 highlights · 0 thoughts');
    const shelf = shelfLeaves()[0];
    app.workspace.setActiveLeaf(app.workspace.getLeaf('tab'));
    shelf.view.shown = true; // Obsidian's isShown(): a split is on screen without being the active leaf
    await backend().createAnnotation({ bookId: 'b1', location: parseLocation(pdfLoc(1))!, quote: 'new', color: 'blue' });
    expect(await screen.findByText('1 highlight · 0 thoughts', {}, { timeout: REFRESH_DEBOUNCE_MS + 1500 })).toBeTruthy();
  });

  it('restoring a state mounts the shelf once', async () => {
    await setup({ books: [bookFile('b1', 'Books/A.pdf', 'Book A', { annotations: [hl('b1', 'h1', 'Friction')] })], index });
    const back = app.workspace.getLeaf('tab');
    const seen = new Set<Element>();
    const watch = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) for (const el of [n, ...n.querySelectorAll('.shelf')]) if (el.classList.contains('shelf')) seen.add(el);
    });
    watch.observe(back.containerEl, { childList: true, subtree: true });
    // onOpen and the restoring setState follow each other: the shelf is drawn once, from the restored state.
    const draws = vi.spyOn(ShelfView.prototype as unknown as { render: () => void }, 'render');
    await act(async () => {
      await back.setViewState({ type: SHELF_VIEW_TYPE, state: { query: 'friction', scroll: 0 } });
    });
    await within((back.view as ShelfView).contentEl).findByText('1 match in 1 book', {}, { timeout: SEARCH_DEBOUNCE_MS + 1000 });
    watch.disconnect();
    expect(seen.size).toBe(1);
    expect(draws).toHaveBeenCalledTimes(1);
    draws.mockRestore();
  });

  it('a middle press on a card or a result is not left to the browser (no autoscroll)', async () => {
    const p = await setup({ books: [bookFile('b1', 'Books/A.pdf', 'Book A', { annotations: [hl('b1', 'h1', 'Friction')] })], index });
    vi.spyOn(p, 'openInMargin').mockResolvedValue();
    await p.openShelf();
    const press = (el: Element, button: number) => fireEvent(el, new MouseEvent('mousedown', { bubbles: true, cancelable: true, button }));
    const card = await screen.findByRole('button', { name: /Book A/ });
    expect(press(card, 1)).toBe(false);
    expect(press(card, 0)).toBe(true);
    fireEvent.change(screen.getByLabelText('Search all highlights and thoughts'), { target: { value: 'friction' } });
    const hit = await screen.findByRole('button', { name: /Highlight/ }, { timeout: SEARCH_DEBOUNCE_MS + 1000 });
    expect(press(hit, 1)).toBe(false);
    expect(press(hit, 2)).toBe(true);
  });
});

describe('the shelf names an EPUB’s places by section (E7)', () => {
  const eLoc = (section: number) => JSON.stringify({ kind: 'epub', value: { section, start: 0, end: 4 }, label: `§ ${section}` });

  it('recent thoughts, the old highlight and search results say § N for an EPUB', async () => {
    const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const moby = bookFile('m1', 'Books/Moby.epub', 'Moby-Dick', {
      annotations: [{ id: 'h1', bookId: 'm1', location: eLoc(5), quote: 'Call me Ishmael', color: 'green', note: null, unanchored: false, createdAt: days(60), updatedAt: days(60) }],
      thoughts: [{ id: 't1', bookId: 'm1', body: 'Whale thought', anchorId: null, location: eLoc(7), position: 1, createdAt: days(2), updatedAt: days(2), labelSection: null, labelSnippet: null, labelCustom: null }],
    });
    moby.book.format = 'epub';
    const p = await setup({
      books: [moby],
      index: { 'Books/Moby.epub': { bookId: 'm1', fingerprint: '1:m', missing: false, summary: summary({ title: 'Moby-Dick', progress: 0.3, page: 7, annotationCount: 1, thoughtCount: 1, updatedAt: days(2) }) } },
    });
    vi.spyOn(p, 'openInMargin').mockResolvedValue();
    await p.openShelf();
    const recent = await screen.findByRole('region', { name: 'Recent thoughts' });
    await within(recent).findByText('Whale thought');
    expect(within(recent).getByRole('button').textContent).toBe('Moby-Dick · § 7Whale thought');
    const old = screen.getByRole('region', { name: 'From your shelf, a while ago' });
    expect(await within(old).findByText(/Moby-Dick · § 5 · highlighted/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Moby-Dick, 30%/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search all highlights and thoughts'), { target: { value: 'ishmael' } });
    expect(await screen.findByRole('button', { name: /Highlight · § 5/ }, { timeout: SEARCH_DEBOUNCE_MS + 1000 })).toBeTruthy();
  });
});

describe('back to the shelf from a book (H1)', () => {
  const index: IndexFile['entries'] = { 'Books/Walden.pdf': { bookId: 'w', fingerprint: '1:x', missing: false } };
  const openBook = async (p: MarginPlugin) => {
    const leaf = app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: 'Books/Walden.pdf' }, active: true });
    await screen.findByRole('heading', { name: 'Walden' });
    return { leaf, p };
  };

  it('the reader’s Shelf button opens the shelf, and reveals it when it is already open', async () => {
    const p = await setup({ books: [bookFile('w', 'Books/Walden.pdf', 'Walden')], index });
    const spy = vi.spyOn(p, 'openShelf');
    await openBook(p);
    const button = screen.getByRole('button', { name: 'Shelf' });
    expect(button.title).toBe('Open Readside shelf');
    expect(button.querySelector('svg')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Library' })).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(shelfLeaves()).toHaveLength(1));
    expect(spy).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Shelf' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(shelfLeaves()).toHaveLength(1);
  });

  it('the tab header has an “Open Readside shelf” action (there in focus mode, where the toolbar is not)', async () => {
    const p = await setup({ books: [bookFile('w', 'Books/Walden.pdf', 'Walden')], index });
    const spy = vi.spyOn(p, 'openShelf');
    const { leaf } = await openBook(p);
    const actions = leaf.view.containerEl.querySelectorAll<HTMLElement>('.view-header .view-action');
    expect([...actions].map((a) => [a.dataset.icon, a.getAttribute('aria-label')])).toEqual([['library', 'Open Readside shelf']]);
    // Focus mode hides the toolbar; the header action stays.
    fireEvent.click(screen.getByRole('button', { name: 'Focus mode' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Shelf' })).toBeNull());
    actions[0].click();
    await waitFor(() => expect(shelfLeaves()).toHaveLength(1));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
