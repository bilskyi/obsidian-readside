import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderers/pdf/PdfRenderer', async () => ({ PdfRenderer: (await import('./fakeRenderer')).FakePdfRenderer }));

import { Menu, Modal, Notice, TFile, __installCanvas, __setPdfJs, type App } from 'obsidian';
import * as bodySaves from '../../src/features/notebook/bodySaves';
import { setBackend } from '../../src/lib/backend';
import { CoverImagePicker, showCoverMenu } from '../src/covers/coverMenu';
import type { CoverView } from '../src/covers/covers';
import MarginPlugin from '../src/main';
import { Shelf, type ShelfSource } from '../src/shelf/Shelf';
import type { ShelfEntry } from '../src/store/bookStore';
import type { BookSummary, IndexFile } from '../src/store/types';
import { makeApp, manifest, pdfBytes, ROOT } from './helpers';

const OLD = '2026-01-05T10:00:00.000Z';
const summary = (over: Partial<BookSummary>): BookSummary => ({
  title: null, progress: null, page: null, annotationCount: 0, thoughtCount: 0, thoughtsByMonth: {}, updatedAt: OLD, ...over,
});
const entry = (id: string, title: string, missing = false): ShelfEntry => ({
  path: `Books/${id}.pdf`, bookId: id, missing, openedAt: null, summary: summary({ title }),
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('shelf cards: covers', () => {
  function source(views: Record<string, CoverView>, over: Partial<ShelfSource> = {}) {
    const entries = [entry('a', 'Walden'), entry('b', 'Deep Work'), entry('c', 'Gone', true)];
    let onChange: (bookId?: string) => void = () => {};
    const s: ShelfSource = {
      entries: () => [...entries],
      subscribe: (l) => {
        onChange = l;
        return () => {};
      },
      file: () => new Promise(() => {}),
      cover: (e) => views[e.bookId] ?? { src: null, wantsThumb: false },
      requestCover: vi.fn(),
      coverMenu: vi.fn(),
      ...over,
    };
    return { s, change: () => onChange() };
  }
  const cardOf = (title: string) => screen.getByText(title).closest('.shelf-card-wrap') as HTMLElement;

  it('an image cover: lazy, alt="" (the card is labelled), object-fit class, title kept over it; no image: the colour tile', async () => {
    const { s } = source({ a: { src: 'app://local/a.webp?1', wantsThumb: false } });
    render(<Shelf source={s} ready={Promise.resolve()} onOpen={() => {}} onPick={() => {}} />);
    await screen.findByText('Walden');
    const img = cardOf('Walden').querySelector('img')!;
    expect(img.getAttribute('src')).toBe('app://local/a.webp?1');
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.className).toBe('shelf-cover-img');
    expect(img.closest('.shelf-cover')!.classList.contains('has-image')).toBe(true);
    expect(cardOf('Walden').querySelector('.shelf-cover-title')!.textContent).toBe('Walden');
    expect(screen.getByRole('button', { name: /^Walden/ })).toBeTruthy();
    expect(cardOf('Deep Work').querySelector('img')).toBeNull();
    expect(cardOf('Deep Work').querySelector('.shelf-cover')!.classList.contains('has-image')).toBe(false);
  });

  it('a missing book keeps its image, inside the dimmed card', async () => {
    const { s } = source({ c: { src: 'app://local/c.webp', wantsThumb: false } });
    render(<Shelf source={s} ready={Promise.resolve()} onOpen={() => {}} onPick={() => {}} />);
    await screen.findByText('Gone');
    const img = cardOf('Gone').querySelector('img')!;
    expect(img.closest('.shelf-card')!.classList.contains('is-missing')).toBe(true);
  });

  it('a card that wants its thumbnail asks for it once; the others do not', async () => {
    const { s, change } = source({ b: { src: null, wantsThumb: true } });
    render(<Shelf source={s} ready={Promise.resolve()} onOpen={() => {}} onPick={() => {}} />);
    await screen.findByText('Deep Work');
    await waitFor(() => expect(s.requestCover).toHaveBeenCalledWith('b'));
    change();
    await act(() => new Promise((r) => setTimeout(r, 350)));
    expect(vi.mocked(s.requestCover!).mock.calls).toEqual([['b']]);
  });

  it('an image that fails to load falls back to the colour tile and asks for the thumbnail again', async () => {
    const { s } = source({ a: { src: 'app://local/a.webp?1', wantsThumb: false } });
    render(<Shelf source={s} ready={Promise.resolve()} onOpen={() => {}} onPick={() => {}} />);
    await screen.findByText('Walden');
    fireEvent.error(cardOf('Walden').querySelector('img')!);
    expect(cardOf('Walden').querySelector('img')).toBeNull();
    expect(cardOf('Walden').querySelector('.shelf-cover')!.classList.contains('has-image')).toBe(false);
    expect(s.requestCover).toHaveBeenCalledWith('a');
  });

  it('the "Cover options" button opens the menu under itself; a right-click on the card opens it at the pointer', async () => {
    const { s } = source({});
    const onOpen = vi.fn();
    render(<Shelf source={s} ready={Promise.resolve()} onOpen={onOpen} onPick={() => {}} />);
    await screen.findByText('Walden');
    const more = cardOf('Walden').querySelector('.shelf-card-more') as HTMLButtonElement;
    expect(more.getAttribute('aria-label')).toBe('Cover options');
    expect(more.getAttribute('aria-haspopup')).toBe('menu');
    expect(document.getElementById(more.getAttribute('aria-describedby')!)!.textContent).toBe('Walden');
    fireEvent.click(more);
    expect(s.coverMenu).toHaveBeenCalledWith('a', 'Walden', { x: expect.any(Number), y: expect.any(Number) }, more);
    expect(onOpen).not.toHaveBeenCalled();
    const card = screen.getByRole('button', { name: /^Deep Work/ });
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 6 });
    card.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(vi.mocked(s.coverMenu!).mock.calls[1][0]).toBe('b');
    expect(vi.mocked(s.coverMenu!).mock.calls[1][2]).toBeInstanceOf(MouseEvent);
    expect(vi.mocked(s.coverMenu!).mock.calls[1][3]).toBe(card);
    // A missing book's cover can be chosen too.
    fireEvent.contextMenu(screen.getByRole('group', { name: /^Gone/ }));
    expect(vi.mocked(s.coverMenu!).mock.calls[2][0]).toBe('c');
  });

  it('without cover support in the source: tiles, no menu button, the browser menu stays', async () => {
    const { s } = source({});
    delete s.cover;
    delete s.coverMenu;
    render(<Shelf source={s} ready={Promise.resolve()} onOpen={() => {}} onPick={() => {}} />);
    await screen.findByText('Walden');
    expect(document.querySelector('.shelf-card-more')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    screen.getByRole('button', { name: /^Walden/ }).dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});

// ---- through the plugin ----

let app: App;
let plugin: MarginPlugin | null = null;
let undoCanvas: () => void = () => {};

afterEach(async () => {
  if (plugin) {
    plugin.unload();
    await plugin.unloading;
    await app.workspace.viewsClosing;
  }
  plugin = null;
  undoCanvas();
  undoCanvas = () => {};
  __setPdfJs({ fake: 'pdfjs' });
  setBackend(null);
  bodySaves.resetBodySavesForTests();
  vi.unstubAllGlobals();
});

/** A pdf.js stand-in whose page 1 draws (600×800); counts documents destroyed. */
function drawablePdf() {
  const log = { opened: 0, destroyed: 0 };
  const lib = {
    getDocument: () => {
      log.opened++;
      return {
        promise: Promise.resolve({
          getPage: async () => ({
            getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
            render: () => ({ promise: Promise.resolve() }),
            cleanup: () => {},
          }),
        }),
        destroy: async () => void log.destroyed++,
      };
    },
  };
  return { lib, log };
}

async function setup(index: IndexFile['entries'] = {}, opts: { files?: Record<string, string> } = {}) {
  app = makeApp();
  const a = app.vault.adapter;
  for (const f of [`${ROOT}/books`, `${ROOT}/backups`]) a.folders.add(f);
  for (const [path, e] of Object.entries(index)) {
    a.files.set(`${ROOT}/books/${e.bookId}.json`, JSON.stringify({
      version: 1,
      book: { id: e.bookId, contentHash: e.fingerprint, path, format: 'pdf', title: e.summary?.title ?? null, author: null, lastLocation: null, addedAt: OLD, openedAt: null, zoom: null, progress: null },
      annotations: [],
      thoughts: [],
    }));
    if (!e.missing) app.vault.addBinary(path, pdfBytes(path));
  }
  if (Object.keys(index).length) a.files.set(`${ROOT}/index.json`, JSON.stringify({ version: 1, entries: index }));
  for (const [path, text] of Object.entries(opts.files ?? {})) {
    a.folders.add(path.slice(0, path.lastIndexOf('/')));
    a.files.set(path, text);
  }
  plugin = new MarginPlugin(app, manifest);
  plugin.savedData = {};
  plugin.coverDelayMs = 5;
  await plugin.onload();
  await plugin.ready;
  return plugin;
}

describe('covers in the plugin', () => {
  it('opening a book makes its first-page thumbnail in the background; the shelf then shows it', async () => {
    undoCanvas = __installCanvas();
    const pdf = drawablePdf();
    __setPdfJs(pdf.lib);
    const p = await setup();
    const file = app.vault.addBinary('Books/Walden.pdf', pdfBytes('walden'));
    const book = await p.host.openBook(file, pdfBytes('walden'));
    await p.covers.idle();
    const thumb = `${ROOT}/covers/${book.id}.webp`;
    expect(app.vault.adapter.files.has(thumb)).toBe(true);
    expect(p.store.entryOf(book.id)?.thumb).toBe(book.contentHash);
    expect(pdf.log.destroyed).toBe(pdf.log.opened);
    await p.openShelf();
    const title = await screen.findByText('Walden');
    await waitFor(() => expect(title.closest('.shelf-card')!.querySelector('img')?.getAttribute('src')).toContain(`/covers/${book.id}.webp`));
    // Opening it again: the thumbnail is current, nothing is drawn.
    await p.host.openBook(file, pdfBytes('walden'));
    await p.covers.idle();
    expect(pdf.log.opened).toBe(1);
  });

  it('the shelf asks for a missing thumbnail itself, and a book whose page 1 will not draw keeps its tile', async () => {
    undoCanvas = __installCanvas();
    const pdf = drawablePdf();
    __setPdfJs(pdf.lib);
    const p = await setup({
      'Books/a.pdf': { bookId: 'a', fingerprint: '1:a', missing: false, summary: summary({ title: 'Alpha' }) },
      'Books/b.pdf': { bookId: 'b', fingerprint: '1:b', missing: false, summary: summary({ title: 'Beta' }) },
    });
    app.vault.adapter.failOn('readBinary', 'Books/b.pdf');
    await p.openShelf();
    await screen.findByText('Alpha');
    await waitFor(() => expect(app.vault.adapter.files.has(`${ROOT}/covers/a.webp`)).toBe(true));
    await p.covers.idle();
    await waitFor(() => expect(screen.getByText('Alpha').closest('.shelf-card')!.querySelector('img')).not.toBeNull());
    expect(screen.getByText('Beta').closest('.shelf-card')!.querySelector('img')).toBeNull();
    expect(app.vault.adapter.files.has(`${ROOT}/covers/b.webp`)).toBe(false);
  });

  it('a thumbnail file that went missing: the tile shows, it is drawn again, and the card shows the new one', async () => {
    undoCanvas = __installCanvas();
    const pdf = drawablePdf();
    __setPdfJs(pdf.lib);
    // The index says the thumbnail is current, but the file is gone (a cleared folder, a sync).
    const p = await setup({ 'Books/a.pdf': { bookId: 'a', fingerprint: '1:a', missing: false, thumb: '1:a', summary: summary({ title: 'Alpha' }) } });
    await p.openShelf();
    const img = () => screen.getByText('Alpha').closest('.shelf-card')!.querySelector('img');
    await waitFor(() => expect(img()).not.toBeNull());
    const first = img()!.getAttribute('src');
    fireEvent.error(img()!);
    expect(img()).toBeNull();
    await waitFor(() => expect(app.vault.adapter.files.has(`${ROOT}/covers/a.webp`)).toBe(true));
    // Same fingerprint, so the index does not change: the cover's own change brings the image back, under a new URL.
    await waitFor(() => expect(img()).not.toBeNull());
    expect(img()!.getAttribute('src')).not.toBe(first);
    expect(pdf.log.opened).toBe(1);
  });

  it('the load sweep removes covers of books the index does not have', async () => {
    const p = await setup(
      { 'Books/a.pdf': { bookId: 'a', fingerprint: '1:a', missing: false, thumb: '1:a' } },
      { files: { [`${ROOT}/covers/a.webp`]: 'x', [`${ROOT}/covers/zzz.webp`]: 'x', [`${ROOT}/covers/zzz-custom.png`]: 'x' } },
    );
    await waitFor(() => expect(app.vault.adapter.files.has(`${ROOT}/covers/zzz.webp`)).toBe(false));
    expect(app.vault.adapter.files.has(`${ROOT}/covers/zzz-custom.png`)).toBe(false);
    expect(app.vault.adapter.files.has(`${ROOT}/covers/a.webp`)).toBe(true);
    expect(p.store.entryOf('a')?.thumb).toBe('1:a');
  });

  it('the menu: choose a vault image (images only), follow its rename, fall back when it is deleted; tile; reset; checks', async () => {
    const p = await setup({ 'Books/a.pdf': { bookId: 'a', fingerprint: '1:a', missing: false, summary: summary({ title: 'Alpha' }) } });
    const png = app.vault.addBinary('Art/cover.png', new ArrayBuffer(3));
    app.vault.addBinary('Art/photo.JPG', new ArrayBuffer(3));
    app.vault.addBinary('Art/notes.md', new ArrayBuffer(3));
    app.vault.addBinary('Art/doc.pdf', new ArrayBuffer(3));
    await p.openShelf();
    const more = (await screen.findByText('Alpha')).closest('.shelf-card-wrap')!.querySelector('.shelf-card-more') as HTMLElement;

    fireEvent.click(more);
    const menu = Menu.shown.at(-1)!;
    expect(menu.items.map((i) => i.title)).toEqual(['Choose cover from vault…', 'Paste image as cover', 'Use first page', 'Use colour tile', 'Reset to automatic']);
    expect(menu.items.map((i) => i.checked)).toEqual([null, null, false, false, true]);
    expect(menu.shownAt).toEqual({ x: expect.any(Number), y: expect.any(Number) });

    menu.item('Choose cover from vault…').handler!();
    const picker = Modal.opened.at(-1) as CoverImagePicker;
    expect(picker).toBeInstanceOf(CoverImagePicker);
    expect(picker.getItems().map((f) => picker.getItemText(f)).sort()).toEqual(['Art/cover.png', 'Art/photo.JPG']);
    picker.onChooseItem(png);
    await waitFor(() => expect(p.store.entryOf('a')?.cover).toEqual({ kind: 'vault', path: 'Art/cover.png' }));
    const img = () => screen.getByText('Alpha').closest('.shelf-card')!.querySelector('img');
    await waitFor(() => expect(img()?.getAttribute('src')).toBe('app://local/Art/cover.png?0'));

    await app.vault.rename(png, 'Pictures/front.png');
    await waitFor(() => expect(p.store.entryOf('a')?.cover).toEqual({ kind: 'vault', path: 'Pictures/front.png' }));
    await waitFor(() => expect(img()?.getAttribute('src')).toBe('app://local/Pictures/front.png?0'));
    await app.vault.delete(app.vault.getFileByPath('Pictures/front.png') as TFile);
    await waitFor(() => expect(p.store.entryOf('a')?.cover).toBeUndefined());
    await waitFor(() => expect(img()).toBeNull());

    fireEvent.contextMenu(screen.getByRole('button', { name: /^Alpha/ }));
    Menu.shown.at(-1)!.item('Use colour tile').handler!();
    await waitFor(() => expect(p.store.entryOf('a')?.cover).toEqual({ kind: 'tile' }));
    fireEvent.click(more);
    expect(Menu.shown.at(-1)!.items.map((i) => i.checked)).toEqual([null, null, false, true, false]);
    Menu.shown.at(-1)!.item('Use first page').handler!();
    await waitFor(() => expect(p.store.entryOf('a')?.cover).toEqual({ kind: 'page' }));
    fireEvent.click(more);
    Menu.shown.at(-1)!.item('Reset to automatic').handler!();
    await waitFor(() => expect(p.store.entryOf('a')?.cover).toBeUndefined());
    const onDisk = JSON.parse(app.vault.adapter.files.get(`${ROOT}/index.json`) as string) as IndexFile;
    expect('cover' in onDisk.entries['Books/a.pdf']).toBe(false);
  });

  it('paste: the clipboard image becomes covers/<id>-custom.<ext>; no image or a failure says so', async () => {
    const p = await setup({ 'Books/a.pdf': { bookId: 'a', fingerprint: '1:a', missing: false, summary: summary({ title: 'Alpha' }) } });
    const read = vi.fn(async () => [{ types: ['text/plain', 'image/jpeg'], getType: async (t: string) => new Blob(['JPEG'], { type: t }) }]);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { read } });
    await p.openShelf();
    const more = (await screen.findByText('Alpha')).closest('.shelf-card-wrap')!.querySelector('.shelf-card-more') as HTMLElement;
    fireEvent.click(more);
    await Menu.shown.at(-1)!.item('Paste image as cover').handler!();
    expect(new TextDecoder().decode(app.vault.adapter.files.get(`${ROOT}/covers/a-custom.jpg`) as ArrayBuffer)).toBe('JPEG');
    expect(p.store.entryOf('a')?.cover).toMatchObject({ kind: 'pasted', ext: 'jpg' });
    await waitFor(() => expect(screen.getByText('Alpha').closest('.shelf-card')!.querySelector('img')?.getAttribute('src')).toContain('/covers/a-custom.jpg'));

    read.mockResolvedValueOnce([{ types: ['text/plain'], getType: async (t: string) => new Blob(['x'], { type: t }) }]);
    fireEvent.click(more);
    await Menu.shown.at(-1)!.item('Paste image as cover').handler!();
    expect(Notice.messages.at(-1)).toBe('Margin found no image on the clipboard.');
    read.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(more);
    await Menu.shown.at(-1)!.item('Paste image as cover').handler!();
    expect(Notice.messages.at(-1)).toBe("Margin couldn't use the pasted image: denied");
    expect(p.store.entryOf('a')?.cover).toMatchObject({ kind: 'pasted', ext: 'jpg' });
  });

  it('keyboard: Enter on "⋯" opens the menu, and focus returns to it when the menu hides; the picker returns it too', async () => {
    const p = await setup({ 'Books/a.pdf': { bookId: 'a', fingerprint: '1:a', missing: false, summary: summary({ title: 'Alpha' }) } });
    app.vault.addBinary('Art/cover.png', new ArrayBuffer(3));
    await p.openShelf();
    const more = (await screen.findByText('Alpha')).closest('.shelf-card-wrap')!.querySelector('.shelf-card-more') as HTMLButtonElement;
    expect(more.tagName).toBe('BUTTON'); // a real button: Enter and Space activate it
    more.focus();
    expect(document.activeElement).toBe(more);
    const shown = Menu.shown.length;
    // A browser turns Enter on a focused button into a click.
    fireEvent.keyDown(more, { key: 'Enter' });
    fireEvent.click(more);
    expect(Menu.shown.length).toBe(shown + 1);
    const menu = Menu.shown.at(-1)!;
    (document.body.appendChild(document.createElement('input')) as HTMLInputElement).focus(); // the menu took focus
    menu.hide();
    expect(document.activeElement).toBe(more);

    fireEvent.click(more);
    const second = Menu.shown.at(-1)!;
    second.item('Choose cover from vault…').handler!();
    second.hide();
    (document.querySelector('input') as HTMLInputElement).focus(); // the picker took focus
    Modal.opened.at(-1)!.close();
    expect(document.activeElement).toBe(more);

    // A right-click on the card returns to the card.
    const card = screen.getByRole('button', { name: /^Alpha/ });
    fireEvent.contextMenu(card);
    (document.querySelector('input') as HTMLInputElement).focus();
    Menu.shown.at(-1)!.hide();
    expect(document.activeElement).toBe(card);
  });

  it('a menu opened with an event from another window (not an instance of this MouseEvent) still opens at the pointer', async () => {
    const p = await setup({ 'Books/a.pdf': { bookId: 'a', fingerprint: '1:a', missing: false, summary: summary({ title: 'Alpha' }) } });
    const foreign = { clientX: 4, clientY: 9, preventDefault() {} };
    const atMouse = vi.spyOn(Menu.prototype, 'showAtMouseEvent');
    const atPosition = vi.spyOn(Menu.prototype, 'showAtPosition');
    const menu = showCoverMenu(app, p.covers, null, { bookId: 'a', title: 'Alpha' }, foreign);
    expect(menu.shownAt).toBe(foreign);
    expect(atMouse).toHaveBeenCalledTimes(1);
    expect(atPosition).not.toHaveBeenCalled();
    atMouse.mockRestore();
    atPosition.mockRestore();
  });

  it('a cover write that fails never stops the book from following a rename', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = await setup({ 'Books/a.pdf': { bookId: 'a', fingerprint: '1:a', missing: false, summary: summary({ title: 'Alpha' }) } });
    vi.spyOn(p.store, 'followCoverMove').mockRejectedValue(new Error('index write failed'));
    await app.vault.rename(app.vault.getFileByPath('Books/a.pdf') as TFile, 'Books/b.pdf');
    await waitFor(() => expect(p.store.bookIdForPath('Books/b.pdf')).toBe('a'));
    expect(p.store.bookIdForPath('Books/a.pdf')).toBeNull();
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(Notice.messages.some((m) => m.includes("couldn't follow the move"))).toBe(false);
    warn.mockRestore();
  });

  it('a cover write that fails never stops a deleted book from being marked missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = await setup({ 'Books/a.pdf': { bookId: 'a', fingerprint: '1:a', missing: false, summary: summary({ title: 'Alpha' }) } });
    vi.spyOn(p.store, 'dropCoverPath').mockRejectedValue(new Error('index write failed'));
    await app.vault.delete(app.vault.getFileByPath('Books/a.pdf') as TFile);
    await waitFor(() => expect(p.store.entryOf('a')?.missing).toBe(true));
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(Notice.messages.some((m) => m.includes("couldn't mark"))).toBe(false);
    warn.mockRestore();
  });

  it('unloading stops cover jobs: nothing is drawn after it', async () => {
    undoCanvas = __installCanvas();
    const pdf = drawablePdf();
    __setPdfJs(pdf.lib);
    const p = await setup();
    p.coverDelayMs = 5;
    const file = app.vault.addBinary('Books/Walden.pdf', pdfBytes('walden'));
    await p.host.openBook(file, pdfBytes('walden'));
    p.unload();
    await p.unloading;
    await new Promise((r) => setTimeout(r, 30));
    expect(pdf.log.opened).toBe(0);
    plugin = null;
    await app.workspace.viewsClosing;
  });
});
