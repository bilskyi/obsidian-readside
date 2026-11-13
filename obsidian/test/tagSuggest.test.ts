import { EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { linkSuggestions, tagQueryAt, type LinkSuggestSource } from '../../src/features/notebook/linkSuggest';
import { suggestTags } from '../src/linkSuggest';
import { makeApp } from './helpers';

const at = (text: string) => tagQueryAt(EditorState.create({ doc: text }), text.length);

describe('tagQueryAt: the #tag being typed', () => {
  it('starts a tag at a line start or after a space, letters, digits, _ - and / included', () => {
    expect(at('#')).toEqual({ from: 1, query: '' });
    expect(at('see #rea')).toEqual({ from: 5, query: 'rea' });
    expect(at('see #reading/2026-q4')).toEqual({ from: 5, query: 'reading/2026-q4' });
    expect(at('#чтение')).toEqual({ from: 1, query: 'чтение' });
  });

  it('is not a tag inside a word or a URL, nor after a heading’s space', () => {
    expect(at('page#3')).toBeNull();
    expect(at('https://x.org/a#b')).toBeNull();
    expect(at('# Heading')).toBeNull();
    expect(at('#tag ')).toBeNull();
  });
});

describe('suggestTags: the vault’s tags for #', () => {
  it('counts each tag once per note, matches anywhere, ranks prefix matches then use', async () => {
    const app = makeApp();
    const a = await app.vault.create('A.md', '---\ntags: ["reading"]\n---\n#reading #ideas');
    const b = await app.vault.create('B.md', 'x');
    await app.vault.create('C.md', 'y');
    app.metadataCache.setCache(a.path, { tags: [{ tag: '#reading' }, { tag: '#ideas' }] });
    app.metadataCache.setCache(b.path, { tags: [{ tag: '#ideas' }, { tag: '#rereading' }] });
    app.metadataCache.setCache('C.md', { tags: [{ tag: '#Reading-list' }] });
    expect(suggestTags(app, 'rea').map((s) => [s.label, s.detail])).toEqual([
      ['#reading', '1 note'],
      ['#Reading-list', '1 note'],
      ['#rereading', '1 note'],
    ]);
    expect(suggestTags(app, '')[0]).toEqual({ label: '#ideas', insert: 'ideas', detail: '2 notes' });
  });
});

describe('the suggestion list in an editor', () => {
  const source: LinkSuggestSource = (q, _s, kind) =>
    kind === 'tag' ? [{ label: `#${q}ing`, insert: `${q}ing` }] : [{ label: `Note ${q}`, insert: `Note ${q}` }];

  function editor(): EditorView {
    const parent = document.body.appendChild(document.createElement('div'));
    return new EditorView({ parent, state: EditorState.create({ extensions: [linkSuggestions(() => source)] }) });
  }
  const type = (v: EditorView, text: string) =>
    v.dispatch({ changes: { from: v.state.doc.length, insert: text }, selection: { anchor: v.state.doc.length + text.length }, userEvent: 'input.type' });
  const enter = (v: EditorView) => runScopeHandlers(v, new KeyboardEvent('keydown', { key: 'Enter' }), 'editor');

  it('Enter on a #tag writes it with a space after, and the list closes', () => {
    const v = editor();
    type(v, 'idea #read');
    expect(v.dom.ownerDocument.querySelector('.cm-link-suggest')?.getAttribute('aria-label')).toBe('Tags');
    expect(enter(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('idea #reading ');
    expect(enter(v)).toBe(false);
    v.destroy();
  });

  it('[[ still suggests notes', () => {
    const v = editor();
    type(v, 'see [[Wal');
    enter(v);
    expect(v.state.doc.toString()).toBe('see [[Note Wal]]');
    v.destroy();
  });
});
