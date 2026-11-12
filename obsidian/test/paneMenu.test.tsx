import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderers/pdf/PdfRenderer', async () => ({ PdfRenderer: (await import('./fakeRenderer')).FakePdfRenderer }));

import { FileView, Menu, Modal, Notice, __setPdfJs, type App, type TFile } from 'obsidian';
import * as bodySaves from '../../src/features/notebook/bodySaves';
import { backend, setBackend } from '../../src/lib/backend';
import { pdfLocation, pdfPoint } from '../../src/lib/location';
import { epubLocation, epubPoint } from '../../src/lib/location';
import { OPENING_DELAY_MS } from '../../src/features/reader/ReaderState';
import MarginPlugin from '../src/main';
import { buildObsidianUrl } from '../src/links';
import { PdfPicker } from '../src/open';
import { MarginView, VIEW_TYPE } from '../src/view/MarginView';
import { MirrorScheduler } from '../src/mirror/scheduler';
import { HINT_DISMISSED_KEY } from '../../src/features/marginalia/MarginHint';
import { FakePdfRenderer, fake } from './fakeRenderer';
import { makeApp, manifest, pdfBytes, tick } from './helpers';
import type { MenuItem, WorkspaceLeaf } from './obsidian-mock';

class PdfView extends FileView {
  getViewType() {
    return 'pdf';
  }
}

const fakePdfjs = {
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 3,
      getOutline: async () => [],
      getDestination: async () => null,
      getPageIndex: async () => 0,
      destroy: async () => {},
    }),
  }),
};

let app: App;
let plugin: MarginPlugin | null = null;
let walden: TFile;
const writeText = vi.fn(async (_text: string) => {});

/** `fallback`: Obsidian's view registry refuses the .pdf mapping, so "Open PDFs in Margin" works by taking over file-open. */
async function setup(settings: Record<string, unknown> = {}, opts: { fallback?: boolean } = {}) {
  __setPdfJs(fakePdfjs);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  writeText.mockClear();
  app = makeApp();
  if (opts.fallback) {
    const reg = (app as unknown as { viewRegistry: { registerExtensions(e: string[], t: string): void } }).viewRegistry;
    const register = reg.registerExtensions.bind(reg);
    // Margin's claim is refused; Obsidian's viewer can still have .pdf back.
    reg.registerExtensions = (e, t) => {
      if (t === VIEW_TYPE) throw new Error('refused');
      register(e, t);
    };
  }
  walden = app.vault.addBinary('Books/Walden.pdf', pdfBytes('walden'));
  app.workspace.viewCreators.set('pdf', (leaf) => new PdfView(leaf));
  plugin = new MarginPlugin(app, manifest);
  plugin.savedData = settings;
  plugin.mirrorDelayMs = 10;
  await plugin.onload();
  await plugin.ready;
  return plugin;
}

async function openWalden(p: MarginPlugin, file: TFile = walden): Promise<MarginView> {
  await p.openInMargin(file);
  await screen.findByRole('heading', { name: 'Walden' });
  const view = app.workspace.getLeavesOfType(VIEW_TYPE).map((l) => l.view as MarginView).find((v) => v.file === file)!;
  // The book is open: the reader reports the page on screen.
  await waitFor(() => expect(view.location.current).not.toBeNull());
  return view;
}

function paneMenu(view: MarginView): MenuItem[] {
  const menu = new Menu();
  view.onPaneMenu(menu as never, 'more-options');
  return (menu as unknown as { items: MenuItem[] }).items;
}
const item = (items: MenuItem[], title: string) => {
  const found = items.find((i) => i.title === title);
  if (!found) throw new Error(`no menu item ${title}`);
  return found;
};

afterEach(async () => {
  if (plugin) {
    plugin.unload();
    await plugin.unloading;
    await app.workspace.viewsClosing;
  }
  plugin = null;
  vi.restoreAllMocks();
  setBackend(null);
  bodySaves.resetBodySavesForTests();
  document.body.replaceChildren();
  localStorage.clear();
});

describe('the pane menu', () => {
  it('keeps Obsidian’s own items and adds the three Readside items, with lucide icons', async () => {
    const view = await openWalden(await setup());
    const items = paneMenu(view);
    expect(items.map((i) => i.title)).toEqual(['Close', "Open in Obsidian's viewer", 'Open notebook note', 'Copy link to this page']);
    expect(items.slice(1).map((i) => i.icon)).toEqual(['file-text', 'notebook-pen', 'link']);
  });

  it('"Open in Obsidian\'s viewer" switches the leaf to Obsidian’s PDF view of the same file', async () => {
    const view = await openWalden(await setup());
    const leaf = view.leaf;
    await act(async () => item(paneMenu(view), "Open in Obsidian's viewer").handler!());
    await waitFor(() => expect(leaf.view.getViewType()).toBe('pdf'));
    expect((leaf.view as FileView).file?.path).toBe('Books/Walden.pdf');
  });

  /** Obsidian fires file-open on every tab switch: away to a note and back, long after the switch. */
  async function switchAwayAndBack(leaf: WorkspaceLeaf) {
    const later = Date.now() + 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    const note = app.vault.addBinary('Notes/Other.pdf', pdfBytes('other'));
    app.workspace.trigger('file-open', note);
    app.workspace.setActiveLeaf(leaf as never);
    app.workspace.trigger('file-open', walden);
    app.workspace.trigger('file-open', walden);
    await new Promise((r) => setTimeout(r, 1200));
  }

  it('with "Open PDFs in Readside" on (.pdf mapped to Readside), the viewer the user chose stays, however much later file-open fires', async () => {
    const p = await setup({ openPdfsInMargin: true });
    expect((app as unknown as { viewRegistry: { getTypeByExtension(e: string): string } }).viewRegistry.getTypeByExtension('pdf')).toBe(VIEW_TYPE);
    const view = await openWalden(p);
    const leaf = view.leaf;
    await act(async () => item(paneMenu(view), "Open in Obsidian's viewer").handler!());
    await waitFor(() => expect(leaf.view.getViewType()).toBe('pdf'));
    await switchAwayAndBack(leaf as unknown as WorkspaceLeaf);
    expect(leaf.view.getViewType()).toBe('pdf');
  });

  it('.pdf mapped to Readside: a PDF leaf in Obsidian’s viewer is there by choice ("Open with"), so it is not taken over', async () => {
    await setup({ openPdfsInMargin: true });
    const leaf = app.workspace.getLeaf(true);
    await leaf.setViewState({ type: 'pdf', state: { file: 'Books/Walden.pdf' }, active: true });
    app.workspace.trigger('file-open', walden);
    await new Promise((r) => setTimeout(r, 1200));
    expect(leaf.view.getViewType()).toBe('pdf');
  });

  it('no registry mapping (fallback): a leaf switched to the viewer stays there while it shows that file', async () => {
    const p = await setup({ openPdfsInMargin: true }, { fallback: true });
    expect((app as unknown as { viewRegistry: { getTypeByExtension(e: string): string } }).viewRegistry.getTypeByExtension('pdf')).toBe('pdf');
    const view = await openWalden(p);
    const leaf = view.leaf;
    await act(async () => item(paneMenu(view), "Open in Obsidian's viewer").handler!());
    await waitFor(() => expect(leaf.view.getViewType()).toBe('pdf'));
    await switchAwayAndBack(leaf as unknown as WorkspaceLeaf);
    expect(leaf.view.getViewType()).toBe('pdf');
  });

  it('fallback: a new PDF leaf in the viewer is still taken over, and a kept leaf is forgotten once it shows another file', async () => {
    const p = await setup({ openPdfsInMargin: true }, { fallback: true });
    const other = app.vault.addBinary('Books/Other.pdf', pdfBytes('other'));
    const view = await openWalden(p);
    const kept = view.leaf;
    await act(async () => item(paneMenu(view), "Open in Obsidian's viewer").handler!());
    await waitFor(() => expect(kept.view.getViewType()).toBe('pdf'));
    // A fresh leaf opening the same file in the viewer: not the one the user chose, so Margin takes it.
    const fresh = app.workspace.getLeaf(true);
    await fresh.setViewState({ type: 'pdf', state: { file: 'Books/Walden.pdf' }, active: true });
    app.workspace.trigger('file-open', walden);
    await waitFor(() => expect(fresh.view.getViewType()).toBe(VIEW_TYPE), { timeout: 2000 });
    expect(kept.view.getViewType()).toBe('pdf');
    // The kept leaf moves to another file, then back: the choice was for the file it showed, so it is taken over now.
    app.workspace.setActiveLeaf(kept);
    await kept.setViewState({ type: 'pdf', state: { file: other.path }, active: true });
    app.workspace.trigger('file-open', other);
    await waitFor(() => expect(kept.view.getViewType()).toBe(VIEW_TYPE), { timeout: 2000 });
    await kept.setViewState({ type: 'pdf', state: { file: 'Books/Walden.pdf' }, active: true });
    app.workspace.trigger('file-open', walden);
    await waitFor(() => expect(kept.view.getViewType()).toBe(VIEW_TYPE), { timeout: 2000 });
  });

  it('before the book has opened there is no page to link to: a Notice says so and nothing is copied', async () => {
    const view = await openWalden(await setup());
    view.location.current = null;
    await act(async () => item(paneMenu(view), 'Copy link to this page').handler!());
    expect(writeText).not.toHaveBeenCalled();
    expect(Notice.messages.at(-1)).toBe('Readside: the book is still opening, so there is no page to link to yet.');
  });

  it('while the book is still opening the view knows no page, so nothing is copied', async () => {
    const p = await setup();
    let finish!: () => void;
    vi.spyOn(FakePdfRenderer.prototype, 'open').mockImplementation(() => new Promise<void>((r) => (finish = r)));
    await p.openInMargin(walden);
    await screen.findByRole('heading', { name: 'Walden' });
    const view = app.workspace.getLeavesOfType(VIEW_TYPE)[0].view as MarginView;
    await tick();
    expect(view.location.current).toBeNull();
    await act(async () => view.copyPageLink());
    expect(writeText).not.toHaveBeenCalled();
    await act(async () => finish());
    await waitFor(() => expect(view.location.current).not.toBeNull());
  });

  it('"Copy link to this page" writes a Markdown obsidian://readside link to the page on screen, and says so', async () => {
    const view = await openWalden(await setup());
    const page3 = pdfLocation({ page: 3, start: 0, end: 0 });
    // A point on page 3 (the reader reports page-level locations; the link is to the page either way).
    act(() => fake.emitLocation(pdfPoint(3, 40, 0.5)));
    await act(async () => item(paneMenu(view), 'Copy link to this page').handler!());
    await waitFor(() => expect(Notice.messages.length).toBeGreaterThan(0));
    expect(writeText).toHaveBeenCalledWith(`[p. 3](${buildObsidianUrl('Books/Walden.pdf', page3)})`);
    expect(Notice.messages.at(-1)).toBe('Readside: link to page 3 copied.');
  });

  it('a clipboard failure is a Notice from Readside, not a "copied"', async () => {
    const view = await openWalden(await setup());
    writeText.mockRejectedValueOnce(new Error('denied'));
    await act(async () => item(paneMenu(view), 'Copy link to this page').handler!());
    await waitFor(() => expect(Notice.messages.length).toBeGreaterThan(0));
    expect(Notice.messages.at(-1)).toBe("Readside couldn't copy the link: denied");
  });
});

describe('the notebook note', () => {
  const highlight = (p: MarginPlugin, path = 'Books/Walden.pdf') =>
    backend().createAnnotation({
      bookId: p.store.bookIdForPath(path)!,
      location: pdfLocation({ page: 1, start: 0, end: 8 }),
      quote: 'Simplify',
      color: 'yellow',
    });
  const newTabs = () => app.workspace.leaves.filter((l) => (l as unknown as WorkspaceLeaf).openedFile);

  it('opens in a new tab once it exists', async () => {
    const p = await setup();
    const view = await openWalden(p);
    await highlight(p);
    await waitFor(() => expect(app.vault.getFileByPath('Readside/Walden.md')).not.toBeNull());
    const before = app.workspace.leaves.length;
    await act(async () => item(paneMenu(view), 'Open notebook note').handler!());
    await waitFor(() => expect(app.workspace.leaves.length).toBe(before + 1));
    expect((newTabs()[0] as unknown as WorkspaceLeaf).openedFile?.path).toBe('Readside/Walden.md');
    expect(view.leaf.view).toBe(view);
  });

  it('finds a second book of the same title at its "(2)" note, from the record', async () => {
    const p = await setup();
    const other = app.vault.addBinary('Elsewhere/Walden.pdf', pdfBytes('another walden'));
    await openWalden(p);
    await highlight(p);
    await waitFor(() => expect(app.vault.getFileByPath('Readside/Walden.md')).not.toBeNull());
    const second = await openWalden(p, other);
    await highlight(p, 'Elsewhere/Walden.pdf');
    await waitFor(() => expect(app.vault.getFileByPath('Readside/Walden (2).md')).not.toBeNull());
    await act(async () => second.openNotebookNote());
    expect((newTabs().at(-1) as unknown as WorkspaceLeaf).openedFile?.path).toBe('Readside/Walden (2).md');
  });

  it('none yet: a Notice says when it appears; notes off: a Notice says they are off in settings', async () => {
    const p = await setup();
    const view = await openWalden(p);
    await act(async () => view.openNotebookNote());
    expect(Notice.messages.at(-1)).toBe('Readside: this book has no notebook note yet. It appears after your first highlight or thought.');
    p.settings.mirrorEnabled = false;
    await act(async () => view.openNotebookNote());
    expect(Notice.messages.at(-1)).toBe('Readside: notebook notes are turned off in settings.');
    expect(newTabs()).toEqual([]);
  });

  it('a note on record that was moved or deleted: the Notice says so, and that it comes back on the next change', async () => {
    const p = await setup();
    const view = await openWalden(p);
    await highlight(p);
    await waitFor(() => expect(app.vault.getFileByPath('Readside/Walden.md')).not.toBeNull());
    await app.vault.delete(app.vault.getFileByPath('Readside/Walden.md')!);
    await act(async () => view.openNotebookNote());
    expect(Notice.messages.at(-1)).toBe("Readside: the notebook note was moved or deleted; it's rewritten on your next change.");
    expect(newTabs()).toEqual([]);
  });

  it('highlights whose note is still pending: the note is written now and opened, not "none yet"', async () => {
    const p = await setup();
    // Notes far behind the changes: nothing is written by itself during this test.
    p.scheduler.dispose();
    p.scheduler = new MirrorScheduler((id) => p.writeMirror(id), 60_000);
    const view = await openWalden(p);
    await highlight(p);
    await tick();
    expect(app.vault.getFileByPath('Readside/Walden.md')).toBeNull();
    await act(async () => view.openNotebookNote());
    expect(app.vault.getFileByPath('Readside/Walden.md')).not.toBeNull();
    expect((newTabs().at(-1) as unknown as WorkspaceLeaf | undefined)?.openedFile?.path).toBe('Readside/Walden.md');
    expect(Notice.messages.filter((m) => m.includes('no notebook note yet'))).toEqual([]);
    p.scheduler.dispose();
  });

  it('the "Open notebook note" command is there only while a Readside view is active', async () => {
    const p = await setup();
    const command = p.command('open-notebook-note');
    expect(command.name).toBe('Open notebook note');
    expect(command.checkCallback!(true)).toBe(false);
    const view = await openWalden(p);
    const spy = vi.spyOn(view, 'openNotebookNote').mockResolvedValue();
    expect(command.checkCallback!(true)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    command.checkCallback!(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('opening states in the plugin', () => {
  it('before the reader mounts (store and pdf.js loading), the view shows the title and "Opening…" after a moment', async () => {
    const p = await setup();
    let release!: () => void;
    p.storeReady = new Promise<void>((r) => (release = r));
    const leaf = app.workspace.getLeaf(true);
    void leaf.setViewState({ type: VIEW_TYPE, state: { file: 'Books/Walden.pdf' }, active: true });
    await tick();
    const view = leaf.view as MarginView;
    expect(view.contentEl.querySelector('.margin-app')).not.toBeNull();
    expect(view.contentEl.textContent).not.toContain('Opening…');
    // Pending's delay starts in its effect, after the commit: a fixed real sleep could end first on a slow runner.
    await waitFor(() => expect(view.contentEl.querySelector('.reader-state.is-opening')?.textContent).toContain('Opening…'));
    const state = view.contentEl.querySelector('.reader-state.is-opening');
    expect(state?.textContent).toContain('Walden');
    release();
    await screen.findByRole('heading', { name: 'Walden' });
  });

  it('a PDF pdf.js can’t read shows plain words, the raw message under Details, and offers Obsidian’s viewer', async () => {
    const p = await setup();
    vi.spyOn(FakePdfRenderer.prototype, 'open').mockRejectedValue(
      Object.assign(new Error('Page dictionary kid reference points to wrong type of object.'), { name: 'UnknownErrorException' }),
    );
    await p.openInMargin(walden);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Readside couldn't read this PDF; it may be damaged.");
    expect(alert.querySelector('pre')?.textContent).toBe('UnknownErrorException: Page dictionary kid reference points to wrong type of object.');
    const leaf = app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    fireEvent.click(screen.getByRole('button', { name: "Open in Obsidian's viewer" }));
    await waitFor(() => expect(leaf.view.getViewType()).toBe('pdf'));
  });

  it('a file the vault can’t read says so in the page area, with the reason under Details', async () => {
    await setup();
    app.vault.adapter.failOn('readBinary', 'Books/Walden.pdf');
    await plugin!.openInMargin(walden);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Readside couldn't open Books/Walden.pdf.");
    expect(alert.querySelector('summary')?.textContent).toBe('Details');
    expect(screen.getByRole('button', { name: "Open in Obsidian's viewer" })).toBeTruthy();
  });
});

describe('the opening status and hand-over', () => {
  const region = (view: MarginView) => view.contentEl.querySelectorAll<HTMLElement>('[role="status"][aria-live="polite"]');

  it('one persistent status region: there before any text, "Opening <title>…" across Pending and the reader, then "<title> opened"', async () => {
    const p = await setup();
    let release!: () => void;
    p.storeReady = new Promise<void>((r) => (release = r));
    let finish!: () => void;
    vi.spyOn(FakePdfRenderer.prototype, 'open').mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const leaf = app.workspace.getLeaf(true);
    void leaf.setViewState({ type: VIEW_TYPE, state: { file: 'Books/Walden.pdf' }, active: true });
    await tick();
    const view = leaf.view as MarginView;
    expect(region(view)).toHaveLength(1);
    const el = region(view)[0];
    expect(el.classList.contains('visually-hidden')).toBe(true);
    expect(el.textContent).toBe('');
    // Pending's delay is timed from its effect, after the commit: on a slow runner it can start late, so
    // a fixed real sleep past OPENING_DELAY_MS could end first.
    await waitFor(() => expect(el.textContent).toBe('Opening Walden…'));
    // The visual state is hidden from screen readers: the region speaks for it.
    expect(view.contentEl.querySelector('.reader-state.is-opening')?.getAttribute('aria-hidden')).toBe('true');
    release();
    await screen.findByRole('heading', { name: 'Walden' });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    // The reader has mounted: still the same element, still one region.
    expect(region(view)).toHaveLength(1);
    expect(region(view)[0]).toBe(el);
    expect(el.isConnected).toBe(true);
    expect(el.textContent).toBe('Opening Walden…');
    await act(async () => finish());
    await waitFor(() => expect(el.textContent).toBe('Walden opened'));
    expect(region(view)[0]).toBe(el);
  });

  it('a slow store, then a slow PDF: "Opening…" stays on screen without a gap until the book opens', async () => {
    const p = await setup();
    let release!: () => void;
    p.storeReady = new Promise<void>((r) => (release = r));
    let finish!: () => void;
    vi.spyOn(FakePdfRenderer.prototype, 'open').mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const leaf = app.workspace.getLeaf(true);
    void leaf.setViewState({ type: VIEW_TYPE, state: { file: 'Books/Walden.pdf' }, active: true });
    await tick();
    const view = leaf.view as MarginView;
    const opening = () => !!view.contentEl.querySelector('.reader-state.is-opening') && view.contentEl.textContent!.includes('Opening…');
    await waitFor(() => expect(opening()).toBe(true));
    // Pending tells the view it is on screen from an effect, after the commit that shows it; the status
    // region's text is set in that same call. Released before that, the reader would mount without the
    // hand-over (its own 200 ms delay): on a slow runner the store can win that race.
    await waitFor(() => expect(region(view)[0].textContent).toBe('Opening Walden…'));
    const title = view.contentEl.querySelector('.reader-state-title')!;
    // From here until the book opens, every DOM change must leave "Opening…" on screen.
    let gaps = 0;
    let done = false;
    const observer = new MutationObserver(() => {
      if (!done && !opening()) gaps++;
    });
    observer.observe(view.contentEl, { subtree: true, childList: true, characterData: true, attributes: true });
    release();
    await screen.findByRole('heading', { name: 'Walden' });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    for (let i = 0; i < 6; i++) {
      expect(opening()).toBe(true);
      await act(async () => new Promise((r) => setTimeout(r, 50)));
    }
    expect(opening()).toBe(true);
    // The title sits in the page column below a toolbar-height bar in both, so it does not jump.
    expect(title.closest('.reader-column')).toBeTruthy();
    expect(view.contentEl.querySelector('.reader-state-title')!.closest('.reader-column')).toBeTruthy();
    done = true;
    await act(async () => finish());
    observer.disconnect();
    expect(gaps).toBe(0);
    await waitFor(() => expect(opening()).toBe(false));
  });

  it('a fast store keeps the reader’s own delay: no opening state for a quick open', async () => {
    await setup();
    await plugin!.openInMargin(walden);
    await screen.findByRole('heading', { name: 'Walden' });
    const view = app.workspace.getLeavesOfType(VIEW_TYPE)[0].view as MarginView;
    await act(async () => new Promise((r) => setTimeout(r, OPENING_DELAY_MS + 50)));
    expect(view.contentEl.querySelector('.reader-state.is-opening')).toBeNull();
    expect(region(view)[0].textContent).toBe('');
  });
});

describe('failure, retry and teardown', () => {
  it('"Try again" loads the file again in the same leaf and view', async () => {
    await setup();
    app.vault.adapter.failOn('readBinary', 'Books/Walden.pdf');
    await plugin!.openInMargin(walden);
    const alert = await screen.findByRole('alert');
    const leaf = app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const view = leaf.view as MarginView;
    expect(alert.textContent).toContain("Readside couldn't open Books/Walden.pdf.");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'Walden' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(leaf.view).toBe(view);
    expect(app.workspace.getLeavesOfType(VIEW_TYPE)).toEqual([leaf]);
    await waitFor(() => expect(view.location.current).not.toBeNull());
  });

  it('a load that starts once the view is closing mounts nothing', async () => {
    const view = await openWalden(await setup());
    const file = view.file!;
    const old = view.contentEl.querySelector('.margin-app');
    const fresh = () => [...view.contentEl.querySelectorAll('.margin-app')].filter((el) => el !== old);
    const closing = view.leaf.detach();
    const loading = view.onLoadFile(file);
    // Its synchronous first step (the opening state's root) must not run on a closing view.
    expect(fresh()).toEqual([]);
    await loading;
    await closing;
    expect(fresh()).toEqual([]);
    expect(view.contentEl.querySelector('.margin-app')).toBeNull();
  });
});

describe('the first-run hint in the plugin', () => {
  it('the first thought made retires the hint on this device', async () => {
    const view = await openWalden(await setup());
    expect(localStorage.getItem(HINT_DISMISSED_KEY)).toBeNull();
    await act(async () => {
      view.commands.current!('newThought');
    });
    await waitFor(() => expect(localStorage.getItem(HINT_DISMISSED_KEY)).toBe('1'));
  });
});

describe('copy', () => {
  it('the ribbon’s tooltip names the shelf; the shelf’s picker says what it opens', async () => {
    const p = await setup();
    expect(p.ribbonIcons[0].title).toBe('Open Readside shelf');
    expect(p.command('open-shelf').name).toBe('Open Readside shelf');
    p.ribbonIcons[0].el.click();
    (await screen.findByRole('button', { name: 'Open a book…' })).click();
    await waitFor(() => expect(Modal.opened[0]).toBeInstanceOf(PdfPicker));
    expect((Modal.opened[0] as PdfPicker & { placeholder: string }).placeholder).toBe('Open a book in Readside');
  });

  it('every Notice the plugin source shows starts with "Readside"', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join, resolve } = await import('node:path');
    const dir = resolve(process.cwd(), 'obsidian/src');
    const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));
    const literals: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const m of src.matchAll(/new Notice\(\s*(['`"])((?:\\.|(?!\1).)*)\1/g)) literals.push(m[2]);
      // Messages passed through a helper or a ternary: every quoted string argument right after `new Notice(`.
      for (const m of src.matchAll(/new Notice\(\s*\n?\s*\w+\s*\n?\s*\?\s*(['`"])((?:\\.|(?!\1).)*)\1\s*:\s*(['`"])((?:\\.|(?!\3).)*)\3/g)) {
        literals.push(m[2], m[4]);
      }
    }
    expect(literals.length).toBeGreaterThan(8);
    for (const text of literals) expect(text, text).toMatch(/^Readside\b/);
  });
});

describe('copy link to this place: an epub location', () => {
  it('names the section § N in the link and the Notice', async () => {
    const view = await openWalden(await setup());
    view.location.current = epubPoint(4, 10, 0.2);
    await act(async () => view.copyPageLink());
    await waitFor(() => expect(Notice.messages.length).toBeGreaterThan(0));
    const section = epubLocation({ section: 4, start: 0, end: 0 });
    expect(writeText).toHaveBeenCalledWith(`[§ 4](${buildObsidianUrl('Books/Walden.pdf', section)})`);
    expect(Notice.messages.at(-1)).toBe('Readside: link to § 4 copied.');
  });
});
