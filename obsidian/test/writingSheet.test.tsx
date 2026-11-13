import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderers/pdf/PdfRenderer', async () => ({ PdfRenderer: (await import('./fakeRenderer')).FakePdfRenderer }));

import { __setPdfJs, type App } from 'obsidian';
import * as bodySaves from '../../src/features/notebook/bodySaves';
import { createEditorOwners } from '../../src/features/notebook/editorOwners';
import { insertLink, insertQuote, linkTargets, toggleWrap, wordCount } from '../../src/features/notebook/format';
import { backend, setBackend } from '../../src/lib/backend';
import MarginPlugin from '../src/main';
import { MarginView, VIEW_TYPE } from '../src/view/MarginView';
import { makeApp, manifest, pdfBytes } from './helpers';

function editor(doc: string, from: number, to = from): EditorView {
  return new EditorView({ state: EditorState.create({ doc, selection: { anchor: from, head: to } }) });
}
const sel = (v: EditorView) => v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);

describe('thought formatting', () => {
  it('wraps the selection in ** and takes it off again', () => {
    const v = editor('a big idea', 2, 5);
    toggleWrap(v, '**');
    expect(v.state.doc.toString()).toBe('a **big** idea');
    expect(sel(v)).toBe('big');
    toggleWrap(v, '**');
    expect(v.state.doc.toString()).toBe('a big idea');
    expect(sel(v)).toBe('big');
  });

  it('italic inside bold adds a * rather than taking the bold apart', () => {
    const v = editor('**big**', 2, 5);
    toggleWrap(v, '*');
    expect(v.state.doc.toString()).toBe('***big***');
  });

  it('with nothing selected, puts the caret between the marks', () => {
    const v = editor('x ', 2);
    toggleWrap(v, '*');
    expect(v.state.doc.toString()).toBe('x **');
    expect(v.state.selection.main.head).toBe(3);
  });

  it('links the selection, or opens an empty [[ ]] with the caret inside', () => {
    const v = editor('see Walden here', 4, 10);
    insertLink(v);
    expect(v.state.doc.toString()).toBe('see [[Walden]] here');
    const w = editor('', 0);
    insertLink(w);
    expect(w.state.doc.toString()).toBe('[[]]');
    expect(w.state.selection.main.head).toBe(2);
  });

  it('quotes the highlight on lines of its own', () => {
    const v = editor('My thought', 10);
    insertQuote(v, 'Simplify, simplify.');
    expect(v.state.doc.toString()).toBe('My thought\n\n> Simplify, simplify.\n\n');
    const w = editor('', 0);
    insertQuote(w, 'one\ntwo');
    expect(w.state.doc.toString()).toBe('> one\n> two\n\n');
  });

  it('counts words without Markdown marks, and lists link targets once each', () => {
    expect(wordCount('A **bold** move, see [[Walden|the book]] — now.')).toBe(7);
    expect(wordCount('   ')).toBe(0);
    expect(linkTargets('[[Aestheticism]] and [[Paradox#Wilde]], again [[Aestheticism|it]]')).toEqual(['Aestheticism', 'Paradox']);
  });
});

describe('editor owners and the sheet', () => {
  it('the sheet takes a thought from the margin, even one the margin has focus on, and gives it back', () => {
    const owners = createEditorOwners();
    owners.hostInMargin('t1');
    owners.focus('t1', 'margin');
    owners.setSheet('t1');
    expect(owners.owner('t1')).toBe('sheet');
    expect(owners.owner('t2')).toBe('notebook');
    owners.blur('t1', 'margin');
    owners.setSheet(null);
    expect(owners.owner('t1')).toBe('margin');
  });
});

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

async function openWalden(): Promise<MarginView> {
  __setPdfJs(fakePdfjs);
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
  return view;
}

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

describe('the writing sheet in the reader', () => {
  it('opens a notebook thought in the sheet, edits it there while the notebook shows a preview, and closes', async () => {
    const view = await openWalden();
    const bookId = (view as unknown as { book: { id: string } }).book.id;
    fireEvent.click(screen.getByRole('button', { name: 'New Thought' }));
    await waitFor(async () => expect(await backend().listThoughts(bookId)).toHaveLength(1));
    if (!screen.queryByRole('complementary', { name: 'Notebook' })) fireEvent.click(screen.getByRole('button', { name: 'Notebook' }));
    const notebook = await screen.findByRole('complementary', { name: 'Notebook' });

    fireEvent.click(await within(notebook).findByRole('button', { name: /in the writing sheet/ }));
    const sheet = await screen.findByRole('dialog');
    expect(sheet.classList.contains('writing-sheet')).toBe(true);
    // One editor per thought: the sheet's, and the notebook offers to go there.
    await waitFor(() => expect(sheet.querySelector('.cm-content')).toBeTruthy());
    expect(notebook.querySelector('.cm-content')).toBeNull();
    expect(within(notebook).getByRole('button', { name: /^Open the writing sheet/ })).toBeTruthy();

    // A format button writes into the thought, and it is saved.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Link a note' }));
    await waitFor(async () => expect((await backend().listThoughts(bookId))[0].body).toBe('[[]]'), { timeout: 2000 });
    await waitFor(() => expect(within(sheet).getByRole('status').textContent).toBe('Saved'));

    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(notebook.querySelector('.cm-content')).toBeTruthy());
  });

  it('Escape closes the sheet, and so does a click outside it', async () => {
    await openWalden();
    fireEvent.click(screen.getByRole('button', { name: 'New Thought' }));
    if (!screen.queryByRole('complementary', { name: 'Notebook' })) fireEvent.click(screen.getByRole('button', { name: 'Notebook' }));
    const notebook = await screen.findByRole('complementary', { name: 'Notebook' });
    const open = async () => {
      fireEvent.click(await within(notebook).findByRole('button', { name: /in the writing sheet/ }));
      return screen.findByRole('dialog');
    };
    fireEvent.keyDown(await open(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await open();
    await act(async () => {
      fireEvent.mouseDown(document.querySelector('.writing-sheet-backdrop')!);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
