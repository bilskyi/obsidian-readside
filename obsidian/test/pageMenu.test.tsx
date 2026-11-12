import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderers/pdf/PdfRenderer', async () => ({ PdfRenderer: (await import('./fakeRenderer')).FakePdfRenderer }));

import { Menu, __setPdfJs, type App, type TFile } from 'obsidian';
import * as bodySaves from '../../src/features/notebook/bodySaves';
import { backend, setBackend } from '../../src/lib/backend';
import { pdfLocation, pdfPoint } from '../../src/lib/location';
import MarginPlugin from '../src/main';
import { markdownLink } from '../src/links';
import { MarginView, VIEW_TYPE, copyQuoteWithLink, showPageMenu } from '../src/view/MarginView';
import { makeApp, manifest, pdfBytes } from './helpers';
import type { MenuItem } from './obsidian-mock';

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

/** Every Menu shown at a mouse event (the mock has no showAtMouseEvent of its own). */
const shown: { menu: Menu & { items: MenuItem[] }; event: MouseEvent }[] = [];
function watchMenus() {
  const proto = Menu.prototype as unknown as { showAtMouseEvent?: (e: MouseEvent) => Menu };
  const before = proto.showAtMouseEvent;
  proto.showAtMouseEvent = function (this: Menu, event: MouseEvent) {
    shown.push({ menu: this as Menu & { items: MenuItem[] }, event });
    return this;
  };
  return () => {
    if (before) proto.showAtMouseEvent = before;
    else delete proto.showAtMouseEvent;
  };
}

let app: App;
let plugin: MarginPlugin | null = null;
let unwatch: (() => void) | null = null;
const writeText = vi.fn(async (_text: string) => {});

async function openWalden(): Promise<{ view: MarginView; file: TFile }> {
  __setPdfJs(fakePdfjs);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  writeText.mockClear();
  app = makeApp();
  const file = app.vault.addBinary('Books/Walden.pdf', pdfBytes('walden'));
  plugin = new MarginPlugin(app, manifest);
  plugin.savedData = {};
  plugin.mirrorDelayMs = 10;
  await plugin.onload();
  await plugin.ready;
  await plugin.openInMargin(file);
  await screen.findByRole('heading', { name: 'Walden' });
  const view = app.workspace.getLeavesOfType(VIEW_TYPE).map((l) => l.view as MarginView).find((v) => v.file === file)!;
  await waitFor(() => expect(view.location.current).not.toBeNull());
  return { view, file };
}

afterEach(async () => {
  unwatch?.();
  unwatch = null;
  shown.length = 0;
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

describe('the page’s right-click menu in Obsidian', () => {
  it('showPageMenu lists the reader’s items in an Obsidian Menu, with icons, at the mouse', () => {
    unwatch = watchMenus();
    const onSelect = vi.fn();
    const event = new MouseEvent('contextmenu');
    showPageMenu(event, [
      { id: 'add-thought-here', label: 'Add thought here', icon: 'message-square-plus', onSelect },
      { id: 'copy-spot-link', label: 'Copy link to this spot', icon: 'link', onSelect: () => {} },
    ]);
    expect(shown).toHaveLength(1);
    expect(shown[0].event).toBe(event);
    const items = shown[0].menu.items;
    expect(items.map((i) => [i.title, i.icon])).toEqual([
      ['Add thought here', 'message-square-plus'],
      ['Copy link to this spot', 'link'],
    ]);
    items[0].handler!();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('a right-click on a page opens Obsidian’s Menu; "Add thought here" adds a pin on that page', async () => {
    unwatch = watchMenus();
    const { view } = await openWalden();
    const host = view.containerEl.querySelector('.reader-host')!;
    const page = host.appendChild(document.createElement('div'));
    page.className = 'pdf-page';
    page.dataset.page = '2';
    expect(fireEvent.contextMenu(page, { clientX: 100, clientY: 200 })).toBe(false);
    expect(shown).toHaveLength(1);
    // The reader's own menu stays out of it.
    expect(screen.queryByRole('menu')).toBeNull();
    const items = shown[0].menu.items;
    expect(items.map((i) => i.title)).toEqual(['Add thought here', 'Copy link to this spot']);
    const bookId = (view as unknown as { book: { id: string } }).book.id;
    await act(async () => items[0].handler!());
    await waitFor(async () => expect(await backend().listThoughts(bookId)).toHaveLength(1));
    const [t] = await backend().listThoughts(bookId);
    // The fake renderer knows no lines: the page's top.
    expect(JSON.parse(t.location!)).toMatchObject({ kind: 'pdf', value: { page: 2 } });
  });

  it('"Copy link to this spot" writes Obsidian’s Markdown link to that page', async () => {
    unwatch = watchMenus();
    const { view, file } = await openWalden();
    const page = view.containerEl.querySelector('.reader-host')!.appendChild(document.createElement('div'));
    page.className = 'pdf-page';
    page.dataset.page = '3';
    fireEvent.contextMenu(page, { clientX: 100, clientY: 200 });
    await act(async () => shown[0].menu.items[1].handler!());
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(markdownLink(file.path, pdfLocation({ page: 3, start: 0, end: 0 }), null)));
  });

  it('a right-click in a text field keeps the native menu', async () => {
    unwatch = watchMenus();
    const { view } = await openWalden();
    const page = view.containerEl.querySelector('.reader-host')!.appendChild(document.createElement('div'));
    page.className = 'pdf-page';
    page.dataset.page = '1';
    // A field inside a page (a form in the PDF) is still a field.
    const field = page.appendChild(document.createElement('textarea'));
    expect(fireEvent.contextMenu(field)).toBe(true);
    expect(shown).toHaveLength(0);
  });

  it('"Copy quote with link": the quote as a blockquote, then the obsidian:// link', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    writeText.mockClear();
    const at = pdfPoint(4, 12);
    await copyQuoteWithLink({ path: 'Books/Walden.pdf' } as TFile, at, 'Simplify,\nsimplify.');
    expect(writeText).toHaveBeenCalledWith(`> Simplify,\n> simplify.\n\n${markdownLink('Books/Walden.pdf', at, null)}`);
  });

  it('a clipboard failure says so in Readside’s words', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => Promise.reject(new Error('denied')) }, configurable: true });
    await expect(copyQuoteWithLink({ path: 'a.pdf' } as TFile, pdfPoint(1, 0), 'q')).rejects.toThrow("Readside couldn't copy the quote: denied");
  });

  it('showPageMenu tells the reader when Obsidian’s Menu goes, so its selection popover can come back', () => {
    unwatch = watchMenus();
    const onClose = vi.fn();
    showPageMenu(new MouseEvent('contextmenu'), [{ id: 'copy', label: 'Copy', icon: 'copy', onSelect: () => {} }], onClose);
    expect(onClose).not.toHaveBeenCalled();
    (shown[0].menu as unknown as { hide(): void }).hide();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
