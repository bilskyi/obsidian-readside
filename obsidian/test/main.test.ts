import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderers/pdf/PdfRenderer', async () => ({ PdfRenderer: (await import('./fakeRenderer')).FakePdfRenderer }));
vi.mock('../../src/renderers/epub/EpubRenderer', async () => ({ EpubRenderer: (await import('./fakeRenderer')).FakeEpubRenderer }));

import { FileView, Menu, Modal, Notice, Tasks, __failPdfJs, type App, type TFile } from 'obsidian';
import * as bodySaves from '../../src/features/notebook/bodySaves';
import { register } from '../../src/features/notebook/editorRegistry';
import { backend, setBackend } from '../../src/lib/backend';
import { tauriBackend } from '../../src/lib/tauriBackend';
import { RETRY_BASE_MS } from '../../src/features/notebook/bodySaves';
import { pdfLocation, serializeLocation } from '../../src/lib/location';
import { pdfjs, pdfjsDocOptions } from '../../src/renderers/pdf/pdfjsProvider';
import { VaultBackend } from '../src/backend/vaultBackend';
import MarginPlugin, { UNLOADING_KEY } from '../src/main';
import { BookStore } from '../src/store/bookStore';
import { PdfPicker } from '../src/open';
import { recoveryMessage } from '../src/recoveryNotice';
import { fingerprint } from '../src/store/hash';
import { MarginView, VIEW_TYPE } from '../src/view/MarginView';
import { fake } from './fakeRenderer';
import { makeApp, manifest, pdfBytes, ROOT, tick } from './helpers';
import { epubLocation } from '../../src/lib/location';
import { makeEpub, xhtml } from '../../src/renderers/epub/testEpub';

/** Obsidian's own PDF viewer and Markdown view, as far as these tests need them. */
class PdfView extends FileView {
  /** What Obsidian's viewer was opened with beyond the file, e.g. `{ subpath: '#page=3' }`. */
  eState: Record<string, unknown> = {};
  getViewType() {
    return 'pdf';
  }
  getEphemeralState() {
    return this.eState;
  }
}
class MarkdownView extends FileView {
  getViewType() {
    return 'markdown';
  }
}

let app: App;
let plugin: MarginPlugin | null = null;
let walden: TFile;

/** `fallback`: Obsidian's view registry refuses the .pdf mapping, so "Open PDFs in Margin" works by taking over file-open. */
async function setup(settings: Record<string, unknown> = {}, opts: { fallback?: boolean } = {}) {
  app = makeApp();
  if (opts.fallback) refuseMapping(app);
  walden = app.vault.addBinary('Books/Walden.pdf', pdfBytes('walden'));
  app.vault.addBinary('Books/Other.pdf', pdfBytes('other'));
  await app.vault.createFolder('Notes');
  await app.vault.create('Notes/Reading.md', 'See [[Books/Walden.pdf]] today');
  app.workspace.viewCreators.set('pdf', (leaf) => new PdfView(leaf));
  app.workspace.viewCreators.set('markdown', (leaf) => new MarkdownView(leaf));
  plugin = new MarginPlugin(app, manifest);
  plugin.savedData = settings;
  await plugin.onload();
  await plugin.ready;
  return plugin;
}

function refuseMapping(a: App) {
  const reg = (a as unknown as { viewRegistry: { registerExtensions(e: string[], t: string): void } }).viewRegistry;
  const register = reg.registerExtensions.bind(reg);
  // Margin's claim is refused; Obsidian's viewer can still have .pdf back.
  reg.registerExtensions = (e, t) => {
    if (t === VIEW_TYPE) throw new Error('refused');
    register(e, t);
  };
}

async function openIn(type: string, path: string) {
  const leaf = app.workspace.getLeaf(true);
  await leaf.setViewState({ type, state: { file: path }, active: true });
  return leaf;
}

const marginLeaves = () => app.workspace.getLeavesOfType(VIEW_TYPE);

afterEach(async () => {
  if (plugin) {
    plugin.unload();
    await plugin.unloading;
    await app.workspace.viewsClosing;
  }
  plugin = null;
  fake.goTo.mockClear();
  setBackend(null);
  bodySaves.resetBodySavesForTests();
  document.body.replaceChildren();
});

describe('MarginPlugin', () => {
  it('installs the vault backend and Obsidian’s pdf.js on load', async () => {
    await setup();
    expect(backend()).toBeInstanceOf(VaultBackend);
    expect(pdfjs()).toEqual({ fake: 'pdfjs' });
  });

  it('opens PDFs with the options Obsidian’s own viewer uses (bundled fonts, cmaps, wasm; no eval)', async () => {
    await setup();
    expect(pdfjsDocOptions()).toEqual({
      cMapUrl: '/lib/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/lib/pdfjs/standard_fonts/',
      wasmUrl: '/lib/pdfjs/wasm/',
      iccUrl: '/lib/pdfjs/iccs/',
      isEvalSupported: false,
    });
  });

  it('"Open current PDF in Readside" is available for an active PDF only, and opens it', async () => {
    const p = await setup();
    const cmd = p.command('open-current-pdf');
    expect(cmd.checkCallback!(true)).toBe(false);
    await openIn('markdown', 'Notes/Reading.md');
    expect(cmd.checkCallback!(true)).toBe(false);
    await openIn('pdf', 'Books/Walden.pdf');
    expect(cmd.checkCallback!(true)).toBe(true);
    cmd.checkCallback!(false);
    await waitFor(() => expect(marginLeaves()).toHaveLength(1));
    expect((marginLeaves()[0].view as MarginView).file?.path).toBe('Books/Walden.pdf');
  });

  it('the file menu offers "Open in Readside" for PDFs only', async () => {
    await setup();
    const pdfMenu = new Menu();
    app.workspace.trigger('file-menu', pdfMenu, walden, 'file-explorer');
    expect(pdfMenu.items.map((i) => i.title)).toEqual(['Open in Readside']);
    const mdMenu = new Menu();
    app.workspace.trigger('file-menu', mdMenu, app.vault.getFileByPath('Notes/Reading.md'), 'file-explorer');
    expect(mdMenu.items).toHaveLength(0);
    pdfMenu.items[0].handler!();
    await waitFor(() => expect(marginLeaves()).toHaveLength(1));
  });

  it('the editor menu offers "Open in Readside" for a PDF link under the cursor', async () => {
    await setup();
    const line = 'See [[Books/Walden.pdf]] today';
    const on = new Menu();
    app.workspace.trigger('editor-menu', on, { getCursor: () => ({ line: 0, ch: 8 }), getLine: () => line }, { file: null });
    expect(on.items.map((i) => i.title)).toEqual(['Open in Readside']);
    const off = new Menu();
    app.workspace.trigger('editor-menu', off, { getCursor: () => ({ line: 0, ch: 1 }), getLine: () => line }, { file: null });
    expect(off.items).toHaveLength(0);
  });

  it('opening a PDF that is already open in Readside reveals that view instead of a second one', async () => {
    const p = await setup();
    await p.openInMargin(walden);
    const first = marginLeaves()[0];
    await openIn('pdf', 'Books/Other.pdf');
    await p.openInMargin(walden);
    expect(marginLeaves()).toEqual([first]);
    expect(app.workspace.activeLeaf).toBe(first);
  });

  it('by default a PDF opened in the built-in viewer stays there', async () => {
    await setup();
    const leaf = await openIn('pdf', 'Books/Walden.pdf');
    app.workspace.trigger('file-open', walden);
    await tick();
    expect(leaf.view.getViewType()).toBe('pdf');
  });

  it('with "Open PDFs in Readside" on and no registry mapping, a PDF opened in the built-in viewer switches to Readside', async () => {
    await setup({ openPdfsInMargin: true }, { fallback: true });
    const leaf = await openIn('pdf', 'Books/Walden.pdf');
    app.workspace.trigger('file-open', walden);
    await waitFor(() => expect(leaf.view.getViewType()).toBe(VIEW_TYPE));
  });

  it('renaming a PDF moves its book, and an open view shows the new name', async () => {
    const p = await setup();
    await p.openInMargin(walden);
    await screen.findByRole('heading', { name: 'Walden' });
    const id = p.store.bookIdForPath('Books/Walden.pdf');
    await app.fileManager.renameFile(walden, 'Books/Walden Pond.pdf');
    await waitFor(() => expect(p.store.bookIdForPath('Books/Walden Pond.pdf')).toBe(id));
    expect(await screen.findByRole('heading', { name: 'Walden Pond' })).toBeTruthy();
  });

  it('a new book takes its file name made readable as its title; the view header shows it and the toolbar does not', async () => {
    const p = await setup();
    const file = app.vault.addBinary('Books/The_Pragmatic__Programmer.pdf', pdfBytes('pragmatic'));
    await p.openInMargin(file);
    await screen.findByRole('heading', { name: 'The Pragmatic Programmer' });
    const id = p.store.bookIdForPath('Books/The_Pragmatic__Programmer.pdf')!;
    expect(p.store.peek(id)!.book.title).toBe('The Pragmatic Programmer');
    const view = marginLeaves()[0].view as MarginView;
    expect(view.getDisplayText()).toBe('The Pragmatic Programmer');
    expect(view.contentEl.querySelector('.reader-title')).toBeNull();
    // A readable title follows a rename, readable again.
    await app.fileManager.renameFile(file, 'Books/Pragmatic_Programmer_2e.pdf');
    await waitFor(() => expect(p.store.peek(id)!.book.title).toBe('Pragmatic Programmer 2e'));
  });

  it('deleting a PDF keeps its book, marked missing', async () => {
    const p = await setup();
    await p.openInMargin(walden);
    await screen.findByRole('heading', { name: 'Walden' });
    const id = p.store.bookIdForPath('Books/Walden.pdf')!;
    await app.vault.delete(walden);
    await waitFor(() => expect(p.store.entry('Books/Walden.pdf')?.missing).toBe(true));
    expect((await p.store.file(id)).book.id).toBe(id);
  });

  it('the shelf’s “Open a book…” opens a picker of vault books, recently opened first, from the index alone', async () => {
    const p = await setup();
    await p.openInMargin(walden);
    await screen.findByRole('heading', { name: 'Walden' });
    await p.openInMargin(app.vault.getFileByPath('Books/Other.pdf')!);
    await screen.findByRole('heading', { name: 'Other' });
    expect(p.store.entry('Books/Other.pdf')!.openedAt! > p.store.entry('Books/Walden.pdf')!.openedAt!).toBe(true);
    const listBooks = vi.spyOn(p.store, 'listBooks');
    const reads = vi.spyOn(app.vault.adapter, 'read');
    p.ribbonIcons[0].el.click();
    (await screen.findByRole('button', { name: 'Open a book…' })).click();
    await waitFor(() => expect(Modal.opened[0]).toBeInstanceOf(PdfPicker));
    expect((Modal.opened[0] as PdfPicker).getItems().map((f) => f.path)).toEqual(['Books/Other.pdf', 'Books/Walden.pdf']);
    expect(listBooks).not.toHaveBeenCalled();
    expect(reads).not.toHaveBeenCalled();
  });

  it('beforeunload saves unsent editor text, then writes the store', async () => {
    const p = await setup();
    const flushed = vi.fn(async () => {});
    const unregister = register(flushed);
    const storeFlush = vi.spyOn(p.store, 'flush');
    window.dispatchEvent(new Event('beforeunload'));
    expect(flushed).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(storeFlush).toHaveBeenCalled());
    expect(flushed.mock.invocationCallOrder[0]).toBeLessThan(storeFlush.mock.invocationCallOrder[0]);
    unregister();
  });

  it('quit adds a task that sends unsent editor text and writes the store before Obsidian closes', async () => {
    const p = await setup();
    await p.openInMargin(walden);
    await screen.findByRole('heading', { name: 'Walden' });
    const id = p.store.bookIdForPath('Books/Walden.pdf')!;
    const loc = pdfLocation({ page: 3, start: 0, end: 0 });
    // Something flushed sends a change and does not wait for it to be written.
    const unregister = register(() => void backend().setLastLocation(id, loc).catch(() => {}));
    const tasks = new Tasks();
    app.workspace.trigger('quit', tasks);
    expect(tasks.isEmpty()).toBe(false);
    await tasks.run();
    // Written now, not 50 ms later when the coalesced write would have gone.
    expect(JSON.parse(app.vault.adapter.files.get(`${ROOT}/books/${id}.json`) as string).book.lastLocation).toBe(serializeLocation(loc));
    unregister();
  });

  it('the quit task writes a reading position the reader has not saved yet', async () => {
    const p = await setup();
    await p.openInMargin(walden);
    await screen.findByRole('heading', { name: 'Walden' });
    const id = p.store.bookIdForPath('Books/Walden.pdf')!;
    // The reader saves the position a second after it settles: still pending when Obsidian quits.
    const loc = pdfLocation({ page: 2, start: 0, end: 0 });
    act(() => fake.emitLocation(loc));
    expect(p.store.peek(id)!.book.lastLocation).toBeNull();
    const tasks = new Tasks();
    app.workspace.trigger('quit', tasks);
    await tasks.run();
    expect(JSON.parse(app.vault.adapter.files.get(`${ROOT}/books/${id}.json`) as string).book.lastLocation).toBe(serializeLocation(loc));
    expect(p.views.size).toBe(0);
  });

  it('unload lands a failed thought body and the pending reading position, then uninstalls the backend', async () => {
    const p = await setup();
    await p.openInMargin(walden);
    await screen.findByRole('heading', { name: 'Walden' });
    const id = p.store.bookIdForPath('Books/Walden.pdf')!;
    const vault = backend();
    const t = await vault.createThought({ bookId: id });
    const bookFile = `${ROOT}/books/${id}.json`;
    app.vault.adapter.failOn('write', `${bookFile}.tmp`);
    await expect(bodySaves.saveBody(t.id, 'kept text')).rejects.toThrow('write failed');
    expect(bodySaves.failedCount()).toBe(1);
    // The reader moved to page 2; the position is saved a second later, so it is still pending.
    const loc = pdfLocation({ page: 2, start: 0, end: 0 });
    act(() => fake.emitLocation(loc));
    const backendAtWrite: unknown[] = [];
    const adapter = app.vault.adapter;
    const rename = adapter.rename.bind(adapter);
    adapter.rename = async (from: string, to: string) => {
      if (to === bookFile) backendAtWrite.push(backend());
      return rename(from, to);
    };
    const view = marginLeaves()[0].view as MarginView;
    p.unload();
    plugin = null;
    // Released synchronously; the backend is still the vault's until everything has landed.
    expect(view.contentEl.querySelector('.margin-app')).toBeNull();
    expect(backend()).toBe(vault);
    await p.unloading;
    expect(backend()).toBe(tauriBackend);
    const disk = JSON.parse(adapter.files.get(bookFile) as string);
    expect(disk.thoughts.find((x: { id: string }) => x.id === t.id).body).toBe('kept text');
    expect(disk.book.lastLocation).toBe(serializeLocation(loc));
    expect(backendAtWrite.length).toBeGreaterThan(0);
    expect(backendAtWrite.every((b) => b === vault)).toBe(true);
    expect(bodySaves.failedCount()).toBe(0);
    expect(Notice.messages).toEqual([]);
    // The store is closed: nothing can change in memory that would never be written.
    await expect(p.store.mutate(id, () => {})).rejects.toThrow('turned off');
    // Obsidian closes the leaves later; that finds nothing left to do.
    await app.workspace.viewsClosing;
    expect(marginLeaves()).toHaveLength(0);
  });

  it('a body that still cannot be saved on unload is named in a sticky Notice, and is not retried afterwards', async () => {
    const p = await setup();
    await p.openInMargin(walden);
    await screen.findByRole('heading', { name: 'Walden' });
    const id = p.store.bookIdForPath('Books/Walden.pdf')!;
    const t = await backend().createThought({ bookId: id });
    app.vault.adapter.failOn('write', `${ROOT}/books/${id}.json.tmp`, 2);
    await expect(bodySaves.saveBody(t.id, 'lost text')).rejects.toThrow('write failed');
    p.unload();
    plugin = null;
    await p.unloading;
    expect(Notice.messages).toEqual([
      "Readside couldn't save the text of 1 thought before it was turned off; that text is not in the vault.",
    ]);
    expect(Notice.durations).toEqual([0]);
    // The retry timer is gone: no save is attempted against the uninstalled backend.
    const sends = bodySaves.epochOf(t.id);
    await new Promise((r) => setTimeout(r, RETRY_BASE_MS + 200));
    expect(bodySaves.epochOf(t.id)).toBe(sends);
  }, 8000);

  it('a body save still in flight at unload that then fails is counted in the unload Notice', async () => {
    const p = await setup();
    // No view on this book: nothing but the unload tail's own store flush waits for its write.
    const id = (await p.store.openPath('Books/Walden.pdf', await fingerprint(pdfBytes('walden')), 'Walden')).book.id;
    const t = await backend().createThought({ bookId: id });
    await p.store.flush();
    // A slow disk: the book's next write takes a while, then fails.
    const adapter = app.vault.adapter;
    const write = adapter.write.bind(adapter);
    adapter.write = async (path: string, data: string) => {
      if (path !== `${ROOT}/books/${id}.json.tmp`) return write(path, data);
      await new Promise((r) => setTimeout(r, 150));
      throw new Error('write failed');
    };
    // Not failed yet when the unload starts: its write is still in flight.
    const save = bodySaves.saveBody(t.id, 'late text').catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 60));
    expect(bodySaves.failedCount()).toBe(0);
    p.unload();
    plugin = null;
    await p.unloading;
    expect(String(await save)).toContain('write failed');
    expect(Notice.messages).toEqual([
      "Readside couldn't save the text of 1 thought before it was turned off; that text is not in the vault.",
    ]);
  });

  it('a PDF with an upper-case extension is a PDF everywhere', async () => {
    const p = await setup();
    const scan = app.vault.addBinary('Books/Scan.PDF', pdfBytes('scan'));
    await openIn('pdf', 'Books/Scan.PDF');
    expect(p.command('open-current-pdf').checkCallback!(true)).toBe(true);
    const menu = new Menu();
    app.workspace.trigger('file-menu', menu, scan, 'file-explorer');
    expect(menu.items.map((i) => i.title)).toEqual(['Open in Readside']);
    const editorMenu = new Menu();
    const line = '[[Books/Scan.PDF]]';
    app.workspace.trigger('editor-menu', editorMenu, { getCursor: () => ({ line: 0, ch: 3 }), getLine: () => line }, { file: null });
    expect(editorMenu.items.map((i) => i.title)).toEqual(['Open in Readside']);
    await p.openInMargin(scan);
    expect((marginLeaves()[0].view as MarginView).canAcceptExtension('PDF')).toBe(true);
  });

  it('with "Open PDFs in Readside" on and no registry mapping, only the active PDF leaf switches; other leaves showing the file stay', async () => {
    await setup({ openPdfsInMargin: true }, { fallback: true });
    const other = await openIn('pdf', 'Books/Walden.pdf');
    const active = await openIn('pdf', 'Books/Walden.pdf');
    app.workspace.trigger('file-open', walden);
    await waitFor(() => expect(active.view.getViewType()).toBe(VIEW_TYPE));
    await tick();
    expect(other.view.getViewType()).toBe('pdf');
  });

  it('with "Open PDFs in Readside" on and no registry mapping, a PDF announced before its tab is active and loaded still switches', async () => {
    await setup({ openPdfsInMargin: true }, { fallback: true });
    const md = await openIn('markdown', 'Notes/Reading.md');
    expect(app.workspace.activeLeaf).toBe(md);
    const leaf = app.workspace.getLeaf(true);
    app.workspace.setActiveLeaf(md); // Obsidian activates the new leaf only after file-open
    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Walden.pdf' } });
    app.workspace.trigger('file-open', walden);
    await new Promise((r) => setTimeout(r, 20));
    expect(leaf.view.getViewType()).toBe('pdf');
    app.workspace.setActiveLeaf(leaf);
    await waitFor(() => expect(leaf.view.getViewType()).toBe(VIEW_TYPE), { timeout: 2000 });
    expect(md.view.getViewType()).toBe('markdown');
  });

  it('"Open PDFs in Readside" maps .pdf to Readside in Obsidian’s view registry, and hands it back when off or unloaded', async () => {
    const p = await setup({ openPdfsInMargin: true });
    const reg = (app as unknown as { viewRegistry: { getTypeByExtension(e: string): string | undefined } }).viewRegistry;
    expect(reg.getTypeByExtension('pdf')).toBe(VIEW_TYPE);
    p.settings.openPdfsInMargin = false;
    await p.saveSettings();
    expect(reg.getTypeByExtension('pdf')).toBe('pdf');
    p.settings.openPdfsInMargin = true;
    await p.saveSettings();
    expect(reg.getTypeByExtension('pdf')).toBe(VIEW_TYPE);
    p.unload();
    expect(reg.getTypeByExtension('pdf')).toBe('pdf');
  });

  it('off by default: .pdf stays with Obsidian’s viewer, and another plugin’s claim on .pdf is left alone', async () => {
    await setup();
    const reg = (app as unknown as { viewRegistry: { typeByExtension: Record<string, string>; getTypeByExtension(e: string): string | undefined } }).viewRegistry;
    expect(reg.getTypeByExtension('pdf')).toBe('pdf');
    reg.typeByExtension.pdf = 'someone-else';
    plugin!.settings.openPdfsInMargin = true;
    await plugin!.saveSettings();
    expect(reg.getTypeByExtension('pdf')).toBe('someone-else');
  });

  it('with "Open PDFs in Readside" on and no registry mapping, the page the viewer was opened at carries over', async () => {
    await setup({ openPdfsInMargin: true }, { fallback: true });
    const leaf = app.workspace.getLeaf(true);
    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Walden.pdf' }, active: true });
    (leaf.view as PdfView).eState = { subpath: '#page=3' };
    app.workspace.trigger('file-open', walden);
    const loc = pdfLocation({ page: 3, start: 0, end: 0 });
    await waitFor(() => expect(fake.goTo).toHaveBeenCalledWith(loc, expect.objectContaining({ flash: true })));
  });

  it('a pdf.js load failure is shown, and renames are still followed', async () => {
    __failPdfJs(new Error('no engine'));
    app = makeApp();
    walden = app.vault.addBinary('Books/Walden.pdf', pdfBytes('walden'));
    plugin = new MarginPlugin(app, manifest);
    await plugin.onload();
    await plugin.storeReady;
    await expect(plugin.pdfReady).rejects.toThrow('no engine');
    expect(Notice.messages).toEqual(["Readside couldn't load Obsidian's PDF engine, so it can't show PDFs: Error: no engine"]);
    const id = (await plugin.store.openPath('Books/Walden.pdf', await fingerprint(pdfBytes('walden')), 'Walden')).book.id;
    await app.fileManager.renameFile(walden, 'Books/Walden Pond.pdf');
    await waitFor(() => expect(plugin!.store.bookIdForPath('Books/Walden Pond.pdf')).toBe(id));
  });

  it('a PDF moved while Readside was off opens on its book, highlights and all', async () => {
    const p = await setup();
    const fp = await fingerprint(pdfBytes('walden'));
    const id = (await p.store.openPath('Books/Walden.pdf', fp, 'Walden')).book.id;
    await p.store.mutate(id, (f) => void f.annotations.push({ id: 'h1' } as never));
    p.unload();
    await p.unloading;
    // Moved with Margin off: no plugin hears the rename.
    await app.vault.rename(walden, 'Archive/Walden.pdf');
    plugin = new MarginPlugin(app, manifest);
    plugin.savedData = {};
    await plugin.onload();
    await plugin.ready;
    const back = await plugin.store.openPath('Archive/Walden.pdf', fp, 'Walden');
    expect(back.book.id).toBe(id);
    expect(back.annotations.map((a) => a.id)).toEqual(['h1']);
    // A copy, with the original still in the vault, is a book of its own.
    app.vault.addBinary('Archive/Walden copy.pdf', pdfBytes('walden'));
    expect((await plugin.store.openPath('Archive/Walden copy.pdf', fp, 'Walden copy')).book.id).not.toBe(id);
  });

  it('openInMargin reveals a deferred Readside tab of the same file instead of opening a duplicate', async () => {
    const p = await setup();
    const other = await openIn('markdown', 'Notes/Reading.md');
    const deferred = app.workspace.addDeferredLeaf(VIEW_TYPE, { file: 'Books/Walden.pdf' });
    const count = app.workspace.leaves.length;
    await p.openInMargin(walden);
    expect(app.workspace.leaves).toHaveLength(count);
    expect(app.workspace.activeLeaf).toBe(deferred);
    expect(deferred.view).toBeInstanceOf(MarginView);
    expect((deferred.view as MarginView).file?.path).toBe('Books/Walden.pdf');
    expect(other.view.getViewType()).toBe('markdown');
    expect(marginLeaves()).toHaveLength(1);
  });

  it('a link into a deferred Readside tab of the file jumps there, in that tab', async () => {
    const p = await setup();
    const deferred = app.workspace.addDeferredLeaf(VIEW_TYPE, { file: 'Books/Walden.pdf' });
    const loc = pdfLocation({ page: 3, start: 0, end: 0 });
    await p.openInMargin(walden, loc);
    expect(marginLeaves()).toEqual([deferred]);
    await waitFor(() => expect(fake.goTo).toHaveBeenCalledWith(loc, expect.objectContaining({ flash: true })));
  });

  it('a deferred Readside tab of another file is not reused', async () => {
    const p = await setup();
    const deferred = app.workspace.addDeferredLeaf(VIEW_TYPE, { file: 'Books/Other.pdf' });
    await p.openInMargin(walden);
    expect(app.workspace.activeLeaf).not.toBe(deferred);
    expect(deferred.isDeferred).toBe(true);
  });

  it('a store that cannot load is shown', async () => {
    app = makeApp();
    app.vault.adapter.failOn('list', `${ROOT}/books`);
    plugin = new MarginPlugin(app, manifest);
    await plugin.onload();
    await expect(plugin.storeReady).rejects.toThrow('list failed');
    await tick();
    expect(Notice.messages).toEqual(["Readside couldn't read its saved books: Error: list failed"]);
  });

  it('a rename or delete the store cannot follow is shown, not left unhandled', async () => {
    const p = await setup();
    vi.spyOn(p.store, 'renamePath').mockRejectedValueOnce(new Error('disk full'));
    vi.spyOn(p.store, 'markMissing').mockRejectedValueOnce(new Error('disk gone'));
    await app.fileManager.renameFile(walden, 'Books/Walden Pond.pdf');
    await waitFor(() => expect(Notice.messages).toHaveLength(1));
    expect(Notice.messages[0]).toBe(
      "Readside couldn't follow the move of Books/Walden.pdf to Books/Walden Pond.pdf; its book stays under the old path: Error: disk full",
    );
    await app.vault.delete(walden);
    await waitFor(() => expect(Notice.messages).toHaveLength(2));
    expect(Notice.messages[1]).toBe("Readside couldn't mark the books under Books/Walden Pond.pdf as missing: Error: disk gone");
  });
});

describe('MarginPlugin: turned off, or updated, while a book is open', () => {
  /** An editor with unsent text: its first flush is slow (it sends the text, then takes 30 ms); later ones return at once. */
  function slowEditor(thoughtId: string, text: string) {
    let calls = 0;
    return register(() => {
      if (calls++ > 0) return;
      const sent = bodySaves.saveBody(thoughtId, text);
      return Promise.all([sent, new Promise((r) => setTimeout(r, 30))]);
    });
  }

  it('turned off by the user: views close and leaves detach before onunload, yet the position and editor text land while VaultBackend is installed', async () => {
    const p = await setup();
    await p.openInMargin(walden);
    await screen.findByRole('heading', { name: 'Walden' });
    const id = p.store.bookIdForPath('Books/Walden.pdf')!;
    const vault = backend();
    const t = await vault.createThought({ bookId: id });
    const loc = pdfLocation({ page: 2, start: 0, end: 0 });
    act(() => fake.emitLocation(loc));
    const unregister = slowEditor(t.id, 'typed just now');
    const bookFile = `${ROOT}/books/${id}.json`;
    const backendAtWrite: unknown[] = [];
    const adapter = app.vault.adapter;
    const rename = adapter.rename.bind(adapter);
    adapter.rename = async (from: string, to: string) => {
      if (to === bookFile) backendAtWrite.push(backend());
      return rename(from, to);
    };
    const errors = vi.spyOn(console, 'error');
    let leavesAtOnunload = -1;
    const onunload = p.onunload.bind(p);
    p.onunload = () => {
      leavesAtOnunload = app.workspace.leaves.length;
      onunload();
    };
    expect(p.views.size).toBe(1);
    p._userDisabled = true;
    p.unload();
    plugin = null;
    expect(leavesAtOnunload).toBe(0);
    expect(document.querySelector('.margin-app')).toBeNull();
    expect(backend()).toBe(vault);
    await p.unloading;
    unregister();
    expect(backend()).toBe(tauriBackend);
    const disk = JSON.parse(adapter.files.get(bookFile) as string);
    expect(disk.book.lastLocation).toBe(serializeLocation(loc));
    expect(disk.thoughts.find((x: { id: string }) => x.id === t.id).body).toBe('typed just now');
    expect(backendAtWrite.length).toBeGreaterThan(0);
    expect(backendAtWrite.every((b) => b === vault)).toBe(true);
    expect(bodySaves.failedCount()).toBe(0);
    // Nothing was rejected: no save failed or reached the stub backend.
    expect(errors.mock.calls.filter((c) => /margin|no backend/i.test(c.map(String).join(' ')))).toEqual([]);
    expect(Notice.messages).toEqual([]);
    expect(p.views.size).toBe(0);
    await app.workspace.viewsClosing;
    errors.mockRestore();
  });

  it('an update (off, then at once on): the new instance loads its store only after the old one’s last write, and reopens the book as it was left', async () => {
    const p = await setup();
    await p.openInMargin(walden);
    await screen.findByRole('heading', { name: 'Walden' });
    const id = p.store.bookIdForPath('Books/Walden.pdf')!;
    const t = await backend().createThought({ bookId: id });
    const loc = pdfLocation({ page: 3, start: 0, end: 0 });
    act(() => fake.emitLocation(loc));
    const unregister = slowEditor(t.id, 'typed before the update');
    const leaf = marginLeaves()[0];
    const bookFile = `${ROOT}/books/${id}.json`;
    // Every write takes a few ms, so an unguarded new instance would start reading while the old one writes.
    const events: string[] = [];
    const adapter = app.vault.adapter;
    for (const op of ['write', 'remove', 'rename'] as const) {
      const orig = (adapter[op] as (...a: unknown[]) => Promise<void>).bind(adapter);
      (adapter as unknown as Record<string, unknown>)[op] = async (...args: unknown[]) => {
        await new Promise((r) => setTimeout(r, 3));
        await orig(...args);
        events.push(`${op} ${String(args[0])}`);
      };
    }
    const load = BookStore.prototype.load;
    const loadSpy = vi.spyOn(BookStore.prototype, 'load').mockImplementation(function (this: BookStore) {
      events.push('load');
      return load.call(this);
    });
    p.unload(); // not user-disabled: the leaves keep placeholders
    void p.unloading.then(() => events.push('old instance done'));
    expect((window as unknown as Record<string, unknown>)[UNLOADING_KEY]).toBe(p.unloading);
    const next = new MarginPlugin(app, manifest);
    next.savedData = {};
    plugin = next;
    const loading = next.onload(); // Obsidian enables the new instance at once
    await loading;
    await next.ready;
    loadSpy.mockRestore();
    const at = events.indexOf('load');
    expect(at).toBeGreaterThan(0);
    expect(events.indexOf('old instance done')).toBeLessThan(at);
    expect(events.slice(0, at)).toContain(`rename ${bookFile}.tmp`);
    expect(events.slice(at).filter((e) => e.endsWith(bookFile) || e.endsWith(`${bookFile}.tmp`))).toEqual([]);
    expect((window as unknown as Record<string, unknown>)[UNLOADING_KEY]).toBeUndefined();
    unregister();
    // The leaf reopens in the new instance, on the book as the old one left it.
    await app.workspace.viewsReopening;
    expect(leaf.view).toBeInstanceOf(MarginView);
    await screen.findByRole('heading', { name: 'Walden' });
    const disk = JSON.parse(adapter.files.get(bookFile) as string);
    expect(disk.book.lastLocation).toBe(serializeLocation(loc));
    expect(disk.thoughts.find((x: { id: string }) => x.id === t.id).body).toBe('typed before the update');
    expect(next.store.peek(id)!.book.lastLocation).toBe(serializeLocation(loc));
    expect(next.store.peek(id)!.thoughts.find((x) => x.id === t.id)!.body).toBe('typed before the update');
    expect(p.views.size).toBe(0);
    expect(next.views.size).toBe(1);
  });

  it('the new instance waits at most 5 s for an old tail that never finishes, and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      app = makeApp();
      (window as unknown as Record<string, unknown>)[UNLOADING_KEY] = new Promise(() => {});
      const p = new MarginPlugin(app, manifest);
      plugin = p;
      let loaded = false;
      const loading = p.onload().then(() => (loaded = true));
      await vi.advanceTimersByTimeAsync(4900);
      expect(loaded).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await loading;
      expect(loaded).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not finish unloading'));
    } finally {
      warn.mockRestore();
      delete (window as unknown as Record<string, unknown>)[UNLOADING_KEY];
      vi.useRealTimers();
    }
    await plugin!.ready;
  });
});

describe('MarginPlugin: what the store recovered on load', () => {
  it('shows a Notice naming the index file and each swept book', async () => {
    app = makeApp();
    const a = app.vault.adapter;
    a.folders.add(`${ROOT}/books`);
    const book = {
      id: 'id-w', contentHash: '', path: 'Books/Walden.pdf', format: 'pdf', title: 'Walden', author: null, lastLocation: null,
      addedAt: '2026-01-01T00:00:00.000Z', openedAt: null, zoom: null, progress: null,
    };
    a.files.set(`${ROOT}/books/id-w.json`, JSON.stringify({ version: 1, book, annotations: [], thoughts: [] }));
    a.files.set(`${ROOT}/index.json`, 'garbage{');
    plugin = new MarginPlugin(app, manifest);
    await plugin.onload();
    await plugin.ready;
    const kept = [...a.files.keys()].find((k) => k.startsWith(`${ROOT}/index.json.corrupt-`))!;
    // One Notice: the rebuilt index names the books it swept back.
    expect(Notice.messages).toEqual([recoveryMessage({ kind: 'index-rebuilt', keptAs: kept, books: [{ bookId: 'id-w', name: 'Walden' }] })]);
    expect(Notice.messages[0]).toContain(kept);
    expect(Notice.messages[0]).toContain('“Walden”');
    expect(Notice.durations).toEqual([0]);
  });

  it('a clean load shows no Notice', async () => {
    await setup();
    expect(Notice.messages).toEqual([]);
  });
});

describe('recoveryMessage', () => {
  it('names the book or the file in every kind', () => {
    expect(recoveryMessage({ kind: 'book-kept-aside', bookId: 'b', name: 'Walden', keptAs: 'x/b.json.corrupt-1' })).toBe(
      'Readside: the saved highlights and thoughts of “Walden” were damaged and there was no backup. The damaged copy is kept as x/b.json.corrupt-1.',
    );
    expect(recoveryMessage({ kind: 'backup-restored', bookId: 'b', name: 'Walden', keptAs: 'x/b.json.corrupt-1', backup: 'x/backups/b-2026-11-10.json' })).toBe(
      'Readside: the saved highlights and thoughts of “Walden” were damaged and have been restored from x/backups/b-2026-11-10.json; changes after that backup may be missing. The damaged copy is kept as x/b.json.corrupt-1.',
    );
    expect(recoveryMessage({ kind: 'index-rebuilt', keptAs: 'x/index.json.corrupt-1', books: [] })).toBe(
      "Readside's index of books was damaged and has been rebuilt from the book files. The damaged copy is kept as x/index.json.corrupt-1.",
    );
    expect(recoveryMessage({ kind: 'index-rebuilt', keptAs: 'x/i', books: [{ bookId: 'a', name: 'Walden' }] })).toBe(
      "Readside's index of books was damaged and has been rebuilt from the book files. The damaged copy is kept as x/i. 1 book came back with its highlights and thoughts: “Walden”. It reconnects when its PDF is opened in Readside.",
    );
    const seven = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name) => ({ bookId: name, name }));
    expect(recoveryMessage({ kind: 'index-rebuilt', keptAs: 'x/i', books: seven })).toBe(
      "Readside's index of books was damaged and has been rebuilt from the book files. The damaged copy is kept as x/i. 7 books came back with their highlights and thoughts: “A”, “B”, “C”, “D”, “E” and 2 more. Each reconnects when its PDF is opened in Readside.",
    );
    expect(recoveryMessage({ kind: 'orphans-swept', books: seven })).toContain('“E” and 2 more.');
    expect(recoveryMessage({ kind: 'orphans-swept', books: [{ bookId: 'a', name: 'Walden' }, { bookId: 'b', name: 'Emma' }] })).toBe(
      'Readside found 2 books not linked to a PDF in this vault: “Walden”, “Emma”. Their highlights and thoughts are kept, marked missing.',
    );
    expect(recoveryMessage({ kind: 'orphans-swept', books: [{ bookId: 'a', name: 'Walden' }] })).toContain('found 1 book not linked');
  });
});

describe('MarginPlugin: books from an earlier session', () => {
  it('a book is loaded through the store before id-based calls reach it', async () => {
    const first = await setup();
    await first.openInMargin(walden);
    await screen.findByRole('heading', { name: 'Walden' });
    const bookId = first.store.bookIdForPath('Books/Walden.pdf')!;
    const ann = await backend().createAnnotation({ bookId, location: pdfLocation({ page: 1, start: 0, end: 5 }), quote: 'Hello', color: 'yellow' });
    for (const l of marginLeaves()) await l.detach();
    first.unload();
    await first.store.flush();
    // A new session on the same vault: the store knows only the index until a view opens the book.
    plugin = new MarginPlugin(app, manifest);
    await plugin.onload();
    await plugin.ready;
    await expect(backend().getAnnotation(ann.id)).rejects.toThrow(`not found: annotation ${ann.id}`);
    await plugin.openInMargin(walden);
    await screen.findByRole('heading', { name: 'Walden' });
    expect((await backend().getAnnotation(ann.id)).quote).toBe('Hello');
  });

  it('closing a view while a rename is being applied finishes; the book is written', async () => {
    const p = await setup();
    await p.openInMargin(walden);
    await screen.findByRole('heading', { name: 'Walden' });
    const id = p.store.bookIdForPath('Books/Walden.pdf')!;
    const renaming = app.fileManager.renameFile(walden, 'Books/Walden Pond.pdf');
    const closing = marginLeaves()[0].detach();
    await Promise.all([renaming, closing]);
    await waitFor(() => expect(p.store.bookIdForPath('Books/Walden Pond.pdf')).toBe(id));
    await p.store.flush();
    expect(JSON.parse(app.vault.adapter.files.get(`${ROOT}/books/${id}.json`) as string).book.path).toBe('Books/Walden Pond.pdf');
  });
});

// ---- T7: translation wiring ----
import { ENGINE_CLOSED, type WorkerLike } from '../../src/translate/bergamot/BergamotClient';
import { pickDefaultTarget } from '../../src/translate/languages';
import { FakeFetcher, TestAdapter, fakeSha256, installOnDisk } from './translateFakes';

const TR = `${ROOT}/translation`;

class HeldWorker implements WorkerLike {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: ((e: unknown) => void) | null = null;
  sent: unknown[] = [];
  terminated = false;
  postMessage(m: unknown): void {
    this.sent.push(m);
  }
  terminate(): void {
    this.terminated = true;
  }
}

async function setupTranslation(settings: Record<string, unknown> = {}, before: (p: MarginPlugin) => void = () => {}) {
  app = makeApp();
  Object.assign(app.vault.adapter, { rmdir: TestAdapter.prototype.rmdir });
  const workers: HeldWorker[] = [];
  const fetcher = new FakeFetcher();
  plugin = new MarginPlugin(app, manifest);
  plugin.savedData = settings;
  plugin.translationOptions = {
    fetcher,
    sha256: fakeSha256,
    createWorker: () => {
      const w = new HeldWorker();
      workers.push(w);
      return w;
    },
  };
  before(plugin);
  await plugin.onload();
  await plugin.ready;
  return { plugin, workers, fetcher, adapter: app.vault.adapter as unknown as TestAdapter };
}

const filesUnder = (prefix: string) => [...(app.vault.adapter as unknown as TestAdapter).files.keys()].filter((k) => k.startsWith(`${prefix}/`));

describe('MarginPlugin: translation (T7)', () => {
  it('settings: no stored target → the system language’s closest match; a stored one is kept; an unknown one → the default', async () => {
    let { plugin: p } = await setupTranslation();
    expect(p.settings.translateTarget).toBe(pickDefaultTarget(navigator.language));
    expect(p.settings.translateHover).toBe(true);
    p.settings.translateTarget = 'fr';
    p.settings.translateHover = false;
    await p.saveSettings();
    const saved = p.savedData;
    p.unload();
    await p.unloading;
    ({ plugin: p } = await setupTranslation(saved as Record<string, unknown>));
    expect(p.settings).toMatchObject({ translateTarget: 'fr', translateHover: false });
    expect(p.translation()!.target()).toBe('fr');
    expect(p.translation()!.hoverEnabled()).toBe(false);
    p.unload();
    await p.unloading;
    ({ plugin: p } = await setupTranslation({ translateTarget: 'xx-Nope' }));
    expect(p.settings.translateTarget).toBe(pickDefaultTarget(navigator.language));
  });

  it('one translate host, made on first use; loading starts no worker and no download; null once unloading', async () => {
    const { plugin: p, workers, fetcher } = await setupTranslation();
    expect(workers).toHaveLength(0);
    expect(fetcher.total()).toBe(0);
    const h = p.translation();
    expect(h).not.toBeNull();
    expect(p.translation()).toBe(h);
    expect(p.host.translate?.()).toBe(h);
    expect(workers).toHaveLength(0);
    p.unload();
    expect(p.translation()).toBeNull();
    expect(p.host.translate?.()).toBeNull();
    await p.unloading;
  });

  it('“Set as default target” from the card saves the setting', async () => {
    const { plugin: p } = await setupTranslation();
    p.translation()!.setDefaultTarget?.('de');
    await vi.waitFor(() => expect((p.savedData as { translateTarget?: string }).translateTarget).toBe('de'));
  });

  it('the startup sweep runs later, not at load: leftover .part files and unlisted folders go', async () => {
    const { plugin: p, adapter } = await setupTranslation({}, (pl) => {
      pl.translationSweepDelayMs = 30;
      const a = pl.app.vault.adapter as unknown as TestAdapter;
      installOnDisk(a, TR, [['uk', 'en']]);
      a.folders.add(`${TR}/models/de-en`);
      a.folders.add(`${TR}/models/de-en/1.0`);
      a.files.set(`${TR}/models/de-en/1.0/model.deen.bin.part`, new ArrayBuffer(2));
      a.files.set(`${TR}/installed.json.tmp`, '{}');
    });
    expect(adapter.files.has(`${TR}/models/de-en/1.0/model.deen.bin.part`)).toBe(true);
    await vi.waitFor(() => expect(adapter.files.has(`${TR}/models/de-en/1.0/model.deen.bin.part`)).toBe(false));
    await vi.waitFor(() => expect(adapter.files.has(`${TR}/installed.json.tmp`)).toBe(false));
    expect(adapter.folders.has(`${TR}/models/de-en`)).toBe(false);
    expect(await p.translation()!.installedSizes()).toHaveLength(1);
  });

  it('unloaded before the sweep’s time: no sweep runs', async () => {
    const { plugin: p, adapter } = await setupTranslation({}, (pl) => {
      pl.translationSweepDelayMs = 20;
      const a = pl.app.vault.adapter as unknown as TestAdapter;
      a.folders.add(TR);
      a.files.set(`${TR}/x.part`, new ArrayBuffer(2));
    });
    p.unload();
    await p.unloading;
    await new Promise((r) => setTimeout(r, 60));
    expect(adapter.files.has(`${TR}/x.part`)).toBe(true);
  });

  it('unload (a plugin update) aborts a running download, leaves no partial file, terminates the worker; the store is still flushed and handed off', async () => {
    const { plugin: p, workers } = await setupTranslation();
    installOnDisk(app.vault.adapter as unknown as TestAdapter, TR, [['uk', 'en']]);
    const h = p.translation()!;
    const UK = 'Це книжка про історію України, її мову та культуру за останні сто років.';
    const translating = h.translate({ text: UK, from: 'uk', to: 'en' });
    await vi.waitFor(() => expect(workers[0]?.sent.length).toBeGreaterThan(0));
    const out = await h.translate({ text: 'This is a book about the history of the country.', from: 'en', to: 'de' });
    if (out.kind !== 'needsDownload') throw new Error(out.kind);
    const progress: number[] = [];
    const downloading = h.download(out.offer, { onProgress: (pr) => progress.push(pr.received) });
    await vi.waitFor(() => expect(progress.some((n) => n > 0)).toBe(true));
    h.background(out.offer);
    // The background download's progress Notice stays (duration 0).
    expect(Notice.durations[Notice.messages.indexOf('English → Deutsch: Downloading…')]).toBe(0);

    p.unload();
    await expect(downloading).rejects.toMatchObject({ name: 'AbortError' });
    await expect(translating).rejects.toThrow(ENGINE_CLOSED);
    expect(workers[0].terminated).toBe(true);
    await p.unloading;
    expect((window as unknown as Record<string, unknown>)[UNLOADING_KEY]).toBeUndefined();
    await vi.waitFor(() => expect(filesUnder(TR).filter((f) => f.endsWith('.part'))).toEqual([]));
    await vi.waitFor(() => expect(filesUnder(`${TR}/models/en-de`)).toEqual([]));
    // No failure Notice for a cancel.
    expect(Notice.messages.some((m) => m.startsWith('English → Deutsch:') && !m.includes('Downloading'))).toBe(false);
  });
});

// ---- T7 review fixes ----
describe('MarginPlugin: translation unload and startup sweep (T7 review)', () => {
  it('a translation close that throws on unload still releases, flushes the store and sets the handoff key', async () => {
    const { plugin: p } = await setupTranslation();
    const h = p.translation()!;
    (h as unknown as { deps: { client: { dispose(): void } } }).deps.client.dispose = () => {
      throw new Error('worker would not stop');
    };
    const storeFlush = vi.spyOn(p.store, 'flush');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      p.unload();
      expect((window as unknown as Record<string, unknown>)[UNLOADING_KEY]).toBe(p.unloading);
      expect(p.translation()).toBeNull();
      await p.unloading;
      expect(storeFlush).toHaveBeenCalled();
      expect(logged).toHaveBeenCalledWith('margin: closing translation on unload failed', expect.any(Error));
    } finally {
      logged.mockRestore();
    }
  });

  it('the startup sweep without a host tidies the folder without building one', async () => {
    const { plugin: p, adapter, workers } = await setupTranslation({}, (pl) => {
      pl.translationSweepDelayMs = 10;
      const a = pl.app.vault.adapter as unknown as TestAdapter;
      a.folders.add(TR);
      a.files.set(`${TR}/x.part`, new ArrayBuffer(2));
    });
    await vi.waitFor(() => expect(adapter.files.has(`${TR}/x.part`)).toBe(false));
    expect((p as unknown as { translateHost: unknown }).translateHost).toBeNull();
    expect(workers).toHaveLength(0);
  });
});

// ---- T6 review: the plugin hands its running startup sweep to a host made meanwhile ----
describe('MarginPlugin: startup sweep holds back a host made while it runs (T6 review)', () => {
  it('a download asked for during the timer-fired sweep fetches nothing until the sweep is done', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let sweeping = false;
    const { plugin: p, fetcher } = await setupTranslation({}, (pl) => {
      pl.translationSweepDelayMs = 10;
      const a = pl.app.vault.adapter as unknown as TestAdapter;
      a.folders.add(TR);
      a.folders.add(`${TR}/models`);
      a.files.set(`${TR}/x.part`, new ArrayBuffer(2));
      const list = a.list.bind(a);
      const rmdir = a.rmdir.bind(a);
      // Only the translation folder is held: the rest of the plugin's start lists and removes freely.
      a.list = async (path: string) => {
        if (path.startsWith(TR)) {
          sweeping = true;
          await gate;
        }
        return list(path);
      };
      a.rmdir = async (path: string, recursive: boolean) => {
        if (path.startsWith(TR)) await gate;
        return rmdir(path, recursive);
      };
    });
    await vi.waitFor(() => expect(sweeping).toBe(true));
    const h = p.translation()!;
    const out = await h.translate({ text: 'This is a book about the history of the country.', from: 'en', to: 'de' });
    if (out.kind !== 'needsDownload') throw new Error(out.kind);
    const dl = h.download(out.offer, {});
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(fetcher.total()).toBe(0);
    release();
    await dl;
    expect(fetcher.total()).toBeGreaterThan(0);
    expect((app.vault.adapter as unknown as TestAdapter).files.has(`${TR}/x.part`)).toBe(false);
  });
});

describe('MarginPlugin: EPUBs (E7)', () => {
  type Registry = { typeByExtension: Record<string, string>; getTypeByExtension(e: string): string | undefined };
  const registry = () => (app as unknown as { viewRegistry: Registry }).viewRegistry;
  const addMoby = () =>
    app.vault.addBinary('Books/Moby.epub', makeEpub({ title: 'Moby-Dick', creator: 'Herman Melville', sections: [{ name: 'a.xhtml', html: '<p>Call me Ishmael.</p>' }] }));

  it('load maps .epub to Readside when no one has it; unload hands it back', async () => {
    const p = await setup();
    expect(registry().getTypeByExtension('epub')).toBe(VIEW_TYPE);
    // .pdf stays with Obsidian's viewer (the setting is off).
    expect(registry().getTypeByExtension('pdf')).toBe('pdf');
    p.unload();
    await p.unloading;
    expect(registry().getTypeByExtension('epub')).toBeUndefined();
    plugin = null;
  });

  it('another plugin’s claim on .epub is left alone, at load and at unload', async () => {
    const a = makeApp();
    (a as unknown as { viewRegistry: Registry }).viewRegistry.typeByExtension.epub = 'someone-else';
    const p = new MarginPlugin(a, manifest);
    await p.onload();
    expect((a as unknown as { viewRegistry: Registry }).viewRegistry.getTypeByExtension('epub')).toBe('someone-else');
    p.unload();
    await p.unloading;
    expect((a as unknown as { viewRegistry: Registry }).viewRegistry.getTypeByExtension('epub')).toBe('someone-else');
    setBackend(null);
  });

  it('unload leaves .epub alone when another plugin took it over since', async () => {
    const p = await setup();
    registry().typeByExtension.epub = 'someone-else';
    p.unload();
    await p.unloading;
    expect(registry().getTypeByExtension('epub')).toBe('someone-else');
    plugin = null;
  });

  it('a refused claim on .epub does not stop the load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = await setup({}, { fallback: true });
    expect(registry().getTypeByExtension('epub')).toBeUndefined();
    expect(p.store).toBeTruthy();
    warn.mockRestore();
  });

  it('the file menu and the editor menu offer "Open in Readside" for an EPUB', async () => {
    await setup();
    const moby = addMoby();
    const menu = new Menu();
    app.workspace.trigger('file-menu', menu, moby, 'file-explorer');
    expect(menu.items.map((i) => i.title)).toEqual(['Open in Readside']);
    const line = 'See [[Books/Moby.epub]] today';
    const ed = new Menu();
    app.workspace.trigger('editor-menu', ed, { getCursor: () => ({ line: 0, ch: 8 }), getLine: () => line }, { file: null });
    expect(ed.items.map((i) => i.title)).toEqual(['Open in Readside']);
  });

  it('"Open current book in Readside" (id open-current-pdf) works for an active EPUB', async () => {
    const p = await setup();
    addMoby();
    const cmd = p.command('open-current-pdf');
    expect(cmd.name).toBe('Open current book in Readside');
    await openIn('markdown', 'Books/Moby.epub');
    expect(cmd.checkCallback!(true)).toBe(true);
  });

  it('opening an EPUB makes an epub book named and authored by its OPF', async () => {
    const p = await setup();
    const moby = addMoby();
    await p.openInMargin(moby);
    await waitFor(() => expect(p.store.bookIdForPath('Books/Moby.epub')).not.toBeNull());
    const book = p.store.peek(p.store.bookIdForPath('Books/Moby.epub')!)!.book;
    expect(book).toMatchObject({ format: 'epub', title: 'Moby-Dick', author: 'Herman Melville' });
    await waitFor(() => expect((marginLeaves()[0].view as MarginView).getDisplayText()).toBe('Moby-Dick'));
  });

  it('an EPUB that can’t be read as one still opens under its file name', async () => {
    const p = await setup();
    const bad = app.vault.addBinary('Books/Broken.epub', pdfBytes('not a zip'));
    await p.openInMargin(bad);
    await waitFor(() => expect(p.store.bookIdForPath('Books/Broken.epub')).not.toBeNull());
    expect(p.store.peek(p.store.bookIdForPath('Books/Broken.epub')!)!.book).toMatchObject({ format: 'epub', title: 'Broken', author: null });
  });

  it('an EPUB opens even when Obsidian’s pdf.js failed to load', async () => {
    __failPdfJs(new Error('no engine'));
    app = makeApp();
    const moby = addMoby();
    plugin = new MarginPlugin(app, manifest);
    await plugin.onload();
    await plugin.storeReady;
    await expect(plugin.pdfReady).rejects.toThrow('no engine');
    const book = await plugin.host.openBook(moby, await app.vault.readBinary(moby), () => ({ title: 'Moby-Dick', author: 'Herman Melville' }));
    expect(book).toMatchObject({ format: 'epub', title: 'Moby-Dick' });
  });

  it('obsidian://margin opens an EPUB and jumps to its epub location', async () => {
    const p = await setup();
    addMoby();
    const loc = epubLocation({ section: 1, start: 4, end: 9 });
    await p.openLink({ action: 'margin', file: 'Books/Moby.epub', loc: serializeLocation(loc) });
    await waitFor(() => expect(marginLeaves()).toHaveLength(1));
    await waitFor(() => expect(fake.goTo).toHaveBeenCalledWith(loc, expect.anything()));
  });
});

describe('MarginPlugin: an EPUB’s notebook note (E7 fix round 1)', () => {
  type Registry = { typeByExtension: Record<string, string>; getTypeByExtension(e: string): string | undefined };
  const nav = xhtml('<nav epub:type="toc"><ol><li><a href="text/a.xhtml">Etymology</a></li><li><a href="text/b.xhtml">Loomings</a></li></ol></nav>');
  const addMoby = () =>
    app.vault.addBinary(
      'Books/Moby.epub',
      makeEpub({ title: 'Moby-Dick', nav, sections: [{ name: 'a.xhtml', html: '<p>Whale.</p>' }, { name: 'b.xhtml', html: '<p>Call me Ishmael.</p>' }] }),
    );

  async function noteFor(p: MarginPlugin, moby: TFile): Promise<string> {
    const meta = () => ({ title: 'Moby-Dick', author: null });
    const book = await p.host.openBook(moby, await app.vault.readBinary(moby), meta);
    await backend().createAnnotation({ bookId: book.id, location: epubLocation({ section: 2, start: 0, end: 15 }), quote: 'Call me Ishmael', color: 'yellow' });
    await p.writeMirror(book.id);
    return app.vault.read(app.vault.getFileByPath('Readside/Moby-Dick.md')!);
  }

  it('writeMirror files the highlight under its TOC section (the EPUB outline, not pdf.js), while pdf.js is still loading', async () => {
    const p = await setup();
    const moby = addMoby();
    // pdf.js never arrives: an EPUB's note must not wait for it.
    p.pdfReady = new Promise(() => {});
    const md = await noteFor(p, moby);
    expect(md).toContain('## Loomings\n\n> [!quote] [§ 2](');
    expect(md).toContain('> Call me Ishmael');
  });

  it('…and with Obsidian’s pdf.js failed to load', async () => {
    __failPdfJs(new Error('no engine'));
    app = makeApp();
    const moby = addMoby();
    plugin = new MarginPlugin(app, manifest);
    await plugin.onload();
    await plugin.storeReady;
    await expect(plugin.pdfReady).rejects.toThrow('no engine');
    expect(await noteFor(plugin, moby)).toContain('## Loomings\n\n> [!quote] [§ 2](');
  });

  it('a stale .epub mapping to Readside (left from before) is kept at load and handed back at unload', async () => {
    const a = makeApp();
    const reg = (a as unknown as { viewRegistry: Registry }).viewRegistry;
    reg.typeByExtension.epub = VIEW_TYPE;
    const p = new MarginPlugin(a, manifest);
    await p.onload();
    expect(reg.getTypeByExtension('epub')).toBe(VIEW_TYPE);
    p.unload();
    await p.unloading;
    expect(reg.getTypeByExtension('epub')).toBeUndefined();
    setBackend(null);
  });
});
