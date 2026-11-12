import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderers/pdf/PdfRenderer', async () => ({ PdfRenderer: (await import('./fakeRenderer')).FakePdfRenderer }));

import { MemoryAdapter, Notice, __setPdfJs, type App, type TFile } from 'obsidian';
import * as bodySaves from '../../src/features/notebook/bodySaves';
import { appName } from '../../src/lib/appName';
import { backend, setBackend } from '../../src/lib/backend';
import { pdfLocation } from '../../src/lib/location';
import { OPEN_ERROR_MESSAGES } from '../../src/features/reader/openError';
import { IMPORTED_NOTICE, IMPORT_TMP, importLegacyData } from '../src/legacyImport';
import MarginPlugin from '../src/main';
import { makeApp, manifest, pdfBytes, ROOT } from './helpers';

const OLD = '.obsidian/plugins/margin-reader';

/** Every file under `dir`, relative to it, with its contents as text. */
function tree(a: MemoryAdapter, dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, v] of a.files) {
    if (p.startsWith(`${dir}/`)) out[p.slice(dir.length + 1)] = typeof v === 'string' ? v : new TextDecoder().decode(v);
  }
  return out;
}

/** An old Margin folder: the plugin's own files, settings, the index, a book, a cover, a backup, a translation pair. */
function oldInstall(): MemoryAdapter {
  const a = new MemoryAdapter();
  for (const f of ['.obsidian', '.obsidian/plugins', ROOT, OLD, `${OLD}/books`, `${OLD}/covers`, `${OLD}/backups`, `${OLD}/translation`, `${OLD}/translation/models`, `${OLD}/translation/models/en-uk`]) {
    a.folders.add(f);
  }
  a.files.set(`${OLD}/main.js`, 'old code');
  a.files.set(`${OLD}/manifest.json`, '{"id":"margin-reader"}');
  a.files.set(`${OLD}/styles.css`, '.margin-app{}');
  a.files.set(`${OLD}/data.json`, '{"mirrorFolder":"Margin"}');
  a.files.set(`${OLD}/index.json`, '{"version":1,"entries":{}}');
  a.files.set(`${OLD}/mirrors.json`, '{"version":1,"books":{}}');
  a.files.set(`${OLD}/books/b1.json`, '{"version":1,"book":{"title":"Война и мир"}}');
  a.files.set(`${OLD}/covers/b1.webp`, new Uint8Array([0, 255, 7]).buffer);
  a.files.set(`${OLD}/backups/b1-2026-11-01.json`, '{"old":true}');
  a.files.set(`${OLD}/translation/models/en-uk/model.bin`, 'weights');
  // The new folder as Obsidian installs it: only the plugin's own files.
  a.files.set(`${ROOT}/main.js`, 'new code');
  a.files.set(`${ROOT}/manifest.json`, '{"id":"readside"}');
  a.files.set(`${ROOT}/styles.css`, '.margin-app{color:red}');
  return a;
}

const DATA = {
  'data.json': '{"mirrorFolder":"Margin"}',
  'index.json': '{"version":1,"entries":{}}',
  'mirrors.json': '{"version":1,"books":{}}',
  'books/b1.json': '{"version":1,"book":{"title":"Война и мир"}}',
  'covers/b1.webp': new TextDecoder().decode(new Uint8Array([0, 255, 7])),
  'backups/b1-2026-11-01.json': '{"old":true}',
  'translation/models/en-uk/model.bin': 'weights',
};

describe('importLegacyData: the margin-reader folder copied into readside', () => {
  it('copies every data file and folder, not main.js, manifest.json or styles.css; the old folder is untouched', async () => {
    const a = oldInstall();
    const before = tree(a, OLD);
    expect(await importLegacyData(a as never, '.obsidian', ROOT)).toBe(true);
    expect(tree(a, ROOT)).toEqual({ ...DATA, 'main.js': 'new code', 'manifest.json': '{"id":"readside"}', 'styles.css': '.margin-app{color:red}' });
    expect(tree(a, OLD)).toEqual(before);
    expect(a.folders.has(`${ROOT}/${IMPORT_TMP}`)).toBe(false);
    // The cover's bytes came across as they were.
    expect(new Uint8Array(a.files.get(`${ROOT}/covers/b1.webp`) as ArrayBuffer)).toEqual(new Uint8Array([0, 255, 7]));
  });

  it('runs once: with an index.json in the new folder it does nothing, and without an old index.json neither', async () => {
    const a = oldInstall();
    await importLegacyData(a as never, '.obsidian', ROOT);
    a.files.set(`${ROOT}/books/b1.json`, 'changed in Readside');
    a.files.set(`${OLD}/books/b2.json`, 'written by Margin later');
    a.calls.length = 0;
    expect(await importLegacyData(a as never, '.obsidian', ROOT)).toBe(false);
    expect(a.files.get(`${ROOT}/books/b1.json`)).toBe('changed in Readside');
    expect(a.files.has(`${ROOT}/books/b2.json`)).toBe(false);
    expect(a.calls.filter((c) => !c.startsWith('exists '))).toEqual([]);

    const fresh = oldInstall();
    fresh.files.delete(`${OLD}/index.json`);
    expect(await importLegacyData(fresh as never, '.obsidian', ROOT)).toBe(false);
    expect(Object.keys(tree(fresh, ROOT)).sort()).toEqual(['main.js', 'manifest.json', 'styles.css']);
  });

  it('never imports into the old folder itself', async () => {
    const a = oldInstall();
    expect(await importLegacyData(a as never, '.obsidian', OLD)).toBe(false);
  });

  it('cut short before index.json is in place: nothing counts as imported, and the next run finishes it from scratch', async () => {
    const a = oldInstall();
    a.failOn('rename', `${ROOT}/${IMPORT_TMP}/index.json`);
    await expect(importLegacyData(a as never, '.obsidian', ROOT)).rejects.toThrow('rename failed');
    // Some entries were moved into place already; index.json, the mark of a finished import, was not.
    expect(a.files.has(`${ROOT}/index.json`)).toBe(false);
    expect(a.files.has(`${ROOT}/books/b1.json`)).toBe(true);
    expect(a.folders.has(`${ROOT}/${IMPORT_TMP}`)).toBe(true);
    // Something wrote over a half-imported entry meanwhile: the rerun replaces it with the old folder's copy.
    a.files.set(`${ROOT}/books/b1.json`, 'stale');

    expect(await importLegacyData(a as never, '.obsidian', ROOT)).toBe(true);
    expect(tree(a, ROOT)).toEqual({ ...DATA, 'main.js': 'new code', 'manifest.json': '{"id":"readside"}', 'styles.css': '.margin-app{color:red}' });
    expect(a.folders.has(`${ROOT}/${IMPORT_TMP}`)).toBe(false);
  });

  it('cut short while copying: the old folder is untouched and the new one has no index.json', async () => {
    const a = oldInstall();
    const before = tree(a, OLD);
    a.failOn('copy', `${OLD}/covers/b1.webp`);
    await expect(importLegacyData(a as never, '.obsidian', ROOT)).rejects.toThrow('copy failed');
    expect(tree(a, OLD)).toEqual(before);
    expect(a.files.has(`${ROOT}/index.json`)).toBe(false);
    expect(await importLegacyData(a as never, '.obsidian', ROOT)).toBe(true);
    expect(tree(a, ROOT)['index.json']).toBe(DATA['index.json']);
  });
});

// ------------------------------------------------------------------------------------------- the plugin

const fakePdfjs = {
  getDocument: () => ({
    promise: Promise.resolve({ numPages: 3, getOutline: async () => [], getDestination: async () => null, getPageIndex: async () => 0, destroy: async () => {} }),
  }),
};

let app: App;
let plugin: MarginPlugin | null = null;
let walden: TFile;

async function start(id: string, settings: unknown = null): Promise<MarginPlugin> {
  plugin = new MarginPlugin(app, { ...manifest, id });
  plugin.savedData = settings;
  plugin.mirrorDelayMs = 10;
  await plugin.onload();
  await plugin.ready;
  return plugin;
}

async function stop(): Promise<void> {
  if (!plugin) return;
  plugin.unload();
  await plugin.unloading;
  await app.workspace.viewsClosing;
  plugin = null;
  setBackend(null);
  document.body.replaceChildren();
}

function freshApp(): void {
  __setPdfJs(fakePdfjs);
  app = makeApp();
  walden = app.vault.addBinary('Books/Walden.pdf', pdfBytes('walden'));
}

afterEach(async () => {
  await stop();
  bodySaves.resetBodySavesForTests();
});

describe('Readside after Margin: books, notes and the notebook folder come across', () => {
  it('an install of Margin is imported once, with one Notice, and its notebook notes stay in Margin/', async () => {
    freshApp();
    // Margin as it was: id margin-reader, its notes in Margin/.
    const old = await start('margin-reader', { mirrorFolder: 'Margin' });
    await old.openInMargin(walden);
    await screen.findByRole('heading', { name: 'Walden' });
    const bookId = old.store.bookIdForPath('Books/Walden.pdf')!;
    await backend().createAnnotation({ bookId, location: pdfLocation({ page: 1, start: 0, end: 8 }), quote: 'Simplify', color: 'yellow' });
    await waitFor(() => expect(app.vault.getFileByPath('Margin/Walden.md')).not.toBeNull());
    await stop();
    expect(app.vault.adapter.files.has(`${OLD}/index.json`)).toBe(true);

    // Readside: no settings of its own yet (none saved), the data comes from margin-reader.
    Notice.messages.length = 0;
    const p = await start('readside');
    expect(Notice.messages).toEqual([IMPORTED_NOTICE]);
    expect(p.store.bookIdForPath('Books/Walden.pdf')).toBe(bookId);
    expect(await backend().listAnnotations(bookId)).toHaveLength(1);
    expect(p.settings.mirrorFolder).toBe('Margin');
    await stop();

    // Once only.
    Notice.messages.length = 0;
    await start('readside');
    expect(Notice.messages).not.toContain(IMPORTED_NOTICE);
  });

  it('a failed import says so in a sticky Notice and Readside still loads', async () => {
    freshApp();
    const a = app.vault.adapter;
    a.folders.add(OLD);
    a.files.set(`${OLD}/index.json`, '{"version":1,"entries":{}}');
    a.failOn('copy', `${OLD}/index.json`);
    const p = await start('readside');
    expect(Notice.messages.find((m) => m.startsWith("Readside couldn't import your books and notes from Margin"))).toBeTruthy();
    expect(Notice.messages).not.toContain(IMPORTED_NOTICE);
    expect(p.store.isClosed).toBe(false);
  });
});

describe('the notebook notes folder', () => {
  const mirrors = (books: Record<string, unknown>) => app.vault.adapter.files.set(`${ROOT}/mirrors.json`, JSON.stringify({ version: 1, books }));

  it('a new install defaults to Readside/', async () => {
    freshApp();
    const p = await start('readside');
    expect(p.settings.mirrorFolder).toBe('Readside');
  });

  it('an install with notes on record (mirrors.json) and no folder saved keeps Margin/, and saves it', async () => {
    freshApp();
    mirrors({ b1: { path: 'Margin/Walden.md', hash: 'x' } });
    const p = await start('readside', { openPdfsInMargin: true });
    expect(p.settings.mirrorFolder).toBe('Margin');
    expect((p.savedData as { mirrorFolder?: string }).mirrorFolder).toBe('Margin');
  });

  it('an empty or unreadable mirrors.json is no install: Readside/', async () => {
    freshApp();
    mirrors({});
    expect((await start('readside')).settings.mirrorFolder).toBe('Readside');
    await stop();
    freshApp();
    app.vault.adapter.files.set(`${ROOT}/mirrors.json`, '{nope');
    expect((await start('readside')).settings.mirrorFolder).toBe('Readside');
  });

  it('a folder saved in data.json is kept, whatever mirrors.json says', async () => {
    freshApp();
    mirrors({ b1: { path: 'Margin/Walden.md', hash: 'x' } });
    expect((await start('readside', { mirrorFolder: 'Reading/Books' })).settings.mirrorFolder).toBe('Reading/Books');
    await stop();
    freshApp();
    expect((await start('readside', { mirrorFolder: 'Margin' })).settings.mirrorFolder).toBe('Margin');
    await stop();
    freshApp();
    expect((await start('readside', { mirrorFolder: '' })).settings.mirrorFolder).toBe('');
  });
});

describe('the app name in shared reader text', () => {
  it('is Readside once the plugin is loaded (the desktop default is Margin)', () => {
    expect(appName()).toBe('Readside');
    expect(OPEN_ERROR_MESSAGES.other).toBe("Readside couldn't read this PDF; it may be damaged.");
    expect(OPEN_ERROR_MESSAGES.password).toBe("This PDF is password-protected; Readside can't open protected PDFs yet.");
  });
});
