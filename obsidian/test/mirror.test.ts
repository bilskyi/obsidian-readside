import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderers/pdf/PdfRenderer', async () => ({ PdfRenderer: (await import('./fakeRenderer')).FakePdfRenderer }));

import { Notice, Tasks, __setPdfJs, type App, type TFile } from 'obsidian';
import * as bodySaves from '../../src/features/notebook/bodySaves';
import { backend, setBackend } from '../../src/lib/backend';
import { pdfLocation } from '../../src/lib/location';
import { tauriBackend } from '../../src/lib/tauriBackend';
import MarginPlugin, { HANDOFF_TIMEOUT_MS, MIRROR_FLUSH_TIMEOUT_MS } from '../src/main';
import { MarginSettingTab } from '../src/settings';
import { VIEW_TYPE } from '../src/view/MarginView';
import { makeApp, manifest, pdfBytes } from './helpers';

const fakePdfjs = {
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 3,
      getOutline: async () => [{ title: 'Economy', dest: [{ num: 1, gen: 0 }], items: [] }],
      getDestination: async () => null,
      getPageIndex: async () => 0,
      destroy: async () => {},
    }),
  }),
};

let app: App;
let plugin: MarginPlugin | null = null;
let walden: TFile;

async function setup(settings: Record<string, unknown> = {}, delayMs = 10) {
  __setPdfJs(fakePdfjs);
  app = makeApp();
  walden = app.vault.addBinary('Books/Walden.pdf', pdfBytes('walden'));
  plugin = new MarginPlugin(app, manifest);
  plugin.savedData = settings;
  plugin.mirrorDelayMs = delayMs;
  await plugin.onload();
  await plugin.ready;
  await plugin.openInMargin(walden);
  await screen.findByRole('heading', { name: 'Walden' });
  return plugin;
}

const highlight = (p: MarginPlugin, quote = 'Simplify') =>
  backend().createAnnotation({
    bookId: p.store.bookIdForPath('Books/Walden.pdf')!,
    location: pdfLocation({ page: 1, start: 0, end: 8 }),
    quote,
    color: 'yellow',
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Closes the reader (its note is written then), so a later change is only pending in the scheduler. */
const closeView = () => app.workspace.getLeavesOfType(VIEW_TYPE)[0].detach();
const note = () => app.vault.getFileByPath('Margin/Walden.md');

afterEach(async () => {
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

describe('notebook mirror', () => {
  it('a change to a book writes its notebook note shortly after', async () => {
    const p = await setup();
    await highlight(p);
    await waitFor(() => expect(note()).not.toBeNull());
    const md = await app.vault.read(note()!);
    expect(md).toContain('margin-book: "[[Books/Walden.pdf]]"');
    expect(md).toContain('## Economy');
    expect(md).toContain('> Simplify');
  });

  it('closing the view writes the note at once', async () => {
    const p = await setup({}, 60_000);
    await highlight(p);
    expect(note()).toBeNull();
    await app.workspace.getLeavesOfType(VIEW_TYPE)[0].detach();
    expect(note()).not.toBeNull();
  });

  it('with notebook notes turned off nothing is written', async () => {
    const p = await setup({ mirrorEnabled: false });
    await highlight(p);
    await app.workspace.getLeavesOfType(VIEW_TYPE)[0].detach();
    await new Promise((r) => setTimeout(r, 30));
    expect(note()).toBeNull();
  });

  it('registers the settings tab', async () => {
    const p = await setup();
    expect(p.settingTabs[0]).toBeInstanceOf(MarginSettingTab);
  });

  it('unload writes a pending note from the store’s final state, before the store closes and the backend goes', async () => {
    const p = await setup({}, 60_000);
    await closeView();
    await highlight(p, 'Written on unload');
    const vault = backend();
    const close = vi.spyOn(p.store, 'close');
    const atWrite: { backend: unknown; closed: boolean }[] = [];
    const write = app.vault.adapter.write.bind(app.vault.adapter);
    app.vault.adapter.write = async (path, data) => {
      if (path === 'Margin/Walden.md') atWrite.push({ backend: backend(), closed: close.mock.calls.length > 0 });
      return write(path, data);
    };
    p.unload();
    plugin = null;
    await p.unloading;
    expect(await app.vault.read(note()!)).toContain('> Written on unload');
    expect(atWrite).toEqual([{ backend: vault, closed: false }]);
    expect(close).toHaveBeenCalled();
    expect(backend()).toBe(tauriBackend);
  });

  it('a note write that never finishes holds unload only for the bound', async () => {
    const p = await setup({}, 60_000);
    p.mirrorFlushTimeoutMs = 50;
    await closeView();
    await highlight(p, 'Stuck');
    app.vault.process = () => new Promise(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    p.unload();
    plugin = null;
    const started = Date.now();
    await p.unloading;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(backend()).toBe(tauriBackend);
    await expect(p.store.mutate(p.store.bookIdForPath('Books/Walden.pdf')!, () => {})).rejects.toThrow('turned off');
    error.mockRestore();
  });

  it('the quit task writes a pending note before Obsidian closes', async () => {
    const p = await setup({}, 60_000);
    await closeView();
    await highlight(p, 'Written on quit');
    const tasks = new Tasks();
    app.workspace.trigger('quit', tasks);
    await tasks.run();
    expect(await app.vault.read(note()!)).toContain('> Written on quit');
  });

  it('writing the note does not schedule another write', async () => {
    const p = await setup();
    await sleep(50); // whatever opening the book changed has been written
    const write = vi.spyOn(p.mirrors, 'write');
    await highlight(p);
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await sleep(100);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('a renamed PDF moves its note; the mirror’s own move is not taken for a book rename', async () => {
    const p = await setup();
    await highlight(p);
    await waitFor(() => expect(note()).not.toBeNull());
    const renamePath = vi.spyOn(p.store, 'renamePath');
    await app.fileManager.renameFile(walden, 'Books/Walden Pond.pdf');
    await waitFor(() => expect(app.vault.getFileByPath('Margin/Walden Pond.md')).not.toBeNull());
    expect(note()).toBeNull();
    expect(await app.vault.read(app.vault.getFileByPath('Margin/Walden Pond.md')!)).toContain('> Simplify');
    await sleep(30);
    expect(renamePath.mock.calls).toEqual([['Books/Walden.pdf', 'Books/Walden Pond.pdf']]);
  });

  it('a note edited in the vault is kept in a copy, with a notice, when Margin rewrites it', async () => {
    const p = await setup();
    await highlight(p);
    await waitFor(() => expect(note()).not.toBeNull());
    await app.vault.modify(note()!, 'my own words');
    await highlight(p, 'Later');
    await waitFor(async () => expect(await app.vault.read(note()!)).toContain('> Later'));
    const copy = app.vault.getFiles().find((f) => f.path.startsWith('Margin/Walden (edited '));
    expect(copy).toBeDefined();
    expect(await app.vault.read(copy!)).toBe('my own words');
    expect(Notice.messages.filter((m) => m.includes(copy!.basename))).toHaveLength(1);
  });

  /** The note exists and a change is pending (60 s away), so the next write replaces it through vault.process. */
  async function pendingReplace(p: MarginPlugin) {
    const id = p.store.bookIdForPath('Books/Walden.pdf')!;
    await highlight(p);
    await p.scheduler.flush(id);
    expect(note()).not.toBeNull();
    await highlight(p, 'Stuck');
    const stuck = vi.fn(() => new Promise<string>(() => {}));
    app.vault.process = stuck;
    return stuck;
  }

  /** Resolves `p`'s settling into a flag, so fake time can be advanced and the flag read in between. */
  const track = (p: Promise<unknown>) => {
    const state = { settled: false };
    void p.then(() => (state.settled = true));
    return state;
  };

  it('a stuck note write with the view open is waited for once at unload: one bound, under the handoff cap', async () => {
    const p = await setup({}, 60_000);
    const bound = 300;
    p.mirrorFlushTimeoutMs = bound;
    const stuck = await pendingReplace(p);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Fake time from here: the bound is measured exactly, whatever the machine's load. Waiting twice
    // (the view's host.closed, then the tail's flushAll, each a full bound) would settle at 2 × bound.
    vi.useFakeTimers();
    try {
      p.unload();
      plugin = null;
      const unloading = track(p.unloading);
      await vi.advanceTimersByTimeAsync(bound - 1);
      expect(unloading.settled).toBe(false);
      // The store's own timers (its write coalescing) fit well inside half a bound.
      await vi.advanceTimersByTimeAsync(bound / 2);
      expect(unloading.settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    // The released view's host.closed started the write; the tail's flushAll only had what was left.
    expect(stuck).toHaveBeenCalledTimes(1);
    expect(MIRROR_FLUSH_TIMEOUT_MS).toBeLessThanOrEqual(HANDOFF_TIMEOUT_MS / 2);
    expect(backend()).toBe(tauriBackend);
    error.mockRestore();
  });

  it('a stuck note write with the view open holds the quit task for one bound', async () => {
    const p = await setup({}, 60_000);
    const bound = 300;
    p.mirrorFlushTimeoutMs = bound;
    await pendingReplace(p);
    vi.useFakeTimers();
    try {
      const tasks = new Tasks();
      app.workspace.trigger('quit', tasks);
      const quitting = track(tasks.run());
      await vi.advanceTimersByTimeAsync(bound - 1);
      expect(quitting.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(bound / 2);
      expect(quitting.settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('turning notes on writes them now; a new folder moves them now (open books and books on record)', async () => {
    const p = await setup({ mirrorEnabled: false });
    await highlight(p);
    await sleep(30);
    expect(note()).toBeNull();
    p.settings.mirrorEnabled = true;
    await p.saveSettings();
    // Not on record yet: the open view names the book.
    await waitFor(() => expect(note()).not.toBeNull());
    await closeView();
    p.settings.mirrorFolder = 'Reading';
    await p.saveSettings();
    // No view open now: mirrors.json names it.
    await waitFor(() => expect(app.vault.getFileByPath('Reading/Walden.md')).not.toBeNull());
    expect(note()).toBeNull();
    expect(await app.vault.read(app.vault.getFileByPath('Reading/Walden.md')!)).toContain('> Simplify');
  });

  it('a changed setting that does not touch the notes rewrites nothing', async () => {
    const p = await setup();
    await sleep(50);
    const touch = vi.spyOn(p.scheduler, 'touch');
    p.settings.openPdfsInMargin = true;
    await p.saveSettings();
    await sleep(20);
    expect(touch).not.toHaveBeenCalled();
  });

  it('a mirror folder from data.json that the settings tab would refuse falls back to the default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const bad of ['.obsidian/plugins', 'Notes/.private', 42]) {
      const p = await setup({ mirrorFolder: bad });
      expect(p.settings.mirrorFolder).toBe('Margin');
      await highlight(p);
      await waitFor(() => expect(note()).not.toBeNull());
      p.unload();
      await p.unloading;
      await app.workspace.viewsClosing;
      plugin = null;
      document.body.replaceChildren();
    }
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    const p = await setup({ mirrorFolder: 'Reading' });
    expect(p.settings.mirrorFolder).toBe('Reading');
  });

  it('a folder change skips notes on record for books the store no longer has, without errors', async () => {
    const p = await setup();
    await highlight(p);
    await waitFor(() => expect(note()).not.toBeNull());
    // A note on record whose book is gone from the store (its file was removed outside Obsidian).
    await p.mirrors.write('gone-book', 'Margin/Gone.md', 'old note');
    const error = vi.spyOn(console, 'error');
    const run = vi.spyOn(p, 'writeMirror');
    p.settings.mirrorFolder = 'Reading';
    await p.saveSettings();
    await waitFor(() => expect(app.vault.getFileByPath('Reading/Walden.md')).not.toBeNull());
    await sleep(30);
    expect(run.mock.calls.map(([id]) => id)).not.toContain('gone-book');
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('a hand edit made while reading survives a position save; the next real change keeps it in a copy', async () => {
    const p = await setup({}, 60_000);
    const id = p.store.bookIdForPath('Books/Walden.pdf')!;
    await highlight(p);
    await p.scheduler.flush(id);
    await app.vault.modify(note()!, 'typing in a split pane');
    // A reading-position save: the store changes, the generated note does not.
    await backend().setLastLocation(id, pdfLocation({ page: 2, start: 0, end: 0 }));
    await p.scheduler.flush(id);
    // Reading forward: each new furthest page changes the note's margin-progress only.
    const modify = vi.spyOn(app.vault, 'modify');
    const process = vi.spyOn(app.vault, 'process');
    for (const progress of [0.2, 0.35, 0.5, 0.8]) {
      await backend().setBookProgress(id, progress);
      await p.scheduler.flush(id);
    }
    expect(p.store.peek(id)?.book.progress).toBe(0.8);
    expect(modify).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
    expect(await app.vault.read(note()!)).toBe('typing in a split pane');
    expect(app.vault.getFiles().some((f) => f.path.startsWith('Margin/Walden (edited '))).toBe(false);
    expect(Notice.messages).toEqual([]);
    await backend().createThought({ bookId: id, body: 'A new thought' });
    await p.scheduler.flush(id);
    const md = await app.vault.read(note()!);
    expect(md).toContain('A new thought');
    expect(md).toContain('margin-progress: 0.8');
    const copy = app.vault.getFiles().find((f) => f.path.startsWith('Margin/Walden (edited '));
    expect(await app.vault.read(copy!)).toBe('typing in a split pane');
  });

  it('an untouched note follows progress only when Margin has real news; then without a copy', async () => {
    const p = await setup({}, 60_000);
    const id = p.store.bookIdForPath('Books/Walden.pdf')!;
    await highlight(p);
    await p.scheduler.flush(id);
    const first = await app.vault.read(note()!);
    await backend().setBookProgress(id, 0.4);
    await p.scheduler.flush(id);
    expect(await app.vault.read(note()!)).toBe(first);
    await backend().createThought({ bookId: id, body: 'A new thought' });
    await p.scheduler.flush(id);
    expect(await app.vault.read(note()!)).toContain('margin-progress: 0.4');
    expect(app.vault.getFiles().some((f) => f.path.startsWith('Margin/Walden (edited '))).toBe(false);
    expect(Notice.messages).toEqual([]);
  });

  it('deleting a PDF forgets its cached outline', async () => {
    const p = await setup();
    const id = p.store.bookIdForPath('Books/Walden.pdf')!;
    const forget = vi.spyOn(p.outlines, 'forget');
    await app.vault.delete(walden);
    await waitFor(() => expect(forget).toHaveBeenCalledWith(id));
  });
});
