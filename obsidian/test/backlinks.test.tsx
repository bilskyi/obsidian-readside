import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderers/pdf/PdfRenderer', async () => ({ PdfRenderer: (await import('./fakeRenderer')).FakePdfRenderer }));

import { Tasks, type App, type TFile } from 'obsidian';
import type { Backlink } from '../../src/features/marginalia/backlinks';
import * as bodySaves from '../../src/features/notebook/bodySaves';
import { backend, setBackend } from '../../src/lib/backend';
import { pdfLocation, pdfPoint, serializeLocation } from '../../src/lib/location';
import { epubPoint } from '../../src/lib/location';
import { BacklinkIndex, marginUrlsIn, pageFromSubpath, snippetOf, splitLinktext } from '../src/backlinks';
import { buildObsidianUrl, markdownLink } from '../src/links';
import MarginPlugin from '../src/main';
import { MarginView, VIEW_TYPE } from '../src/view/MarginView';
import { makeApp, manifest, pdfBytes, tick } from './helpers';

const pos = (line: number, col = 0) => ({ start: { line, col, offset: 0 }, end: { line, col: col + 1, offset: 0 } });
const page = (n: number) => pdfLocation({ page: n, start: 0, end: 0 });

async function note(app: App, path: string, text: string): Promise<TFile> {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  if (dir && !app.vault.getFolderByPath(dir)) await app.vault.createFolder(dir);
  return app.vault.create(path, text);
}

describe('link parsing', () => {
  it('reads #page=N, and nothing else, as a page', () => {
    expect(pageFromSubpath('#page=42')).toBe(42);
    expect(pageFromSubpath('#page=3&zoom=50')).toBe(3);
    expect(pageFromSubpath('#page=0')).toBeNull();
    expect(pageFromSubpath('#Heading')).toBeNull();
    expect(pageFromSubpath('')).toBeNull();
    expect(splitLinktext('My%20Book.pdf#page=2')).toEqual({ path: 'My Book.pdf', subpath: '#page=2' });
    expect(splitLinktext('Book.pdf')).toEqual({ path: 'Book.pdf', subpath: '' });
  });

  it('finds the links Copy Link writes (links.ts), with their file, place and line', () => {
    const loc = pdfPoint(7, 120, 0.25);
    const text = [
      '# Reading',
      `- ${markdownLink('Books/Walden (1854).pdf', loc, 'Simplicity, simplicity')} worth rereading`,
      `bare ${buildObsidianUrl('Books/Other.pdf', page(2))} and <${buildObsidianUrl('Books/Other.pdf', page(3))}>`,
      `no place: ${buildObsidianUrl('Books/Other.pdf', null)}, bad: obsidian://margin?file=x&loc=%7Bnope`,
    ].join('\n');
    const hits = marginUrlsIn(text);
    expect(hits.map((h) => [h.file, h.location, h.line])).toEqual([
      ['Books/Walden (1854).pdf', loc, 1],
      ['Books/Other.pdf', page(2), 2],
      ['Books/Other.pdf', page(3), 2],
    ]);
    expect(hits[0].snippet).toBe('p. 7 · “Simplicity, simplicity” worth rereading');
    expect(marginUrlsIn('nothing here')).toEqual([]);
  });

  it('makes a note line readable', () => {
    expect(snippetOf('  > - [ ] See [[Books/Walden.pdf#page=4|the pond]] and [[Walden.pdf#page=9]]')).toBe('See the pond and Walden, page 9');
    expect(snippetOf('1. [chapter](Walden.pdf#page=2)')).toBe('chapter');
    expect(Array.from(snippetOf('x'.repeat(300))).length).toBe(141);
  });
});

describe('BacklinkIndex', () => {
  async function vault() {
    const app = makeApp();
    const pdf = app.vault.addBinary('Books/Walden.pdf', pdfBytes('walden'));
    app.vault.addBinary('Books/Other.pdf', pdfBytes('other'));
    return { app, pdf };
  }

  it('collects page links (wiki, Markdown, embeds) and Margin URLs, and nothing that points elsewhere', async () => {
    const { app, pdf } = await vault();
    await note(app, 'Reading log.md', 'Intro\n- Loved [[Walden.pdf#page=4]]\n![[Books/Walden.pdf#page=9]]\n[x](Books/Walden.pdf#page=12)');
    app.metadataCache.setCache('Reading log.md', {
      links: [
        { link: 'Walden.pdf#page=4', original: '[[Walden.pdf#page=4]]', position: pos(1, 8) },
        { link: 'Books/Walden.pdf#page=12', original: '[x](Books/Walden.pdf#page=12)', position: pos(3) },
      ],
      embeds: [{ link: 'Books/Walden.pdf#page=9', original: '![[Books/Walden.pdf#page=9]]', position: pos(2) }],
    });
    // Links the PDF but no page, and a page of another PDF: neither counts.
    await note(app, 'Other.md', '[[Walden.pdf]] and [[Other.pdf#page=2]]');
    app.metadataCache.setCache('Other.md', {
      links: [
        { link: 'Walden.pdf', original: '[[Walden.pdf]]', position: pos(0) },
        { link: 'Other.pdf#page=2', original: '[[Other.pdf#page=2]]', position: pos(0, 19) },
      ],
    });
    const loc = pdfPoint(3, 50, 0.4);
    await note(app, 'Quotes.md', `A\nB ${markdownLink('Books/Walden.pdf', loc, 'Morning air')}\n${markdownLink('Books/Other.pdf', loc, 'x')}`);

    const links = await new Promise<Backlink[]>((resolve) => new BacklinkIndex(app).watch(pdf, resolve));
    expect(links.map((l) => [l.sourcePath, l.location, l.line, l.snippet])).toEqual([
      ['Quotes.md', loc, 1, 'B p. 3 · “Morning air”'],
      ['Reading log.md', page(4), 1, 'Loved Walden, page 4'],
      ['Reading log.md', page(9), 2, 'Books/Walden, page 9'],
      ['Reading log.md', page(12), 3, 'x'],
    ]);
    expect(links[0].sourceTitle).toBe('Quotes');
  });

  it('a book nothing links to gets an empty list, and its refreshes read nothing again', async () => {
    const { app, pdf } = await vault();
    await note(app, 'A.md', 'plain');
    const onChange = vi.fn();
    const index = new BacklinkIndex(app, { delayMs: 10 });
    index.watch(pdf, onChange);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([]));
    const reads = app.vault.cachedReads.get('A.md');
    index.resolved();
    await new Promise((r) => setTimeout(r, 30));
    expect(app.vault.cachedReads.get('A.md')).toBe(reads);
    expect(onChange).toHaveBeenCalledTimes(1); // unchanged: not said again
  });

  it('a changed note is rescanned from the text the event carries, debounced, and the watcher hears the new list', async () => {
    vi.useFakeTimers();
    try {
      const { app, pdf } = await vault();
      const file = await note(app, 'A.md', 'plain');
      const onChange = vi.fn();
      const index = new BacklinkIndex(app, { delayMs: 400 });
      index.watch(pdf, onChange);
      await vi.advanceTimersByTimeAsync(0);
      expect(onChange).toHaveBeenLastCalledWith([]);
      const reads = app.vault.cachedReads.get('A.md');
      const text = `now ${buildObsidianUrl('Books/Walden.pdf', page(5))}`;
      index.changed(file, text);
      index.changed(file, text);
      await vi.advanceTimersByTimeAsync(399);
      expect(onChange).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange.mock.calls[1][0].map((l: Backlink) => l.location)).toEqual([page(5)]);
      expect(app.vault.cachedReads.get('A.md')).toBe(reads);
      // Deleted: gone again.
      index.deleted(file);
      await vi.advanceTimersByTimeAsync(400);
      expect(onChange).toHaveBeenLastCalledWith([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the scan is bounded: notes past the file limit are not read', async () => {
    const { app, pdf } = await vault();
    const url = buildObsidianUrl('Books/Walden.pdf', page(2));
    for (const n of ['A', 'B', 'C']) await note(app, `${n}.md`, url);
    const links = await new Promise<Backlink[]>((resolve) => new BacklinkIndex(app, { maxFiles: 2 }).watch(pdf, resolve));
    expect(links.map((l) => l.sourcePath)).toEqual(['A.md', 'B.md']);
    expect(app.vault.cachedReads.has('C.md')).toBe(false);
  });

  it('the scan is bounded: notes over the size limit are not read', async () => {
    const { app, pdf } = await vault();
    const url = buildObsidianUrl('Books/Walden.pdf', page(2));
    for (const n of ['A', 'B', 'C']) await note(app, `${n}.md`, url);
    app.vault.getFileByPath('B.md')!.stat.size = 10_000;
    const links = await new Promise<Backlink[]>((resolve) => new BacklinkIndex(app, { maxBytes: 5000 }).watch(pdf, resolve));
    expect(links.map((l) => l.sourcePath)).toEqual(['A.md', 'C.md']);
    expect(app.vault.cachedReads.has('B.md')).toBe(false);
  });

  it('stopping a watch, or disposing the index, silences it', async () => {
    vi.useFakeTimers();
    try {
      const { app, pdf } = await vault();
      const file = await note(app, 'A.md', '');
      const index = new BacklinkIndex(app, { delayMs: 10 });
      const a = vi.fn();
      const b = vi.fn();
      const stopA = index.watch(pdf, a);
      index.watch(pdf, b);
      await vi.advanceTimersByTimeAsync(0);
      stopA();
      index.changed(file, buildObsidianUrl('Books/Walden.pdf', page(1)));
      await vi.advanceTimersByTimeAsync(10);
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(2);
      index.dispose();
      index.changed(file, '');
      await vi.advanceTimersByTimeAsync(50);
      expect(b).toHaveBeenCalledTimes(2);
      const late = vi.fn();
      index.watch(pdf, late);
      await vi.advanceTimersByTimeAsync(50);
      expect(late).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BacklinkIndex: ordering, big vaults and idle cost', () => {
  async function vault() {
    const app = makeApp();
    const pdf = app.vault.addBinary('Books/Walden.pdf', pdfBytes('walden'));
    return { app, pdf };
  }
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };

  it('a slower, older refresh never overwrites a newer one', async () => {
    const { app, pdf } = await vault();
    const pond = await note(app, 'Pond.md', 'old line [[Walden.pdf#page=3]]');
    app.metadataCache.setCache('Pond.md', { links: [{ link: 'Walden.pdf#page=3', original: '[[Walden.pdf#page=3]]', position: pos(0) }] });
    const held = deferred<string>();
    const read = app.vault.cachedRead.bind(app.vault);
    let calls = 0;
    // Read 1: the scan. Read 2: the first refresh's collect, held. Later reads: as usual.
    app.vault.cachedRead = async (f) => (f === pond && ++calls === 2 ? held.promise : read(f));
    const onChange = vi.fn();
    const index = new BacklinkIndex(app, { delayMs: 0 });
    index.watch(pdf, onChange);
    await waitFor(() => expect(calls).toBe(2));
    await app.vault.adapter.write('Pond.md', 'new line [[Walden.pdf#page=3]]');
    index.resolved();
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0][0][0].snippet).toBe('new line Walden, page 3');
    held.resolve('old line [[Walden.pdf#page=3]]');
    await tick();
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('past the file cap the most recently changed notes are read, and the cap is said once', async () => {
    const { app, pdf } = await vault();
    const url = buildObsidianUrl('Books/Walden.pdf', page(2));
    for (const [n, mtime] of [['A', 1], ['B', 3], ['C', 2]] as const) (await note(app, `${n}.md`, url)).stat.mtime = mtime;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const index = new BacklinkIndex(app, { maxFiles: 2, delayMs: 0 });
      const onChange = vi.fn();
      index.watch(pdf, onChange);
      await waitFor(() => expect(onChange).toHaveBeenCalled());
      expect(onChange.mock.calls[0][0].map((l: Backlink) => l.sourcePath)).toEqual(['B.md', 'C.md']);
      expect(app.vault.cachedReads.has('A.md')).toBe(false);
      index.watch(pdf, vi.fn());
      index.resolved();
      await tick();
      await tick();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('2 most recently changed');
    } finally {
      warn.mockRestore();
    }
  });

  it('notes are sorted by mtime on the first scan only; later passes just skip what is unchanged', async () => {
    const { app, pdf } = await vault();
    const url = buildObsidianUrl('Books/Walden.pdf', page(2));
    for (const n of ['A', 'B', 'C']) await note(app, `${n}.md`, url);
    const noteSorts = vi.fn();
    const realSort = Array.prototype.sort;
    const spy = vi.spyOn(Array.prototype, 'sort').mockImplementation(function (this: unknown[], ...args: [((a: never, b: never) => number)?]) {
      if (this.length && (this[0] as { stat?: unknown }).stat) noteSorts();
      return realSort.apply(this, args);
    });
    try {
      const index = new BacklinkIndex(app, { delayMs: 0 });
      const onChange = vi.fn();
      index.watch(pdf, onChange);
      await waitFor(() => expect(onChange).toHaveBeenCalled());
      expect(noteSorts).toHaveBeenCalledTimes(1);
      // A later pass (a new note, so it has something to read) does not sort again.
      await note(app, 'D.md', url);
      index.watch(pdf, vi.fn());
      index.resolved();
      await waitFor(() => expect(app.vault.cachedReads.has('D.md')).toBe(true));
      await tick();
      expect(noteSorts).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('the first scan stops once nothing watches any more', async () => {
    const { app, pdf } = await vault();
    for (const n of ['A', 'B', 'C']) await note(app, `${n}.md`, 'plain');
    const held = deferred<string>();
    const read = app.vault.cachedRead.bind(app.vault);
    app.vault.cachedRead = async (f) => {
      app.vault.cachedReads.set(f.path, (app.vault.cachedReads.get(f.path) ?? 0) + 1);
      return f.path === 'A.md' ? held.promise : read(f);
    };
    const index = new BacklinkIndex(app);
    const stop = index.watch(pdf, vi.fn());
    stop();
    held.resolve('plain');
    await tick();
    await tick();
    expect([...app.vault.cachedReads.keys()]).toEqual(['A.md']);
  });

  it('with nothing watched, a changed note is not parsed: its entry goes, and the next watch reads it from disk', async () => {
    const { app, pdf } = await vault();
    const a = await note(app, 'A.md', 'plain');
    const index = new BacklinkIndex(app, { delayMs: 0 });
    const first = vi.fn();
    const stop = index.watch(pdf, first);
    await waitFor(() => expect(first).toHaveBeenCalledWith([]));
    stop();
    const reads = app.vault.cachedReads.get('A.md');
    // The event's text is not what is on disk (so a parse of it would show).
    index.changed(a, buildObsidianUrl('Books/Walden.pdf', page(2)));
    const second = vi.fn();
    index.watch(pdf, second);
    await waitFor(() => expect(second).toHaveBeenCalled());
    expect(second).toHaveBeenLastCalledWith([]);
    expect(app.vault.cachedReads.get('A.md')).toBe(reads! + 1);
  });

  it('a Margin URL names its book loosely (a leading slash, doubled slashes) or with &amp;: it still counts', async () => {
    const { app, pdf } = await vault();
    const loc = encodeURIComponent(serializeLocation(page(4)));
    await note(app, 'A.md', `x obsidian://margin?file=%2FBooks%2F%2FWalden.pdf&loc=${loc}`);
    await note(app, 'B.md', `y obsidian://margin?file=Books%2FWalden.pdf&amp;loc=${loc}`);
    const links = await new Promise<Backlink[]>((resolve) => new BacklinkIndex(app).watch(pdf, resolve));
    expect(links.map((l) => [l.sourcePath, l.location])).toEqual([
      ['A.md', page(4)],
      ['B.md', page(4)],
    ]);
  });
});

describe('backlinks in the plugin', () => {
  let app: App;
  let plugin: MarginPlugin | null = null;

  async function setup() {
    app = makeApp();
    app.vault.addBinary('Books/Walden.pdf', pdfBytes('walden'));
    await note(app, 'Notes/Reading.md', `Today ${buildObsidianUrl('Books/Walden.pdf', page(2))}`);
    await note(app, 'Notes/Pond.md', '- [[Walden.pdf#page=3]]');
    app.metadataCache.setCache('Notes/Pond.md', { links: [{ link: 'Walden.pdf#page=3', original: '[[Walden.pdf#page=3]]', position: pos(0, 2) }] });
    plugin = new MarginPlugin(app, manifest);
    await plugin.onload();
    await plugin.ready;
  }
  async function openWalden(): Promise<MarginView> {
    const leaf = app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: 'Books/Walden.pdf' }, active: true });
    await screen.findByRole('heading', { name: 'Walden' });
    return leaf.view as MarginView;
  }
  const toggleNotebook = (view: MarginView) =>
    fireEvent.keyDown(view.contentEl.querySelector('.margin-app')!, { key: '\\', metaKey: true });

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
    // The notebook remembers being open; each test starts from closed.
    localStorage.clear();
  });

  it('the notebook header says how many notes link into the open book, and follows the vault', async () => {
    await setup();
    const view = await openWalden();
    toggleNotebook(view);
    await waitFor(() => expect(screen.getByRole('complementary', { name: 'Notebook' }).textContent).toContain('2 notes link here'));
    // A third note links in: metadataCache `changed`, then the debounced refresh.
    vi.useFakeTimers();
    try {
      const third = await note(app, 'Notes/Third.md', '');
      app.metadataCache.trigger('changed', third, buildObsidianUrl('Books/Walden.pdf', page(4)), {});
      await act(async () => vi.advanceTimersByTimeAsync(1000));
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(screen.getByRole('complementary', { name: 'Notebook' }).textContent).toContain('3 notes link here'));
  });

  it('a book no note links to says nothing about links', async () => {
    await setup();
    app.metadataCache.setCache('Notes/Pond.md', {});
    await app.vault.modify(app.vault.getFileByPath('Notes/Reading.md')!, 'nothing');
    const view = await openWalden();
    toggleNotebook(view);
    await screen.findByRole('complementary', { name: 'Notebook' });
    await tick();
    await tick();
    expect(document.querySelector('.notebook-linked')).toBeNull();
  });

  it('the view watches while its book is mounted and stops on close, file switch and unload', async () => {
    await setup();
    const watch = vi.spyOn(plugin!.host, 'watchBacklinks');
    const stops: ReturnType<typeof vi.fn>[] = [];
    watch.mockImplementation((_file, _onChange) => {
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    });
    const view = await openWalden();
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch.mock.calls[0][0].path).toBe('Books/Walden.pdf');
    await view.leaf.detach();
    expect(stops[0]).toHaveBeenCalledTimes(1);
    const second = await openWalden();
    expect(watch).toHaveBeenCalledTimes(2);
    plugin!.unload();
    await plugin!.unloading;
    expect(stops[1]).toHaveBeenCalledTimes(1);
    expect(second.contentEl.querySelector('.margin-app')).toBeNull();
    plugin = null;
  });

  it('a list for the previous file that arrives after a switch is ignored', async () => {
    await setup();
    app.vault.addBinary('Books/Other.pdf', pdfBytes('other'));
    const watchers: ((links: Backlink[]) => void)[] = [];
    vi.spyOn(plugin!.host, 'watchBacklinks').mockImplementation((_f, onChange) => {
      watchers.push(onChange);
      return () => {};
    });
    const view = await openWalden();
    toggleNotebook(view);
    await screen.findByRole('complementary', { name: 'Notebook' });
    await view.leaf.setViewState({ type: VIEW_TYPE, state: { file: 'Books/Other.pdf' }, active: true });
    await screen.findByRole('heading', { name: 'Other' });
    expect(watchers).toHaveLength(2);
    act(() => watchers[0]([{ id: 'x', location: page(1), sourcePath: 'Notes/Pond.md', sourceTitle: 'Pond', snippet: '' }]));
    await tick();
    expect(document.querySelector('.notebook-linked')).toBeNull();
    act(() => watchers[1]([{ id: 'y', location: page(1), sourcePath: 'Notes/Pond.md', sourceTitle: 'Pond', snippet: '' }]));
    expect(document.querySelector('.notebook-linked')?.textContent).toContain('1 note links here');
  });

  it('quitting releases the views, and with them their watches', async () => {
    await setup();
    const stop = vi.fn();
    vi.spyOn(plugin!.host, 'watchBacklinks').mockImplementation(() => stop);
    await openWalden();
    const tasks = new Tasks();
    app.workspace.trigger('quit', tasks);
    await tasks.run();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('opening a linking note: a split beside the reader, reused on later clicks, at the link’s line', async () => {
    await setup();
    const reader = await openWalden();
    const link: Backlink = { id: 'x', location: page(3), sourcePath: 'Notes/Pond.md', sourceTitle: 'Pond', snippet: '', line: 4 };
    const getLeaf = vi.spyOn(app.workspace, 'getLeaf');
    const createSplit = vi.spyOn(app.workspace, 'createLeafBySplit');
    plugin!.host.openBacklink!(reader, link, false);
    expect(createSplit).toHaveBeenLastCalledWith(reader.leaf, 'vertical');
    expect(getLeaf).not.toHaveBeenCalled();
    const split = createSplit.mock.results.at(-1)!.value;
    expect(split).not.toBe(reader.leaf);
    await tick();
    expect(split.openedFile?.path).toBe('Notes/Pond.md');
    expect(split.openedState).toEqual({ eState: { line: 4 } });
    expect(reader.leaf.view).toBe(reader); // the reader stays
    // Again: the same split, no new leaf.
    plugin!.host.openBacklink!(reader, { ...link, sourcePath: 'Notes/Reading.md', line: 0 }, false);
    expect(createSplit).toHaveBeenCalledTimes(1);
    await tick();
    expect(split.openedFile?.path).toBe('Notes/Reading.md');
    // The split was closed: a new one.
    await split.detach();
    plugin!.host.openBacklink!(reader, link, false);
    expect(createSplit).toHaveBeenCalledTimes(2);
    expect(createSplit.mock.results.at(-1)!.value).not.toBe(split);
  });

  it('the split is made from the reader’s own leaf, even when another leaf is active', async () => {
    await setup();
    const reader = await openWalden();
    const other = app.workspace.getLeaf(true);
    app.workspace.setActiveLeaf(other);
    const link: Backlink = { id: 'x', location: page(3), sourcePath: 'Notes/Pond.md', sourceTitle: 'Pond', snippet: '' };
    plugin!.host.openBacklink!(reader, link, false);
    expect(app.workspace.splits).toEqual([{ of: reader.leaf, direction: 'vertical' }]);
  });

  it('a kept split that has been pinned is not reused', async () => {
    await setup();
    const reader = await openWalden();
    const link: Backlink = { id: 'x', location: page(3), sourcePath: 'Notes/Pond.md', sourceTitle: 'Pond', snippet: '' };
    const createSplit = vi.spyOn(app.workspace, 'createLeafBySplit');
    plugin!.host.openBacklink!(reader, link, false);
    const split = createSplit.mock.results.at(-1)!.value;
    split.pinned = true;
    plugin!.host.openBacklink!(reader, link, false);
    expect(createSplit).toHaveBeenCalledTimes(2);
    const fresh = createSplit.mock.results.at(-1)!.value;
    expect(fresh).not.toBe(split);
    await tick();
    expect(fresh.openedFile?.path).toBe('Notes/Pond.md');
    // Unpinned again, the new one (now kept) is reused.
    plugin!.host.openBacklink!(reader, link, false);
    expect(createSplit).toHaveBeenCalledTimes(2);
  });

  it('⌘/Ctrl or a middle click: a new tab, and the split is left alone', async () => {
    await setup();
    const reader = await openWalden();
    const link: Backlink = { id: 'x', location: page(3), sourcePath: 'Notes/Pond.md', sourceTitle: 'Pond', snippet: '', line: 4 };
    const getLeaf = vi.spyOn(app.workspace, 'getLeaf');
    const createSplit = vi.spyOn(app.workspace, 'createLeafBySplit');
    plugin!.host.openBacklink!(reader, link, false);
    const split = createSplit.mock.results.at(-1)!.value;
    await tick();
    plugin!.host.openBacklink!(reader, { ...link, sourcePath: 'Notes/Reading.md' }, true);
    expect(getLeaf).toHaveBeenLastCalledWith('tab');
    const tab = getLeaf.mock.results.at(-1)!.value;
    expect(tab).not.toBe(split);
    await tick();
    expect(tab.openedFile?.path).toBe('Notes/Reading.md');
    expect(split.openedFile?.path).toBe('Notes/Pond.md');
    // A note deleted meanwhile: nothing opens.
    plugin!.host.openBacklink!(reader, { ...link, sourcePath: 'Gone.md' }, true);
    expect(getLeaf).toHaveBeenCalledTimes(1);
    expect(createSplit).toHaveBeenCalledTimes(1);
  });

  it('a split that has become a Margin reader is not reused', async () => {
    await setup();
    const reader = await openWalden();
    const link: Backlink = { id: 'x', location: page(3), sourcePath: 'Notes/Pond.md', sourceTitle: 'Pond', snippet: '' };
    const createSplit = vi.spyOn(app.workspace, 'createLeafBySplit');
    plugin!.host.openBacklink!(reader, link, false);
    const split = createSplit.mock.results.at(-1)!.value;
    await split.setViewState({ type: VIEW_TYPE, state: { file: 'Books/Walden.pdf' } });
    plugin!.host.openBacklink!(reader, link, false);
    expect(createSplit).toHaveBeenCalledTimes(2);
    expect(createSplit.mock.results.at(-1)!.value).not.toBe(split);
  });

  it('hovering a linking note asks Obsidian’s page preview for it, as a registered hover source', async () => {
    await setup();
    const view = await openWalden();
    expect(plugin!.hoverLinkSources.get(VIEW_TYPE)).toEqual({ display: 'Margin', defaultMod: true });
    const hover = vi.fn();
    app.workspace.on('hover-link', hover);
    const link: Backlink = { id: 'x', location: page(3), sourcePath: 'Notes/Pond.md', sourceTitle: 'Pond', snippet: '' };
    const event = new MouseEvent('mouseover');
    const targetEl = document.createElement('button');
    plugin!.host.hoverBacklink!(view, link, event, targetEl);
    expect(hover).toHaveBeenCalledWith({
      event,
      source: VIEW_TYPE,
      hoverParent: view,
      targetEl,
      linktext: 'Notes/Pond.md',
      sourcePath: 'Notes/Pond.md',
      state: undefined,
    });
    expect(view.hoverPopover).toBeNull();
  });

  it('the hover preview scrolls to the link’s line', async () => {
    await setup();
    const view = await openWalden();
    const hover = vi.fn();
    app.workspace.on('hover-link', hover);
    const link: Backlink = { id: 'x', location: page(3), sourcePath: 'Notes/Pond.md', sourceTitle: 'Pond', snippet: '', line: 7 };
    plugin!.host.hoverBacklink!(view, link, new MouseEvent('mouseover'), document.createElement('button'));
    expect(hover.mock.calls[0][0].state).toEqual({ scroll: 7 });
    plugin!.host.hoverBacklink!(view, { ...link, line: 0 }, new MouseEvent('mouseover'), document.createElement('button'));
    expect(hover.mock.calls[1][0].state).toEqual({ scroll: 0 });
  });

  it('the book’s own notebook note never counts, though it links every highlight and thought', async () => {
    await setup();
    // Only Margin's note links in to start with.
    app.metadataCache.setCache('Notes/Pond.md', {});
    await app.vault.modify(app.vault.getFileByPath('Notes/Reading.md')!, 'nothing');
    plugin!.mirrorDelayMs = 10;
    const view = await openWalden();
    const bookId = plugin!.store.bookIdForPath('Books/Walden.pdf')!;
    await backend().createAnnotation({ bookId, location: pdfLocation({ page: 2, start: 0, end: 5 }), quote: 'Hello', color: 'yellow' });
    const t = await backend().createThought({ bookId });
    await backend().updateThought(t.id, { body: 'see [[Walden.pdf#page=3]]', location: serializeLocation(page(3)) });
    await view.leaf.detach();
    const mirror = app.vault.getFileByPath('Margin/Walden.md')!;
    const md = await app.vault.read(mirror);
    expect(md).toContain('obsidian://margin?');
    expect(md).toContain('[[Walden.pdf#page=3]]');
    const line = md.split('\n').findIndex((l) => l.includes('[[Walden.pdf#page=3]]'));
    // Obsidian indexes it like any note: its page link resolves to the book.
    app.metadataCache.setCache('Margin/Walden.md', { links: [{ link: 'Walden.pdf#page=3', original: '[[Walden.pdf#page=3]]', position: pos(line) }] });
    const pdf = app.vault.getFileByPath('Books/Walden.pdf')!;
    const again = await openWalden();
    toggleNotebook(again);
    await screen.findByRole('complementary', { name: 'Notebook' });
    const seen = vi.fn();
    plugin!.backlinks!.watch(pdf, seen);
    await waitFor(() => expect(seen).toHaveBeenCalled());
    expect(seen).toHaveBeenLastCalledWith([]);
    expect(document.querySelector('.notebook-linked')).toBeNull();
    // A note of the user's own that links the book counts.
    const mine = await note(app, 'Notes/Mine.md', '');
    app.metadataCache.trigger('changed', mine, `here ${buildObsidianUrl('Books/Walden.pdf', page(2))}`, {});
    await waitFor(() => expect(document.querySelector('.notebook-linked')?.textContent).toContain('1 note links here'), { timeout: 2000 });
    expect(seen.mock.calls.at(-1)![0].map((l: Backlink) => l.sourcePath)).toEqual(['Notes/Mine.md']);
  });
});

describe('BacklinkIndex: an EPUB (E7)', () => {
  it('collects Margin URLs into the EPUB; a #page=N link into it is not a place and is skipped', async () => {
    const app = makeApp();
    const moby = app.vault.addBinary('Books/Moby.epub', pdfBytes('moby'));
    await note(app, 'Log.md', 'See [[Moby.epub#page=4]]');
    app.metadataCache.setCache('Log.md', { links: [{ link: 'Moby.epub#page=4', original: '[[Moby.epub#page=4]]', position: pos(0, 4) }] });
    const loc = epubPoint(3, 10, 0.2);
    await note(app, 'Quotes.md', `Q ${markdownLink('Books/Moby.epub', loc, 'Call me Ishmael')}`);
    const links = await new Promise<Backlink[]>((resolve) => new BacklinkIndex(app).watch(moby, resolve));
    expect(links.map((l) => [l.sourcePath, l.location, l.snippet])).toEqual([['Quotes.md', loc, 'Q § 3 · “Call me Ishmael”']]);
  });

  it('snippetOf drops an .epub extension as it does .pdf', () => {
    expect(snippetOf('Read [[Books/Moby.epub]] today')).toBe('Read Books/Moby today');
  });
});

describe('BacklinkIndex: a Margin URL for the other format is skipped (final review E-M6)', () => {
  it('an epub place on a PDF, and a page on an EPUB, are not backlinks; matching ones still are', async () => {
    const app = makeApp();
    const pdf = app.vault.addBinary('Books/Walden.pdf', pdfBytes('walden'));
    const moby = app.vault.addBinary('Books/Moby.epub', pdfBytes('moby'));
    await note(app, 'Mixed.md', [
      `a ${buildObsidianUrl('Books/Walden.pdf', epubPoint(3, 0))}`,
      `b ${buildObsidianUrl('Books/Walden.pdf', page(2))}`,
      `c ${buildObsidianUrl('Books/Moby.epub', page(5))}`,
      `d ${buildObsidianUrl('Books/Moby.epub', epubPoint(4, 0))}`,
    ].join('\n'));
    const index = new BacklinkIndex(app);
    const ofPdf = await new Promise<Backlink[]>((resolve) => index.watch(pdf, resolve));
    expect(ofPdf.map((l) => l.location)).toEqual([page(2)]);
    const ofEpub = await new Promise<Backlink[]>((resolve) => new BacklinkIndex(app).watch(moby, resolve));
    expect(ofEpub.map((l) => l.location)).toEqual([epubPoint(4, 0)]);
  });
});
