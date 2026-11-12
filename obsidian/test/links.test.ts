import { describe, expect, it } from 'vitest';
import { parseLocation, pdfLocation, serializeLocation } from '../../src/lib/location';
import { buildObsidianUrl, linkLabel, markdownLink, parseMarginParams } from '../src/links';
import { epubLocation, epubPoint } from '../../src/lib/location';

describe('links', () => {
  it('builds obsidian://readside with the vault path and the location JSON, safe inside a Markdown link', () => {
    const loc = pdfLocation({ page: 42, start: 3, end: 9 });
    const url = buildObsidianUrl('Books/My (draft).pdf', loc);
    expect(url.startsWith('obsidian://readside?file=Books%2FMy%20%28draft%29.pdf&loc=')).toBe(true);
    expect(url).not.toMatch(/[()\s]/);
    const u = new URL(url);
    expect(u.searchParams.get('file')).toBe('Books/My (draft).pdf');
    expect(parseLocation(u.searchParams.get('loc'))).toEqual(loc);
    expect(buildObsidianUrl('a.pdf', null)).toBe('obsidian://readside?file=a.pdf');
  });

  it('parses the handler’s parameters; a bad loc still opens the file; no file is nothing', () => {
    const loc = pdfLocation({ page: 2, start: 0, end: 0 });
    expect(parseMarginParams({ action: 'margin', file: 'Books/a.pdf', loc: serializeLocation(loc) })).toEqual({ file: 'Books/a.pdf', location: loc });
    expect(parseMarginParams({ action: 'margin', file: 'Books/a.pdf', loc: '{bad' })).toEqual({ file: 'Books/a.pdf', location: null });
    expect(parseMarginParams({ action: 'margin' })).toBeNull();
  });

  it('labels a highlight link with its page and opening words, a place with its page', () => {
    const loc = pdfLocation({ page: 42, start: 0, end: 5 });
    expect(linkLabel(loc, 'Simplify, simplify.')).toBe('p. 42 · “Simplify, simplify.”');
    expect(linkLabel(loc, null)).toBe('p. 42');
  });

  it('writes a Markdown link, escaping brackets in the label', () => {
    const loc = pdfLocation({ page: 7, start: 0, end: 5 });
    expect(markdownLink('Books/a.pdf', loc, 'a [b] c')).toBe(`[p. 7 · “a \\[b\\] c”](${buildObsidianUrl('Books/a.pdf', loc)})`);
  });

  it('paths with # [ ] | spaces, parentheses and Cyrillic round-trip through the URL and the handler', () => {
    const loc = pdfLocation({ page: 3, start: 1, end: 4 });
    for (const path of ['Books/a#b.pdf', 'Books/[draft] a]b.pdf', 'Books/a|b.pdf', 'Books/My (big) book.pdf', 'Книги/Война и мир (том 1).pdf', 'Books/#[|] (х).pdf']) {
      const url = buildObsidianUrl(path, loc);
      expect(url).not.toMatch(/[()\s#[\]|]/);
      const params = Object.fromEntries(new URL(url).searchParams);
      expect(parseMarginParams(params)).toEqual({ file: path, location: loc });
      const md = markdownLink(path, loc, null);
      expect(md.slice(md.indexOf('](') + 2, -1)).toBe(url);
    }
  });
});

describe('links to an epub place', () => {
  it('labels it § N (with the quote’s snippet) and round-trips its location through the URL', () => {
    const loc = epubLocation({ section: 7, start: 3, end: 18 });
    expect(linkLabel(loc, 'Call me Ishmael')).toBe('§ 7 · “Call me Ishmael”');
    expect(linkLabel(epubPoint(7, 0), null)).toBe('§ 7');
    const u = new URL(buildObsidianUrl('Books/Moby.epub', loc));
    expect(parseMarginParams({ file: u.searchParams.get('file')!, loc: u.searchParams.get('loc')! })).toEqual({ file: 'Books/Moby.epub', location: loc });
  });
});

describe('links to an epub highlight (E7)', () => {
  it('markdownLink says § N · “…” and carries the epub loc', () => {
    const loc = epubLocation({ section: 2, start: 0, end: 15 });
    const link = markdownLink('Books/Moby.epub', loc, 'Call me Ishmael');
    expect(link).toBe(`[§ 2 · “Call me Ishmael”](${buildObsidianUrl('Books/Moby.epub', loc)})`);
    const u = new URL(link.slice(link.indexOf('](') + 2, -1));
    expect(parseMarginParams({ file: u.searchParams.get('file')!, loc: u.searchParams.get('loc')! })).toEqual({ file: 'Books/Moby.epub', location: loc });
  });
});

describe('links carry the EPUB text model (final review A5)', () => {
  it('a new epub link holds v; it round-trips; an old link without v opens the same place as model 3', () => {
    const loc = epubLocation({ section: 7, start: 3, end: 18 });
    const u = new URL(buildObsidianUrl('Books/Moby.epub', loc));
    expect(JSON.parse(u.searchParams.get('loc')!).value).toEqual({ section: 7, start: 3, end: 18, v: 3 });
    expect(parseMarginParams({ file: 'Books/Moby.epub', loc: u.searchParams.get('loc')! })!.location).toEqual(loc);
    const old = JSON.stringify({ kind: 'epub', value: { section: 7, start: 3, end: 18 }, label: '§ 7' });
    expect(parseMarginParams({ file: 'Books/Moby.epub', loc: old })!.location).toEqual(loc);
    // Still safe inside a Markdown link.
    expect(buildObsidianUrl('Books/Moby.epub', loc)).not.toMatch(/[()\s]/);
  });
});
