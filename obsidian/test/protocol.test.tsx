import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderers/pdf/PdfRenderer', async () => ({ PdfRenderer: (await import('./fakeRenderer')).FakePdfRenderer }));

import { Notice, type App, type TFile } from 'obsidian';
import * as bodySaves from '../../src/features/notebook/bodySaves';
import { backend, setBackend } from '../../src/lib/backend';
import { pdfLocation, serializeLocation } from '../../src/lib/location';
import { buildObsidianUrl } from '../src/links';
import MarginPlugin from '../src/main';
import { fingerprint } from '../src/store/hash';
import { VIEW_TYPE, type MarginView } from '../src/view/MarginView';
import { fake } from './fakeRenderer';
import { makeApp, manifest, pdfBytes, tick } from './helpers';

let app: App;
let plugin: MarginPlugin | null = null;
let walden: TFile;
let writeText: ReturnType<typeof vi.fn>;

async function setup() {
  app = makeApp();
  walden = app.vault.addBinary('Books/Walden.pdf', pdfBytes('walden'));
  plugin = new MarginPlugin(app, manifest);
  await plugin.onload();
  await plugin.ready;
  return plugin;
}

const handler = (p: MarginPlugin) => p.protocolHandlers.get('margin')!;
const marginLeaves = () => app.workspace.getLeavesOfType(VIEW_TYPE);

beforeEach(() => {
  // The reader keeps the notebook's open state there: each test starts with it closed.
  localStorage.clear();
  fake.goTo.mockClear();
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  plugin?.unload();
  plugin = null;
  setBackend(null);
  bodySaves.resetBodySavesForTests();
  document.body.replaceChildren();
});

describe('obsidian://margin', () => {
  it('opens the file in Margin and jumps to the location', async () => {
    const p = await setup();
    const loc = pdfLocation({ page: 2, start: 0, end: 0 });
    await handler(p)({ action: 'margin', file: 'Books/Walden.pdf', loc: serializeLocation(loc) });
    await waitFor(() => expect(fake.goTo).toHaveBeenCalledWith(loc, expect.objectContaining({ flash: true })));
    expect(marginLeaves()).toHaveLength(1);
  });

  it('a second link reuses the open view and jumps again', async () => {
    const p = await setup();
    await handler(p)({ action: 'margin', file: 'Books/Walden.pdf', loc: serializeLocation(pdfLocation({ page: 1, start: 0, end: 0 })) });
    await screen.findByRole('heading', { name: 'Walden' });
    const loc = pdfLocation({ page: 3, start: 0, end: 0 });
    await act(async () => {
      await handler(p)({ action: 'margin', file: 'Books/Walden.pdf', loc: serializeLocation(loc) });
    });
    await waitFor(() => expect(fake.goTo).toHaveBeenCalledWith(loc, expect.objectContaining({ flash: true })));
    expect(marginLeaves()).toHaveLength(1);
  });

  it('a link to a file that is not in the vault shows a notice and opens nothing', async () => {
    const p = await setup();
    await handler(p)({ action: 'margin', file: 'Books/Nope.pdf' });
    expect(Notice.messages).toContain("Margin can't find Books/Nope.pdf in this vault.");
    expect(marginLeaves()).toHaveLength(0);
  });

  it('a link without a usable location just opens the file', async () => {
    const p = await setup();
    await handler(p)({ action: 'margin', file: 'Books/Walden.pdf', loc: '{broken' });
    await screen.findByRole('heading', { name: 'Walden' });
    await tick();
    expect(fake.goTo).not.toHaveBeenCalled();
  });
});

describe('Copy Link', () => {
  it('the notebook’s Copy Link puts a Markdown link to the highlight on the clipboard', async () => {
    const p = await setup();
    const loc = pdfLocation({ page: 2, start: 0, end: 19 });
    const { book } = await p.store.openPath(walden.path, await fingerprint(await app.vault.readBinary(walden)), walden.basename);
    await backend().createAnnotation({ bookId: book.id, location: loc, quote: 'Simplify, simplify.', color: 'yellow' });
    await p.openInMargin(walden);
    await screen.findByRole('heading', { name: 'Walden' });
    const view = marginLeaves()[0].view as MarginView;
    act(() => {
      view.commands.current!('toggleNotebook');
    });
    fireEvent.click(await screen.findByRole('button', { name: /^Actions for/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Link' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`[p. 2 · “Simplify, simplify.”](${buildObsidianUrl('Books/Walden.pdf', loc)})`),
    );
    expect(await screen.findByText('Link copied')).toBeTruthy();
  });

  it('a link to a place has just its page as the label', async () => {
    const p = await setup();
    const loc = pdfLocation({ page: 5, start: 0, end: 0 });
    await p.host.copyLink!(walden, loc, null);
    expect(writeText).toHaveBeenCalledWith(`[p. 5](${buildObsidianUrl('Books/Walden.pdf', loc)})`);
  });
});

describe('obsidian://margin edge cases', () => {
  it('a link to a vault file that is not a PDF shows a notice and opens nothing', async () => {
    const p = await setup();
    app.vault.addBinary('Notes/Walden.md', new TextEncoder().encode('# Walden').buffer as ArrayBuffer);
    await handler(p)({ action: 'margin', file: 'Notes/Walden.md' });
    expect(Notice.messages).toContain('Margin opens PDF and EPUB books only; Notes/Walden.md is not one.');
    expect(marginLeaves()).toHaveLength(0);
  });

  it('a link that names no file shows a notice and opens nothing', async () => {
    const p = await setup();
    await handler(p)({ action: 'margin' });
    expect(Notice.messages).toContain('Margin: this link names no file.');
    expect(marginLeaves()).toHaveLength(0);
  });

  it('a link without a loc opens the book at its stored position, without a jump', async () => {
    const p = await setup();
    await handler(p)({ action: 'margin', file: 'Books/Walden.pdf' });
    await screen.findByRole('heading', { name: 'Walden' });
    await tick();
    expect(fake.goTo).not.toHaveBeenCalled();
    expect(marginLeaves()).toHaveLength(1);
  });

  it('a link to the very place the book was left at still jumps there with a flash (a new view)', async () => {
    const p = await setup();
    const loc = pdfLocation({ page: 2, start: 0, end: 0 });
    const { book } = await p.store.openPath(walden.path, await fingerprint(await app.vault.readBinary(walden)), walden.basename);
    await p.store.mutate(book.id, (f) => void (f.book.lastLocation = serializeLocation(loc)));
    await handler(p)({ action: 'margin', file: 'Books/Walden.pdf', loc: serializeLocation(loc) });
    await waitFor(() => expect(fake.goTo).toHaveBeenCalledWith(loc, expect.objectContaining({ flash: true })));
  });

  it('a jump asked for before the book has loaded still goes when it is the stored position; a restored state at it does not', async () => {
    const p = await setup();
    const loc = pdfLocation({ page: 2, start: 0, end: 0 });
    const { book } = await p.store.openPath(walden.path, await fingerprint(await app.vault.readBinary(walden)), walden.basename);
    await p.store.mutate(book.id, (f) => void (f.book.lastLocation = serializeLocation(loc)));
    // A restored layout handing back the stored position: no jump (M8).
    const restored = app.workspace.getLeaf(true);
    await restored.setViewState({ type: VIEW_TYPE, state: { file: walden.path, loc: serializeLocation(loc) } });
    await screen.findByRole('heading', { name: 'Walden' });
    await tick();
    expect(fake.goTo).not.toHaveBeenCalled();
    await restored.detach();
    // navigate() before the file loads (an explicit jump): it goes, with its flash.
    const leaf = app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, state: {} });
    (leaf.view as MarginView).navigate(loc);
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: walden.path } });
    await waitFor(() => expect(fake.goTo).toHaveBeenCalledWith(loc, expect.objectContaining({ flash: true })));
  });

  it('the same link twice on an open view jumps (and flashes) both times', async () => {
    const p = await setup();
    const loc = pdfLocation({ page: 2, start: 0, end: 0 });
    await handler(p)({ action: 'margin', file: 'Books/Walden.pdf', loc: serializeLocation(loc) });
    await waitFor(() => expect(fake.goTo).toHaveBeenCalledWith(loc, expect.objectContaining({ flash: true })));
    const calls = fake.goTo.mock.calls.length;
    await act(async () => {
      await handler(p)({ action: 'margin', file: 'Books/Walden.pdf', loc: serializeLocation(loc) });
    });
    await waitFor(() => expect(fake.goTo.mock.calls.length).toBeGreaterThan(calls));
    expect(fake.goTo).toHaveBeenLastCalledWith(loc, expect.objectContaining({ flash: true }));
    expect(marginLeaves()).toHaveLength(1);
  });

  it('a clipboard failure rejects with one message (the error’s own text) and shows no Notice', async () => {
    const p = await setup();
    writeText.mockRejectedValue(new Error('Document is not focused.'));
    await expect(p.host.copyLink!(walden, pdfLocation({ page: 5, start: 0, end: 0 }), null)).rejects.toThrow(
      "Margin couldn't copy the link: Document is not focused.",
    );
    expect(Notice.messages).toEqual([]);
  });

  it('a successful copy shows no Notice: the reader says "Link copied" itself', async () => {
    const p = await setup();
    await p.host.copyLink!(walden, pdfLocation({ page: 5, start: 0, end: 0 }), null);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(Notice.messages).toEqual([]);
  });

  it('a clipboard failure from the notebook’s Copy Link is reported in the reader, not as copied', async () => {
    const p = await setup();
    writeText.mockRejectedValue(new Error('Document is not focused.'));
    const loc = pdfLocation({ page: 2, start: 0, end: 19 });
    const { book } = await p.store.openPath(walden.path, await fingerprint(await app.vault.readBinary(walden)), walden.basename);
    await backend().createAnnotation({ bookId: book.id, location: loc, quote: 'Simplify, simplify.', color: 'yellow' });
    await p.openInMargin(walden);
    await screen.findByRole('heading', { name: 'Walden' });
    const view = marginLeaves()[0].view as MarginView;
    act(() => {
      view.commands.current!('toggleNotebook');
    });
    fireEvent.click(await screen.findByRole('button', { name: /^Actions for/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Link' }));
    expect(await screen.findByText("Margin couldn't copy the link: Document is not focused.")).toBeTruthy();
    expect(Notice.messages).toEqual([]);
    expect(screen.queryByText('Link copied')).toBeNull();
  });
});

describe('obsidian://margin polish', () => {
  it('a link that arrives when Margin failed to load does nothing more (no unhandled rejection)', async () => {
    const p = await setup();
    const failed = Promise.reject(new Error('store unreadable'));
    failed.catch(() => {});
    p.ready = failed;
    await expect(handler(p)({ action: 'margin', file: 'Books/Walden.pdf' })).resolves.toBeUndefined();
    expect(marginLeaves()).toHaveLength(0);
    expect(Notice.messages).toEqual([]);
  });

  it('a hand-written path with a leading slash or backslashes is normalised before the lookup', async () => {
    const p = await setup();
    const lookup = vi.spyOn(app.vault, 'getFileByPath');
    await handler(p)({ action: 'margin', file: '/Books/Walden.pdf' });
    await handler(p)({ action: 'margin', file: 'Books\\Walden.pdf' });
    expect(lookup).toHaveBeenCalledWith('Books/Walden.pdf');
    expect(lookup).not.toHaveBeenCalledWith('/Books/Walden.pdf');
    expect(lookup).not.toHaveBeenCalledWith('Books\\Walden.pdf');
    expect(Notice.messages).toEqual([]);
    expect(marginLeaves()).toHaveLength(1);
  });

  it('a new leaf that is not a Margin view yet (deferred) gets the jump through its view state', async () => {
    const p = await setup();
    const loc = pdfLocation({ page: 3, start: 0, end: 0 });
    const leaf = app.workspace.getLeaf(true);
    const real = leaf.setViewState.bind(leaf);
    const states: Record<string, unknown>[] = [];
    // Deferred: Obsidian keeps the state and builds the view later (when the leaf is first shown).
    leaf.setViewState = vi.fn(async (vs) => void states.push(vs.state ?? {}));
    vi.spyOn(app.workspace, 'getLeaf').mockReturnValue(leaf);
    await handler(p)({ action: 'margin', file: 'Books/Walden.pdf', loc: serializeLocation(loc) });
    expect(states.at(-1)).toEqual({ file: 'Books/Walden.pdf', loc: serializeLocation(loc) });
    // Shown at last: the view is built from the kept state, and the jump goes.
    await real({ type: VIEW_TYPE, state: states.at(-1), active: true });
    await waitFor(() => expect(fake.goTo).toHaveBeenCalledWith(loc, expect.anything()));
  });

  it('a jump asked for after the file failed to open is dropped, not carried into the next file the leaf loads', async () => {
    const p = await setup();
    app.vault.addBinary('Books/Broken.pdf', pdfBytes('broken'));
    const readBinary = app.vault.readBinary.bind(app.vault);
    app.vault.readBinary = async (f) => {
      if (f.path === 'Books/Broken.pdf') throw new Error('disk error');
      return readBinary(f);
    };
    const leaf = app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: 'Books/Broken.pdf' }, active: true });
    expect(await screen.findByText(/Margin couldn't open Books\/Broken.pdf/)).toBeTruthy();
    (leaf.view as MarginView).navigate(pdfLocation({ page: 3, start: 0, end: 0 }));
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: walden.path }, active: true });
    await screen.findByRole('heading', { name: 'Walden' });
    await tick();
    expect(fake.goTo).not.toHaveBeenCalled();
    void p;
  });
});
