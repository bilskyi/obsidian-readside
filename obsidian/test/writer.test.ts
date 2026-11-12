import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Notice, type App } from 'obsidian';
import type { Book } from '../../src/lib/types';
import { mirrorPath, MirrorWriter, withoutProgress } from '../src/mirror/writer';
import { sha256Hex } from '../src/store/hash';
import { makeApp, ROOT } from './helpers';

let app: App;
const now = () => new Date(2026, 10, 10, 9, 30);
const make = () => new MirrorWriter({ app, root: ROOT, notice: (m) => new Notice(m), now });
const text = async (path: string) => app.vault.read(app.vault.getFileByPath(path)!);
const filesIn = (folder: string) => app.vault.getFiles().filter((f) => f.path.startsWith(`${folder}/`)).map((f) => f.path).sort();

beforeEach(() => {
  app = makeApp();
});

describe('mirrorPath', () => {
  it('is <folder>/<title>.md with unsafe characters replaced; an empty folder is the vault root', () => {
    const book = { title: 'Walden: or, Life in the Woods?', path: 'Books/w.pdf' } as Book;
    expect(mirrorPath('Margin', book)).toBe('Margin/Walden or, Life in the Woods.md');
    expect(mirrorPath('', { ...book, title: null })).toBe('w.md');
    expect(mirrorPath(' Notes / Reading ', book)).toBe('Notes/Reading/Walden or, Life in the Woods.md');
  });

  it('drops leading dots from the title and every character a file name can’t hold; . and .. folder segments go', () => {
    expect(mirrorPath('Margin', { title: '...hidden', path: 'Books/h.pdf' } as Book)).toBe('Margin/hidden.md');
    expect(mirrorPath('Margin', { title: '. .x', path: 'Books/h.pdf' } as Book)).toBe('Margin/x.md');
    expect(mirrorPath('Margin', { title: 'a\\b/c:d*e?f"g<h>i|j#k^l[m]n', path: 'Books/h.pdf' } as Book)).toBe('Margin/a b c d e f g h i j k l m n.md');
    expect(mirrorPath('./Margin/../Notes', { title: 'W', path: 'Books/h.pdf' } as Book)).toBe('Margin/Notes/W.md');
    expect(mirrorPath('Margin', { title: '...', path: 'Books/h.pdf' } as Book)).toBe('Margin/Untitled.md');
  });
});

describe('MirrorWriter', () => {
  it('creates the folder and the note and remembers what it wrote', async () => {
    await make().write('b1', 'Margin/Walden.md', 'v1');
    expect(await text('Margin/Walden.md')).toBe('v1');
    const saved = JSON.parse(app.vault.adapter.files.get(`${ROOT}/mirrors.json`) as string);
    expect(saved.books.b1).toEqual({ path: 'Margin/Walden.md', hash: await sha256Hex('v1'), stable: await sha256Hex('v1') });
  });

  it('rewrites a note nobody touched in place, with no copy and no notice', async () => {
    const w = make();
    await w.write('b1', 'Margin/Walden.md', 'v1');
    await w.write('b1', 'Margin/Walden.md', 'v2');
    expect(await text('Margin/Walden.md')).toBe('v2');
    expect(filesIn('Margin')).toEqual(['Margin/Walden.md']);
    expect(Notice.messages).toEqual([]);
  });

  it('an edited note is first copied to "<name> (edited yyyy-mm-dd HHmm).md", with a notice', async () => {
    const w = make();
    await w.write('b1', 'Margin/Walden.md', 'v1');
    await app.vault.modify(app.vault.getFileByPath('Margin/Walden.md')!, 'v1 plus my edit');
    await w.write('b1', 'Margin/Walden.md', 'v2');
    expect(await text('Margin/Walden (edited 2026-11-10 0930).md')).toBe('v1 plus my edit');
    expect(await text('Margin/Walden.md')).toBe('v2');
    expect(Notice.messages).toHaveLength(1);
    expect(Notice.messages[0]).toContain('Walden (edited 2026-11-10 0930)');
  });

  it('a note at that path that Margin never wrote is kept the same way', async () => {
    await app.vault.createFolder('Margin');
    await app.vault.create('Margin/Walden.md', 'mine');
    await make().write('b1', 'Margin/Walden.md', 'v1');
    expect(await text('Margin/Walden (edited 2026-11-10 0930).md')).toBe('mine');
    expect(await text('Margin/Walden.md')).toBe('v1');
  });

  it('an unchanged note is not written again', async () => {
    const w = make();
    await w.write('b1', 'Margin/Walden.md', 'v1');
    app.vault.adapter.calls.length = 0;
    await w.write('b1', 'Margin/Walden.md', 'v1');
    expect(app.vault.adapter.calls).not.toContain('write Margin/Walden.md');
  });

  it('a new path (the book was renamed) moves the note through fileManager.renameFile', async () => {
    const w = make();
    await w.write('b1', 'Margin/Walden.md', 'v1');
    const file = app.vault.getFileByPath('Margin/Walden.md')!;
    const rename = vi.spyOn(app.fileManager, 'renameFile');
    await w.write('b1', 'Margin/Walden Pond.md', 'v2');
    expect(rename).toHaveBeenCalledWith(file, 'Margin/Walden Pond.md');
    expect(filesIn('Margin')).toEqual(['Margin/Walden Pond.md']);
    expect(await text('Margin/Walden Pond.md')).toBe('v2');
  });

  it('a retitle onto a note the user already has there leaves that note alone and takes "<title> (2).md"', async () => {
    const w = make();
    await w.write('b1', 'Margin/Walden.md', 'v1');
    await app.vault.create('Margin/Walden Pond.md', 'my own note');
    await w.write('b1', 'Margin/Walden Pond.md', 'v2');
    expect(await text('Margin/Walden Pond.md')).toBe('my own note');
    expect(await text('Margin/Walden Pond (2).md')).toBe('v2');
    expect(filesIn('Margin')).toEqual(['Margin/Walden Pond (2).md', 'Margin/Walden Pond.md']);
    expect(Notice.messages).toEqual([]);
    // It stays there on the next write; the user's note is still theirs.
    await w.write('b1', 'Margin/Walden Pond.md', 'v3');
    expect(await text('Margin/Walden Pond (2).md')).toBe('v3');
    expect(await text('Margin/Walden Pond.md')).toBe('my own note');
  });

  it('two books with the same title get separate notes', async () => {
    const w = make();
    await w.write('b1', 'Margin/Walden.md', 'one');
    await w.write('b2', 'Margin/Walden.md', 'two');
    expect(await text('Margin/Walden.md')).toBe('one');
    expect(await text('Margin/Walden (2).md')).toBe('two');
  });

  it('remembers what it wrote across restarts', async () => {
    await make().write('b1', 'Margin/Walden.md', 'v1');
    await make().write('b1', 'Margin/Walden.md', 'v2');
    expect(filesIn('Margin')).toEqual(['Margin/Walden.md']);
    expect(await text('Margin/Walden.md')).toBe('v2');
  });

  it('an identical rerun writes neither the note nor mirrors.json', async () => {
    const w = make();
    await w.write('b1', 'Margin/Walden.md', 'v1');
    app.vault.adapter.calls.length = 0;
    await w.write('b1', 'Margin/Walden.md', 'v1');
    expect(app.vault.adapter.calls.filter((c) => c.startsWith('write '))).toEqual([]);
  });

  it('a changed note rewrites mirrors.json once', async () => {
    const w = make();
    await w.write('b1', 'Margin/Walden.md', 'v1');
    app.vault.adapter.calls.length = 0;
    await w.write('b1', 'Margin/Walden.md', 'v2');
    expect(app.vault.adapter.calls.filter((c) => c === `write ${ROOT}/mirrors.json.tmp`)).toHaveLength(1);
  });

  it('mirrors.json is written atomically: tmp, remove the old file, rename the tmp into place', async () => {
    const w = make();
    await w.write('b1', 'Margin/Walden.md', 'v1');
    app.vault.adapter.calls.length = 0;
    await w.write('b1', 'Margin/Walden.md', 'v2');
    const file = `${ROOT}/mirrors.json`;
    const io = app.vault.adapter.calls.filter((c) => c.endsWith(file) || c.endsWith(`${file}.tmp`));
    expect(io).toEqual([`write ${file}.tmp`, `exists ${file}`, `remove ${file}`, `rename ${file}.tmp`]);
    expect(app.vault.adapter.files.has(`${file}.tmp`)).toBe(false);
    expect(JSON.parse(app.vault.adapter.files.get(file) as string).books.b1.hash).toBe(await sha256Hex('v2'));
  });

  it('an interrupted mirrors.json save: a tmp that parses is used, one that does not is dropped', async () => {
    const file = `${ROOT}/mirrors.json`;
    await app.vault.createFolder('Margin');
    await app.vault.create('Margin/Walden.md', 'v1');
    // Crash after removing the main file: only the tmp is left, and it has the record.
    app.vault.adapter.files.set(`${file}.tmp`, JSON.stringify({ version: 1, books: { b1: { path: 'Margin/Walden.md', hash: await sha256Hex('v1') } } }));
    await make().write('b1', 'Margin/Walden.md', 'v2');
    expect(filesIn('Margin')).toEqual(['Margin/Walden.md']); // recognised as Margin's own: no copy
    expect(app.vault.adapter.files.has(`${file}.tmp`)).toBe(false);
    app.vault.adapter.files.set(`${file}.tmp`, '{ partial');
    await make().write('b1', 'Margin/Walden.md', 'v3');
    expect(filesIn('Margin')).toEqual(['Margin/Walden.md']);
    expect(app.vault.adapter.files.has(`${file}.tmp`)).toBe(false);
  });

  it('a corrupt mirrors.json: starts empty, keeps the note in a copy, writes a fresh mirrors.json', async () => {
    await app.vault.createFolder('Margin');
    await app.vault.create('Margin/Walden.md', 'v1 as Margin wrote it');
    app.vault.adapter.files.set(`${ROOT}/mirrors.json`, '{ not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await make().write('b1', 'Margin/Walden.md', 'v2');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(await text('Margin/Walden (edited 2026-11-10 0930).md')).toBe('v1 as Margin wrote it');
    expect(await text('Margin/Walden.md')).toBe('v2');
    const saved = JSON.parse(app.vault.adapter.files.get(`${ROOT}/mirrors.json`) as string);
    expect(saved).toEqual({ version: 1, books: { b1: { path: 'Margin/Walden.md', hash: await sha256Hex('v2'), stable: await sha256Hex('v2') } } });
  });

  it('a second edit kept in the same minute gets " 2"', async () => {
    const w = make();
    await w.write('b1', 'Margin/Walden.md', 'v1');
    await app.vault.modify(app.vault.getFileByPath('Margin/Walden.md')!, 'edit one');
    await w.write('b1', 'Margin/Walden.md', 'v2');
    await app.vault.modify(app.vault.getFileByPath('Margin/Walden.md')!, 'edit two');
    await w.write('b1', 'Margin/Walden.md', 'v3');
    expect(await text('Margin/Walden (edited 2026-11-10 0930).md')).toBe('edit one');
    expect(await text('Margin/Walden (edited 2026-11-10 0930) 2.md')).toBe('edit two');
    expect(await text('Margin/Walden.md')).toBe('v3');
  });

  it('an edit landing between Margin’s read and its write is kept: the write backs off, copies, then writes', async () => {
    const w = make();
    await w.write('b1', 'Margin/Walden.md', 'v1');
    const file = app.vault.getFileByPath('Margin/Walden.md')!;
    const process = app.vault.process.bind(app.vault);
    let raced = false;
    app.vault.process = async (f, fn) => {
      if (!raced) {
        raced = true;
        await app.vault.adapter.write(f.path, 'typed just now');
      }
      return process(f, fn);
    };
    await w.write('b1', 'Margin/Walden.md', 'v2');
    expect(await text('Margin/Walden (edited 2026-11-10 0930).md')).toBe('typed just now');
    expect(await text('Margin/Walden.md')).toBe('v2');
    expect(file.path).toBe('Margin/Walden.md');
    expect(Notice.messages).toHaveLength(1);
  });

  it('a hand edit survives a rerun with nothing new (a position save): no copy, no notice; Margin’s next news copies it, then rewrites', async () => {
    const w = make();
    await w.write('b1', 'Margin/Walden.md', 'v1');
    await app.vault.modify(app.vault.getFileByPath('Margin/Walden.md')!, 'v1 and what I am typing');
    await w.write('b1', 'Margin/Walden.md', 'v1');
    expect(filesIn('Margin')).toEqual(['Margin/Walden.md']);
    expect(Notice.messages).toEqual([]);
    expect(await text('Margin/Walden.md')).toBe('v1 and what I am typing');
    // A new thought: genuinely new content. The edit goes to a copy and the note is Margin's again.
    await w.write('b1', 'Margin/Walden.md', 'v1 + a thought');
    expect(await text('Margin/Walden (edited 2026-11-10 0930).md')).toBe('v1 and what I am typing');
    expect(await text('Margin/Walden.md')).toBe('v1 + a thought');
    expect(Notice.messages).toHaveLength(1);
  });

  it('a note deleted by hand comes back on the next rerun, even with nothing new', async () => {
    const w = make();
    await w.write('b1', 'Margin/Walden.md', 'v1');
    await app.vault.delete(app.vault.getFileByPath('Margin/Walden.md')!);
    await w.write('b1', 'Margin/Walden.md', 'v1');
    expect(await text('Margin/Walden.md')).toBe('v1');
    expect(Notice.messages).toEqual([]);
  });

  it('after the store closes nothing is written or recorded', async () => {
    let closed = false;
    const w = new MirrorWriter({ app, root: ROOT, notice: (m) => new Notice(m), now, isClosed: () => closed });
    await w.write('b1', 'Margin/Walden.md', 'v1');
    closed = true;
    app.vault.adapter.calls.length = 0;
    await w.write('b1', 'Margin/Walden.md', 'v2');
    expect(app.vault.adapter.calls.filter((c) => c.startsWith('write '))).toEqual([]);
    expect(await text('Margin/Walden.md')).toBe('v1');
  });

  it('closing while a write is in flight keeps the stale record out of mirrors.json', async () => {
    let closed = false;
    const w = new MirrorWriter({ app, root: ROOT, notice: (m) => new Notice(m), now, isClosed: () => closed });
    await w.write('b1', 'Margin/Walden.md', 'v1');
    const process = app.vault.process.bind(app.vault);
    app.vault.process = async (f, fn) => {
      const out = await process(f, fn);
      closed = true;
      return out;
    };
    app.vault.adapter.calls.length = 0;
    await w.write('b1', 'Margin/Walden.md', 'v2');
    expect(app.vault.adapter.calls.filter((c) => c.startsWith(`write ${ROOT}/mirrors.json`))).toEqual([]);
  });

  describe('margin-progress alone is no reason to rewrite', () => {
    const note = (progress: number, body = 'body') => `---\nmargin-book: "[[Books/w.pdf]]"\nmargin-progress: ${progress}\ntags: [margin]\n---\n# W\n${body}\n`;

    it('withoutProgress drops only the front-matter progress line', () => {
      expect(withoutProgress(note(0.3))).toBe('---\nmargin-book: "[[Books/w.pdf]]"\ntags: [margin]\n---\n# W\nbody\n');
      expect(withoutProgress(note(0.3))).toBe(withoutProgress(note(0.9)));
      expect(withoutProgress('---\ntags: [x]\n---\nmargin-progress: 1\n')).toBe('---\ntags: [x]\n---\nmargin-progress: 1\n');
      expect(withoutProgress('no front matter')).toBe('no front matter');
    });

    it('a progress-only change leaves the note (and mirrors.json) as they are', async () => {
      const w = make();
      await w.write('b1', 'Margin/W.md', note(0.1));
      app.vault.adapter.calls.length = 0;
      await w.write('b1', 'Margin/W.md', note(0.2));
      await w.write('b1', 'Margin/W.md', note(0.3));
      expect(await text('Margin/W.md')).toBe(note(0.1));
      expect(app.vault.adapter.calls.filter((c) => c.startsWith('write '))).toEqual([]);
    });

    it('a real change after skipped progress updates rewrites in place with today’s progress and no copy', async () => {
      const w = make();
      await w.write('b1', 'Margin/W.md', note(0.1));
      await w.write('b1', 'Margin/W.md', note(0.4));
      await w.write('b1', 'Margin/W.md', note(0.5, 'body and a new quote'));
      expect(await text('Margin/W.md')).toBe(note(0.5, 'body and a new quote'));
      expect(filesIn('Margin')).toEqual(['Margin/W.md']);
      expect(Notice.messages).toEqual([]);
    });

    it('a deleted note comes back with the current progress, and is recorded', async () => {
      const w = make();
      await w.write('b1', 'Margin/W.md', note(0.1));
      await app.vault.delete(app.vault.getFileByPath('Margin/W.md')!);
      await w.write('b1', 'Margin/W.md', note(0.6));
      expect(await text('Margin/W.md')).toBe(note(0.6));
      const saved = JSON.parse(app.vault.adapter.files.get(`${ROOT}/mirrors.json`) as string);
      expect(saved.books.b1.hash).toBe(await sha256Hex(note(0.6)));
      // Untouched since: the next real change replaces it without a copy.
      await w.write('b1', 'Margin/W.md', note(0.7, 'more'));
      expect(filesIn('Margin')).toEqual(['Margin/W.md']);
    });

    it('a record from before `stable` existed counts as changed once, then is upgraded', async () => {
      await app.vault.createFolder('Margin');
      await app.vault.create('Margin/W.md', note(0.1));
      app.vault.adapter.files.set(`${ROOT}/mirrors.json`, JSON.stringify({ version: 1, books: { b1: { path: 'Margin/W.md', hash: await sha256Hex(note(0.1)) } } }));
      const w = make();
      await w.write('b1', 'Margin/W.md', note(0.2));
      expect(await text('Margin/W.md')).toBe(note(0.2));
      expect(filesIn('Margin')).toEqual(['Margin/W.md']);
      const saved = JSON.parse(app.vault.adapter.files.get(`${ROOT}/mirrors.json`) as string);
      expect(saved.books.b1).toEqual({ path: 'Margin/W.md', hash: await sha256Hex(note(0.2)), stable: await sha256Hex(withoutProgress(note(0.2))) });
      await w.write('b1', 'Margin/W.md', note(0.3));
      expect(await text('Margin/W.md')).toBe(note(0.2));
    });
  });
});

describe('escaped book text: an existing note is Margin’s own regeneration (E7 fix round 1)', () => {
  it('a PDF note written before titles were escaped is rewritten in place: no "(edited …)" copy, no notice', async () => {
    const { generateMirror } = await import('../src/mirror/generate');
    const pdf: Book = {
      id: 'b1', contentHash: 'h', path: 'Books/c.pdf', format: 'pdf', title: 'C# *Basics* [draft]', author: null, lastLocation: null,
      addedAt: 't0', openedAt: null, zoom: null, progress: 0.5,
    };
    const input = { book: pdf, annotations: [], thoughts: [], outline: [] };
    const now = generateMirror(input);
    expect(now).toContain('\n# C\\# \\*Basics\\* \\[draft\\]\n');
    // What the generator wrote before (the title verbatim), on record in mirrors.json.
    const before = now.replace('# C\\# \\*Basics\\* \\[draft\\]', '# C# *Basics* [draft]');
    expect(before).not.toBe(now);
    const path = mirrorPath('Margin', pdf);
    expect(path).toBe('Margin/C Basics draft.md');
    const w = make();
    await w.write('b1', path, before);
    await w.write('b1', path, now);
    expect(await text(path)).toBe(now);
    expect(filesIn('Margin')).toEqual([path]);
    expect(Notice.messages).toEqual([]);
  });
});

describe('mirrorPath: bounded, portable names (E7 fix round 1)', () => {
  const named = (title: string) => mirrorPath('Margin', { title, path: 'Books/x.pdf' } as Book);
  const nameOf = (p: string) => p.slice('Margin/'.length, -'.md'.length);

  it('a 400-character Cyrillic title is cut to at most 150 UTF-8 bytes, on a character boundary', () => {
    const title = 'Преступление и наказание '.repeat(16).slice(0, 400);
    const name = nameOf(named(title));
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(150);
    expect(new TextEncoder().encode(name).length).toBeGreaterThan(140);
    expect(title.startsWith(name)).toBe(true);
    expect(name).not.toMatch(/[\s.]$/);
    expect(name).not.toContain('�');
  });

  it('never splits a surrogate pair', () => {
    const name = nameOf(named(`${'a'.repeat(148)}😀😀`));
    expect(name).toBe('a'.repeat(148));
    expect(nameOf(named(`${'a'.repeat(146)}😀😀`))).toBe(`${'a'.repeat(146)}😀`);
  });

  it('trailing dots and spaces go; Windows device names get a prefix', () => {
    expect(named('Wait for it...')).toBe('Margin/Wait for it.md');
    expect(named('CON')).toBe('Margin/_CON.md');
    expect(named('lpt9')).toBe('Margin/_lpt9.md');
    expect(named('nul.txt')).toBe('Margin/_nul.txt.md');
    expect(named('COM10')).toBe('Margin/COM10.md');
    expect(named('Console')).toBe('Margin/Console.md');
  });

  it('titles under the cap map exactly as before', () => {
    expect(named('Walden or, Life in the Woods')).toBe('Margin/Walden or, Life in the Woods.md');
    const exact = 'б'.repeat(75); // 150 bytes
    expect(named(exact)).toBe(`Margin/${exact}.md`);
  });
});

describe('neutralised quotes: an existing note is Margin’s own regeneration (E7 fix round 2)', () => {
  it('a note with a raw <img> quote, written before, is rewritten in place: no "(edited …)" copy, no notice', async () => {
    const { generateMirror } = await import('../src/mirror/generate');
    const { pdfLocation, serializeLocation } = await import('../../src/lib/location');
    const pdf: Book = {
      id: 'b1', contentHash: 'h', path: 'Books/w.pdf', format: 'pdf', title: 'Walden', author: null, lastLocation: null,
      addedAt: 't0', openedAt: null, zoom: null, progress: 0.5,
    };
    const annotations = [{
      id: 'a1', bookId: 'b1', location: serializeLocation(pdfLocation({ page: 1, start: 0, end: 9 })), quote: '<img src=https://x/t.gif>',
      color: 'yellow' as const, note: null, unanchored: false, createdAt: 't', updatedAt: 't',
    }];
    const now = generateMirror({ book: pdf, annotations, thoughts: [], outline: [] });
    expect(now).toContain('\n> &lt;img src=https://x/t.gif>\n');
    const before = now.replace('> &lt;img', '> <img');
    expect(before).not.toBe(now);
    const w = make();
    await w.write('b1', 'Margin/Walden.md', before);
    await w.write('b1', 'Margin/Walden.md', now);
    expect(await text('Margin/Walden.md')).toBe(now);
    expect(filesIn('Margin')).toEqual(['Margin/Walden.md']);
    expect(Notice.messages).toEqual([]);
  });
});

describe('comment/wikilink escaping and EPUB quote display: an existing note is Margin’s own regeneration (final review A3/A4)', () => {
  it('a note written before %% and [[ were escaped, and an EPUB note with indented quotes, are rewritten in place: no copy, no notice', async () => {
    const { generateMirror } = await import('../src/mirror/generate');
    const { epubLocation, pdfLocation, serializeLocation } = await import('../../src/lib/location');
    const base: Book = {
      id: 'b1', contentHash: 'h', path: 'Books/w.pdf', format: 'pdf', title: 'Walden', author: null, lastLocation: null,
      addedAt: 't0', openedAt: null, zoom: null, progress: 0.5,
    };
    const ann = (location: string, quote: string) => ({
      id: 'a1', bookId: 'b1', location, quote, color: 'yellow' as const, note: null, unanchored: false, createdAt: 't', updatedAt: 't',
    });
    const cases = [
      { book: base, a: ann(serializeLocation(pdfLocation({ page: 1, start: 0, end: 9 })), 'a %%comment%% and [[link]]'), was: '> a %%comment%% and [[link]]', is: '> a %&#37;comment%&#37; and [\\[link]]' },
      {
        book: { ...base, id: 'b2', path: 'Books/m.epub', format: 'epub' as const, title: 'Moby' },
        a: ann(serializeLocation(epubLocation({ section: 1, start: 0, end: 9 })), 'end.\n\t\t\tNext para.'),
        was: '> end.\n> \t\t\tNext para.',
        is: '> end.\n> Next para.',
      },
    ];
    const w = make();
    for (const c of cases) {
      const now = generateMirror({ book: c.book, annotations: [c.a], thoughts: [], outline: [] });
      expect(now).toContain(`\n${c.is}\n`);
      const before = now.replace(c.is, c.was);
      expect(before).not.toBe(now);
      const path = mirrorPath('Margin', c.book);
      await w.write(c.book.id, path, before);
      await w.write(c.book.id, path, now);
      expect(await text(path)).toBe(now);
    }
    expect(filesIn('Margin')).toEqual(['Margin/Moby.md', 'Margin/Walden.md']);
    expect(Notice.messages).toEqual([]);
  });
});

describe('mirrorPath: more Windows device names (final review D)', () => {
  it('CONIN$, CONOUT$ and COM/LPT with a superscript digit get a prefix; near misses do not', () => {
    const named = (title: string) => mirrorPath('Margin', { title, path: 'Books/x.pdf' } as Book);
    expect(named('CONIN$')).toBe('Margin/_CONIN$.md');
    expect(named('conout$.txt')).toBe('Margin/_conout$.txt.md');
    expect(named('COM¹')).toBe('Margin/_COM¹.md');
    expect(named('lpt³')).toBe('Margin/_lpt³.md');
    expect(named('COM⁴')).toBe('Margin/COM⁴.md');
    expect(named('CONIN')).toBe('Margin/CONIN.md');
  });
});
