import { describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian';
import { PdfPicker, pdfLinkAt, recentFirst } from '../src/open';
import { bookLinkAt, isBook } from '../src/open';
import { pdfBytes } from './helpers';

describe('pdfLinkAt', () => {
  const line = 'See [[Books/Walden.pdf]] and [[Notes/x]] today';

  it('finds the wiki link under the cursor', () => {
    expect(pdfLinkAt(line, 8)).toBe('Books/Walden.pdf');
    expect(pdfLinkAt(line, 4)).toBe('Books/Walden.pdf');
  });

  it('ignores a heading and an alias', () => {
    expect(pdfLinkAt('[[Walden.pdf#Economy|the book]]', 3)).toBe('Walden.pdf');
  });

  it('reads a Markdown link, decoding %20', () => {
    expect(pdfLinkAt('[book](Books/My%20Walden.pdf)', 2)).toBe('Books/My Walden.pdf');
  });

  it('reads a Markdown link with an angle-bracket path', () => {
    expect(pdfLinkAt('See [book](<Books/My Walden.pdf>) here', 6)).toBe('Books/My Walden.pdf');
    expect(pdfLinkAt('[x](<Notes/a b.md>)', 2)).toBeNull();
  });

  it('is null outside a link, for a link to something else, and for a URL', () => {
    expect(pdfLinkAt(line, 1)).toBeNull();
    expect(pdfLinkAt(line, 32)).toBeNull();
    expect(pdfLinkAt('[x](https://example.com/a.pdf)', 2)).toBeNull();
  });
});

describe('recentFirst', () => {
  it('lists PDFs only: opened ones newest first, then the rest by path', () => {
    const app = new App();
    const a = app.vault.addBinary('B/a.pdf', pdfBytes());
    const b = app.vault.addBinary('B/b.pdf', pdfBytes());
    const c = app.vault.addBinary('A/c.PDF', pdfBytes());
    const n = app.vault.addBinary('B/n.md', pdfBytes());
    const opened = new Map([
      ['B/b.pdf', '2026-11-01T00:00:00.000Z'],
      ['B/a.pdf', '2026-11-09T00:00:00.000Z'],
    ]);
    expect(recentFirst([n, c, b, a], opened).map((f) => f.path)).toEqual(['B/a.pdf', 'B/b.pdf', 'A/c.PDF']);
  });
});

describe('PdfPicker', () => {
  it('offers the files by path and opens the chosen one', () => {
    const app = new App();
    const f = app.vault.addBinary('B/a.pdf', pdfBytes());
    const choose = vi.fn();
    const picker = new PdfPicker(app, [f], choose);
    expect(picker.getItems()).toEqual([f]);
    expect(picker.getItemText(f)).toBe('B/a.pdf');
    picker.onChooseItem(f);
    expect(choose).toHaveBeenCalledWith(f);
  });
});

describe('EPUBs are books (E7)', () => {
  const fileOf = (path: string) => {
    const app = new App();
    return app.vault.addBinary(path, pdfBytes());
  };

  it('isBook: pdf and epub in any case; not a note', () => {
    expect(isBook(fileOf('x.EPUB'))).toBe(true);
    expect(isBook(fileOf('y.pdf'))).toBe(true);
    expect(isBook(fileOf('z.md'))).toBe(false);
    expect(isBook(null)).toBe(false);
  });

  it('bookLinkAt finds an .epub link (wiki or Markdown); pdfLinkAt still finds PDFs only', () => {
    expect(bookLinkAt('see [[Moby.epub]] here', 9)).toBe('Moby.epub');
    expect(bookLinkAt('[m](Books/Moby%20Dick.epub#x)', 2)).toBe('Books/Moby Dick.epub');
    expect(bookLinkAt('see [[Walden.pdf]] here', 9)).toBe('Walden.pdf');
    expect(bookLinkAt('see [[Notes.md]] here', 9)).toBeNull();
    expect(pdfLinkAt('see [[Moby.epub]] here', 9)).toBeNull();
  });

  it('recentFirst lists EPUBs with the PDFs; the picker says it opens a book', () => {
    const app = new App();
    const a = app.vault.addBinary('B/a.pdf', pdfBytes());
    const m = app.vault.addBinary('B/m.epub', pdfBytes());
    const n = app.vault.addBinary('B/n.md', pdfBytes());
    expect(recentFirst([n, m, a], new Map([['B/m.epub', '2026-11-09T00:00:00.000Z']])).map((f) => f.path)).toEqual(['B/m.epub', 'B/a.pdf']);
    const picker = new PdfPicker(app, [m, a], () => {}) as PdfPicker & { placeholder: string };
    expect(picker.placeholder).toBe('Open a book in Margin');
  });
});
