import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderers/pdf/PdfRenderer', async () => ({ PdfRenderer: (await import('./fakeRenderer')).FakePdfRenderer }));
vi.mock('../../src/renderers/epub/EpubRenderer', async () => ({ EpubRenderer: (await import('./fakeRenderer')).FakeEpubRenderer }));

import type { App, TFile, WorkspaceLeaf } from 'obsidian';
import * as bodySaves from '../../src/features/notebook/bodySaves';
import { register } from '../../src/features/notebook/editorRegistry';
import { setBackend } from '../../src/lib/backend';
import { pdfLocation, serializeLocation } from '../../src/lib/location';
import { VaultBackend } from '../src/backend/vaultBackend';
import { BookStore } from '../src/store/bookStore';
import { fingerprint } from '../src/store/hash';
import { MarginView, VIEW_TYPE, type MarginHost } from '../src/view/MarginView';
import { fake } from './fakeRenderer';
import { makeApp, pdfBytes, ROOT, tick } from './helpers';
import { Menu, Notice } from 'obsidian';
import { epubPoint } from '../../src/lib/location';
import { makeEpub } from '../../src/renderers/epub/testEpub';
import { OPEN_IN_OBSIDIAN } from '../src/view/MarginView';

let app: App;
let store: BookStore;
let host: MarginHost & { closed: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  app = makeApp();
  app.vault.addBinary('Books/Walden.pdf', pdfBytes('walden'));
  app.vault.addBinary('Books/Other.pdf', pdfBytes('other'));
  store = new BookStore(app.vault.adapter, ROOT, { coalesceMs: 0 });
  await store.load();
  setBackend(new VaultBackend(store, { readBytes: (p) => app.vault.adapter.readBinary(p), confirm: async () => true }));
  host = {
    openBook: async (f: TFile, bytes: ArrayBuffer) => (await store.openPath(f.path, await fingerprint(bytes), f.basename)).book,
    book: (id: string) => store.peek(id)?.book ?? null,
    closed: vi.fn(async (id: string) => store.flush(id)),
  };
  app.workspace.viewCreators.set(VIEW_TYPE, (leaf) => new MarginView(leaf, host));
  fake.goTo.mockClear();
});

afterEach(() => {
  setBackend(null);
  bodySaves.resetBodySavesForTests();
  document.body.replaceChildren();
});

async function open(state: Record<string, unknown> = { file: 'Books/Walden.pdf' }): Promise<{ leaf: WorkspaceLeaf; view: MarginView }> {
  const leaf = app.workspace.getLeaf(true);
  await leaf.setViewState({ type: VIEW_TYPE, state, active: true });
  return { leaf, view: leaf.view as MarginView };
}

describe('MarginView', () => {
  it('mounts the reader for its file inside div.margin-app, without a Library button', async () => {
    const { view } = await open();
    expect(view.contentEl.querySelector(':scope > .margin-app')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Walden' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Library' })).toBeNull();
    expect(store.bookIdForPath('Books/Walden.pdf')).not.toBeNull();
    expect(view.getViewType()).toBe('margin-reader');
    expect(view.getDisplayText()).toBe('Walden');
    expect(view.getIcon()).toBe('book-open');
  });

  it('closing saves unsent editor text first, then unmounts and tells the host', async () => {
    const { leaf, view } = await open();
    await screen.findByRole('heading', { name: 'Walden' });
    const id = store.bookIdForPath('Books/Walden.pdf');
    const order: string[] = [];
    const unregister = register(async () => void order.push('flush'));
    host.closed.mockImplementation(async () => void order.push('closed'));
    await leaf.detach();
    unregister();
    expect(order).toEqual(['flush', 'closed']);
    expect(host.closed).toHaveBeenCalledWith(id);
    expect(view.contentEl.querySelector('.margin-app')).toBeNull();
  });

  it('a loc in the view state jumps there once the book is open', async () => {
    const loc = pdfLocation({ page: 2, start: 0, end: 0 });
    await open({ file: 'Books/Walden.pdf', loc: serializeLocation(loc) });
    await waitFor(() => expect(fake.goTo).toHaveBeenCalledWith(loc, expect.objectContaining({ flash: true })));
  });

  it('navigate() on an open view jumps again', async () => {
    const { view } = await open();
    await screen.findByRole('heading', { name: 'Walden' });
    const loc = pdfLocation({ page: 3, start: 0, end: 0 });
    act(() => view.navigate(loc));
    await waitFor(() => expect(fake.goTo).toHaveBeenCalledWith(loc, expect.objectContaining({ flash: true })));
  });

  it('getState carries the file and no loc, even when a location is stored', async () => {
    const { view } = await open();
    const id = store.bookIdForPath('Books/Walden.pdf')!;
    const loc = serializeLocation(pdfLocation({ page: 2, start: 0, end: 0 }));
    await store.mutate(id, (f) => void (f.book.lastLocation = loc));
    const state = view.getState();
    expect(state).toEqual({ file: 'Books/Walden.pdf' });
    expect('loc' in state).toBe(false);
  });

  it('a view restored from a state saved before the position moved on does not move the reader', async () => {
    const f = app.vault.getFileByPath('Books/Walden.pdf')!;
    const id = (await host.openBook(f, pdfBytes('walden'))).id;
    const older = pdfLocation({ page: 1, start: 0, end: 0 });
    const stored = serializeLocation(pdfLocation({ page: 3, start: 0, end: 0 }));
    // workspace.json is written while the book is at page 1 ...
    await store.mutate(id, (b) => void (b.book.lastLocation = serializeLocation(older)));
    const first = await open();
    await screen.findByRole('heading', { name: 'Walden' });
    const saved = first.view.getState();
    // ... the reader then reaches page 3, and the app restarts with the saved state.
    await store.mutate(id, (b) => void (b.book.lastLocation = stored));
    await first.leaf.detach();
    fake.goTo.mockClear();
    await open(saved);
    await screen.findByRole('heading', { name: 'Walden' });
    await tick();
    expect(fake.goTo).not.toHaveBeenCalledWith(older, expect.anything());
    expect(store.peek(id)!.book.lastLocation).toBe(stored);
  });

  it('a file that cannot be read shows why instead of the reader', async () => {
    app.vault.adapter.failOn('readBinary', 'Books/Walden.pdf');
    const { view } = await open();
    await waitFor(() => expect(view.contentEl.textContent).toContain("Readside couldn't open Books/Walden.pdf"));
  });

  it('refreshBook shows the book’s new title after a rename', async () => {
    const { view } = await open();
    await screen.findByRole('heading', { name: 'Walden' });
    await store.renamePath('Books/Walden.pdf', 'Books/Walden Pond.pdf');
    act(() => view.refreshBook());
    expect(await screen.findByRole('heading', { name: 'Walden Pond' })).toBeTruthy();
  });

  it('a book stored with its raw file name shows it readable, in the header and the (screen-reader) heading, not in the toolbar', async () => {
    app.vault.addBinary('Books/Deep_Work_by_Cal_Newport.pdf', pdfBytes('deep'));
    const { view } = await open({ file: 'Books/Deep_Work_by_Cal_Newport.pdf' });
    const heading = await screen.findByRole('heading', { name: 'Deep Work by Cal Newport' });
    expect(heading.className).toBe('visually-hidden');
    expect(view.contentEl.querySelector('.reader-title')).toBeNull();
    const id = store.bookIdForPath('Books/Deep_Work_by_Cal_Newport.pdf')!;
    expect(store.peek(id)!.book.title).toBe('Deep_Work_by_Cal_Newport');
    expect(view.getDisplayText()).toBe('Deep Work by Cal Newport');
  });

  it('a title of the book’s own wins in the header, as it is', async () => {
    const { view } = await open();
    await screen.findByRole('heading', { name: 'Walden' });
    const id = store.bookIdForPath('Books/Walden.pdf')!;
    await store.mutate(id, (f) => void (f.book.title = 'Walden_; or, Life'));
    act(() => view.refreshBook());
    expect(view.getDisplayText()).toBe('Walden_; or, Life');
    expect(await screen.findByRole('heading', { name: 'Walden_; or, Life' })).toBeTruthy();
  });

  it('a restored view whose loc is the book’s own last location does not jump', async () => {
    const loc = serializeLocation(pdfLocation({ page: 2, start: 0, end: 0 }));
    const f = app.vault.getFileByPath('Books/Walden.pdf')!;
    const id = (await host.openBook(f, pdfBytes('walden'))).id;
    await store.mutate(id, (b) => void (b.book.lastLocation = loc));
    await open({ file: 'Books/Walden.pdf', loc });
    await screen.findByRole('heading', { name: 'Walden' });
    await tick();
    expect(fake.goTo).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ flash: true }));
  });

  /** host.openBook waits for `release()` on the given path; `started` resolves once it is waiting. */
  function gateOpen(path: string) {
    const openBook = host.openBook;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const waiting = new Promise<void>((r) => (started = r));
    host.openBook = async (f, bytes) => {
      if (f.path === path) {
        started();
        await gate;
      }
      return openBook(f, bytes);
    };
    return { release, waiting };
  }

  it('closed while its book is still opening: no reader is left, and the host gets the book back', async () => {
    const gate = gateOpen('Books/Walden.pdf');
    const leaf = app.workspace.getLeaf(true);
    const opening = leaf.setViewState({ type: VIEW_TYPE, state: { file: 'Books/Walden.pdf' }, active: true });
    await gate.waiting;
    const view = leaf.view as MarginView;
    expect(view).toBeInstanceOf(MarginView);
    await leaf.detach();
    gate.release();
    await opening;
    await waitFor(() => expect(host.closed).toHaveBeenCalledTimes(1));
    expect(host.closed).toHaveBeenCalledWith(store.bookIdForPath('Books/Walden.pdf'));
    expect((view as unknown as { root: unknown }).root).toBeNull();
    expect(view.contentEl.querySelector('.margin-app')).toBeNull();
    expect(document.querySelector('.margin-app')).toBeNull();
  });

  it('switched to another file while the first is still opening: the second mounts, the first is handed back', async () => {
    const gate = gateOpen('Books/Walden.pdf');
    const leaf = app.workspace.getLeaf(true);
    const opening = leaf.setViewState({ type: VIEW_TYPE, state: { file: 'Books/Walden.pdf' }, active: true });
    await gate.waiting;
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: 'Books/Other.pdf' }, active: true });
    gate.release();
    await opening;
    expect(await screen.findByRole('heading', { name: 'Other' })).toBeTruthy();
    const walden = store.bookIdForPath('Books/Walden.pdf');
    await waitFor(() => expect(host.closed).toHaveBeenCalledWith(walden));
    expect(host.closed).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.margin-app')).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Walden' })).toBeNull();
  });

  it('switching files in the same leaf leaves exactly one live reader and hands the first book back once', async () => {
    const { leaf } = await open();
    await screen.findByRole('heading', { name: 'Walden' });
    const walden = store.bookIdForPath('Books/Walden.pdf');
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: 'Books/Other.pdf' }, active: true });
    expect(await screen.findByRole('heading', { name: 'Other' })).toBeTruthy();
    expect(host.closed).toHaveBeenCalledTimes(1);
    expect(host.closed).toHaveBeenCalledWith(walden);
    expect(document.querySelectorAll('.margin-app')).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Walden' })).toBeNull();
  });

  it('release() tears down synchronously: the reader writes its pending position against the backend still installed', async () => {
    const { view } = await open();
    await screen.findByRole('heading', { name: 'Walden' });
    const id = store.bookIdForPath('Books/Walden.pdf')!;
    const loc = pdfLocation({ page: 3, start: 0, end: 0 });
    act(() => fake.emitLocation(loc));
    view.release();
    // Uninstalled right after: anything sent later would reach the stub.
    setBackend(null);
    expect(view.contentEl.querySelector('.margin-app')).toBeNull();
    expect(store.peek(id)?.book.lastLocation).toBe(serializeLocation(loc));
    await waitFor(() => expect(host.closed).toHaveBeenCalledWith(id));
    await store.flush();
    expect(JSON.parse(app.vault.adapter.files.get(`${ROOT}/books/${id}.json`) as string).book.lastLocation).toBe(serializeLocation(loc));
    // Obsidian's later close finds nothing to do.
    await view.onClose();
    expect(host.closed).toHaveBeenCalledTimes(1);
  });

  it('release() during an unmount waiting on its flush finishes it at once', async () => {
    const { view } = await open();
    await screen.findByRole('heading', { name: 'Walden' });
    const id = store.bookIdForPath('Books/Walden.pdf')!;
    let done!: () => void;
    const unregister = register(() => new Promise<void>((r) => (done = r)));
    const closing = view.onClose();
    await tick();
    expect(host.closed).not.toHaveBeenCalled();
    view.release();
    expect(view.contentEl.querySelector('.margin-app')).toBeNull();
    expect(host.closed).toHaveBeenCalledWith(id);
    done();
    unregister();
    await closing;
    expect(host.closed).toHaveBeenCalledTimes(1);
  });

  it('two unmounts waiting on their flushes at once both finish: no reader is left, both books are handed back', async () => {
    const { view } = await open();
    await screen.findByRole('heading', { name: 'Walden' });
    const walden = view.file!;
    const other = app.vault.getFileByPath('Books/Other.pdf')!;
    let done!: () => void;
    const slow = new Promise<void>((r) => (done = r));
    const unregister = register(() => slow);
    // Walden's unmount waits on the flush while Other loads into the same view, then the view closes.
    const first = view.onUnloadFile(walden);
    view.file = other;
    await view.onLoadFile(other);
    expect(await screen.findByRole('heading', { name: 'Other' })).toBeTruthy();
    const second = view.onClose();
    done();
    unregister();
    await Promise.all([first, second]);
    expect(host.closed.mock.calls.map((c) => c[0]).sort()).toEqual(
      [store.bookIdForPath('Books/Walden.pdf'), store.bookIdForPath('Books/Other.pdf')].sort(),
    );
    expect(document.querySelectorAll('.margin-app')).toHaveLength(0);
  });

  it('closing: the teardown runs once; FileView.onClose then unloads the file, and that onUnloadFile flushes and closes nothing again', async () => {
    const { leaf, view } = await open();
    await screen.findByRole('heading', { name: 'Walden' });
    const flusher = vi.fn(async () => {});
    const unregister = register(flusher);
    const unloadFile = vi.spyOn(view, 'onUnloadFile');
    await leaf.detach();
    unregister();
    expect(unloadFile).toHaveBeenCalledTimes(1);
    expect(unloadFile).toHaveBeenCalledWith(app.vault.getFileByPath('Books/Walden.pdf'));
    expect(flusher).toHaveBeenCalledTimes(1);
    expect(host.closed).toHaveBeenCalledTimes(1);
    expect(view.file).toBeNull();
    // Called again (Obsidian never does, but nothing may run twice).
    await view.onClose();
    expect(flusher).toHaveBeenCalledTimes(1);
    expect(host.closed).toHaveBeenCalledTimes(1);
  });

  it('release() while a close is in flight joins it: one teardown, and release resolves once host.closed has finished', async () => {
    const started: MarginView[] = [];
    const ended: MarginView[] = [];
    host.viewStarted = (v) => void started.push(v);
    host.viewEnded = (v) => void ended.push(v);
    const { leaf, view } = await open();
    await screen.findByRole('heading', { name: 'Walden' });
    expect(started).toEqual([view]);
    const id = store.bookIdForPath('Books/Walden.pdf')!;
    let finishClosed!: () => void;
    host.closed.mockImplementation(() => new Promise<void>((r) => (finishClosed = r)));
    let finishFlush!: () => void;
    const unregister = register(() => new Promise<void>((r) => (finishFlush = r)));
    const closing = leaf.detach(); // onClose starts; its unmount waits on the flush
    let released = false;
    const releasing = view.release().then(() => (released = true));
    expect(host.closed).toHaveBeenCalledTimes(1);
    expect(host.closed).toHaveBeenCalledWith(id);
    await tick();
    expect(released).toBe(false);
    expect(ended).toEqual([]);
    finishFlush();
    unregister();
    finishClosed();
    await releasing;
    await closing;
    expect(host.closed).toHaveBeenCalledTimes(1);
    expect(ended.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ended)).toEqual(new Set([view]));
  });
});

// ---- T7: the plugin's translate host reaches the reader ----
import { fireEvent } from '@testing-library/react';
import { FakeTranslateHost, OFFER } from '../../src/features/translate/testHost';

describe('MarginView: Translate (T7)', () => {
  const rect = { top: 10, bottom: 30, left: 10, right: 110, width: 100, height: 20, x: 10, y: 10, toJSON() {} } as DOMRect;
  const select = () => act(() => fake.emitSelection({ location: pdfLocation({ page: 1, start: 0, end: 4 }), quote: 'word', rect }));

  it('without a translate host (desktop-like) there is no Translate button', async () => {
    await open();
    await screen.findByRole('heading', { name: 'Walden' });
    select();
    expect(screen.getByRole('dialog', { name: 'Annotation actions' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Translate/ })).toBeNull();
  });

  it('with the plugin’s host the popover has Translate, and it translates through that host', async () => {
    const t = new FakeTranslateHost();
    host.translate = () => t;
    await open();
    await screen.findByRole('heading', { name: 'Walden' });
    select();
    fireEvent.click(screen.getByRole('button', { name: /^Translate/ }));
    expect(await screen.findByText('[en>uk] word')).toBeTruthy();
    expect(t.requests[0]).toMatchObject({ text: 'word' });
  });

  it('the host stays the same object across re-renders: a running download is not sent to the background', async () => {
    const t = new FakeTranslateHost();
    t.answer = () => ({ kind: 'needsDownload', offer: OFFER });
    const calls = vi.fn(() => t);
    host.translate = calls;
    const { view } = await open();
    await screen.findByRole('heading', { name: 'Walden' });
    select();
    fireEvent.click(screen.getByRole('button', { name: /^Translate/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Download/ }));
    await waitFor(() => expect(t.downloads).toHaveLength(1));
    const before = calls.mock.calls.length;
    act(() => view.refreshBook());
    act(() => view.refreshBook());
    expect(calls.mock.calls.length).toBeGreaterThan(before);
    expect(t.backgrounded).toEqual([]);
    expect(t.downloads[0].signal?.aborted).toBe(false);
    expect(screen.getByRole('progressbar', { name: 'Download progress' })).toBeTruthy();
  });
});

describe('MarginView: an EPUB (E7)', () => {
  const titles = (view: MarginView) => {
    const menu = new Menu();
    view.onPaneMenu(menu as never, 'more-options');
    return (menu as unknown as { items: { title: string }[] }).items.map((i) => i.title);
  };
  const addMoby = () =>
    app.vault.addBinary('Books/Moby.epub', makeEpub({ title: 'Moby-Dick', creator: 'Herman Melville', sections: [{ name: 'a.xhtml', html: '<p>Call me Ishmael.</p>' }] }));

  it('accepts .epub (any case) as well as .pdf, nothing else', async () => {
    const { view } = await open();
    expect(view.canAcceptExtension('epub')).toBe(true);
    expect(view.canAcceptExtension('EPUB')).toBe(true);
    expect(view.canAcceptExtension('pdf')).toBe(true);
    expect(view.canAcceptExtension('md')).toBe(false);
  });

  it('hands the host the OPF title and author with the bytes', async () => {
    addMoby();
    const openBook = vi.fn(host.openBook);
    host.openBook = openBook;
    await open({ file: 'Books/Moby.epub' });
    await waitFor(() => expect(openBook).toHaveBeenCalled());
    expect((openBook.mock.calls[0][2] as () => unknown)()).toEqual({ title: 'Moby-Dick', author: 'Herman Melville' });
  });

  it('the pane menu has no "Open in Obsidian\'s viewer" for an EPUB (it has for a PDF)', async () => {
    addMoby();
    const pdf = await open();
    await screen.findByRole('heading', { name: 'Walden' });
    expect(titles(pdf.view)).toContain(OPEN_IN_OBSIDIAN);
    const { view } = await open({ file: 'Books/Moby.epub' });
    await waitFor(() => expect(view.commands.current).not.toBeNull());
    expect(titles(view)).not.toContain(OPEN_IN_OBSIDIAN);
    expect(titles(view)).toContain('Open notebook note');
    const setViewState = vi.spyOn(view.leaf, 'setViewState');
    await view.openInObsidian();
    expect(setViewState).not.toHaveBeenCalled();
  });

  it('a failed EPUB open offers Try again but not Obsidian\'s viewer', async () => {
    addMoby();
    host.openBook = async () => Promise.reject(new Error('boom'));
    await open({ file: 'Books/Moby.epub' });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: OPEN_IN_OBSIDIAN })).toBeNull();
    expect(screen.queryByText(/use Obsidian's viewer/)).toBeNull();
  });

  it('copy link to this place: the Notice names the section (§ 3)', async () => {
    addMoby();
    host.copyLink = vi.fn(async () => {});
    const { view } = await open({ file: 'Books/Moby.epub' });
    await waitFor(() => expect(view.commands.current).not.toBeNull());
    view.location.current = epubPoint(3, 10, 0.2);
    await act(async () => view.copyPageLink());
    expect(Notice.messages.at(-1)).toBe('Readside: link to § 3 copied.');
  });
});

describe('MarginView: an EPUB’s pane menu says section (E7 fix round 1)', () => {
  it('"Copy link to this section" for an EPUB, "Copy link to this page" for a PDF', async () => {
    app.vault.addBinary('Books/Moby.epub', makeEpub({ title: 'Moby-Dick', sections: [{ name: 'a.xhtml', html: '<p>Call me Ishmael.</p>' }] }));
    host.copyLink = vi.fn(async () => {});
    const titles = (view: MarginView) => {
      const menu = new Menu();
      view.onPaneMenu(menu as never, 'more-options');
      return (menu as unknown as { items: { title: string }[] }).items.map((i) => i.title);
    };
    const pdf = await open();
    expect(titles(pdf.view)).toContain('Copy link to this page');
    const { view } = await open({ file: 'Books/Moby.epub' });
    await waitFor(() => expect(view.commands.current).not.toBeNull());
    expect(titles(view)).toContain('Copy link to this section');
    expect(titles(view)).not.toContain('Copy link to this page');
  });
});
