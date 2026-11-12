import { describe, expect, it, vi } from 'vitest';
import { OutlineCache } from '../src/mirror/outline';
import { epubLocation } from '../../src/lib/location';
import { makeEpub, xhtml } from '../../src/renderers/epub/testEpub';

describe('OutlineCache', () => {
  it('reads a book’s outline once, through the host’s pdf.js', async () => {
    const doc = {
      numPages: 9,
      getOutline: vi.fn(async () => [{ title: ' Economy ', dest: [{ num: 1, gen: 0 }], items: [] }]),
      getDestination: vi.fn(async () => null),
      getPageIndex: vi.fn(async () => 0),
      destroy: vi.fn(async () => {}),
    };
    const lib = { getDocument: vi.fn(() => ({ promise: Promise.resolve(doc) })) };
    const readBytes = vi.fn(async () => new ArrayBuffer(4));
    const cache = new OutlineCache(readBytes, () => lib as never);
    expect(await cache.get('b1', 'Books/a.pdf')).toEqual([{ title: 'Economy', page: 1, children: [] }]);
    await cache.get('b1', 'Books/a.pdf');
    expect(lib.getDocument).toHaveBeenCalledTimes(1);
    expect(readBytes).toHaveBeenCalledWith('Books/a.pdf');
    expect(doc.destroy).toHaveBeenCalled();
  });

  it('an unreadable PDF has an empty outline', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = new OutlineCache(async () => Promise.reject(new Error('gone')), () => ({}) as never);
    expect(await cache.get('b1', 'Books/a.pdf')).toEqual([]);
    warn.mockRestore();
  });

  it('a failure is not cached: the next get reads again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const readBytes = vi.fn(async () => new ArrayBuffer(4)).mockRejectedValueOnce(new Error('busy'));
    const doc = { numPages: 1, getOutline: async () => [], getDestination: async () => null, getPageIndex: async () => 0, destroy: async () => {} };
    const cache = new OutlineCache(readBytes, () => ({ getDocument: () => ({ promise: Promise.resolve(doc) }) }) as never);
    expect(await cache.get('b1', 'Books/a.pdf')).toEqual([]);
    expect(await cache.get('b1', 'Books/a.pdf')).toEqual([]);
    expect(readBytes).toHaveBeenCalledTimes(2);
    await cache.get('b1', 'Books/a.pdf');
    expect(readBytes).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('a new version (the PDF replaced at its path) reads again; forget and clear drop entries', async () => {
    const readBytes = vi.fn(async () => new ArrayBuffer(4));
    const doc = { numPages: 1, getOutline: async () => [], getDestination: async () => null, getPageIndex: async () => 0, destroy: async () => {} };
    const cache = new OutlineCache(readBytes, () => ({ getDocument: () => ({ promise: Promise.resolve(doc) }) }) as never);
    await cache.get('b1', 'Books/a.pdf', 'h1');
    await cache.get('b1', 'Books/a.pdf', 'h1');
    expect(readBytes).toHaveBeenCalledTimes(1);
    await cache.get('b1', 'Books/a.pdf', 'h2');
    expect(readBytes).toHaveBeenCalledTimes(2);
    cache.forget('b1');
    await cache.get('b1', 'Books/a.pdf', 'h2');
    expect(readBytes).toHaveBeenCalledTimes(3);
    cache.clear();
    await cache.get('b1', 'Books/a.pdf', 'h2');
    expect(readBytes).toHaveBeenCalledTimes(4);
  });
});

describe('OutlineCache: an EPUB (E7)', () => {
  const nav = xhtml(
    '<nav epub:type="toc"><ol>' +
      '<li><a href="text/a.xhtml">Etymology</a></li>' +
      '<li><a href="text/b.xhtml">Loomings</a><ol><li><a href="text/b.xhtml#bag">The Carpet-Bag</a></li></ol></li>' +
      '</ol></nav>',
  );
  const bytes = () =>
    makeEpub({
      title: 'Moby-Dick',
      nav,
      sections: [
        { name: 'a.xhtml', html: '<p>Whale.</p>' },
        { name: 'b.xhtml', html: '<p>Call me Ishmael.</p><h2 id="bag">The Carpet-Bag</h2><p>I stuffed a shirt.</p>' },
      ],
    });

  it('is the book’s TOC, each entry at its section, a fragment entry also at its text offset; pdf.js is never asked', async () => {
    const lib = { getDocument: vi.fn() };
    const cache = new OutlineCache(async () => bytes(), () => lib as never);
    const outline = await cache.get('m', 'Books/Moby.epub', 'v1', 'epub');
    expect(lib.getDocument).not.toHaveBeenCalled();
    expect(outline.map((e) => [e.title, e.page])).toEqual([['Etymology', 1], ['Loomings', 2]]);
    expect(outline[0].at).toBeUndefined();
    const bag = outline[1].children[0];
    expect(bag.title).toBe('The Carpet-Bag');
    expect(bag.page).toBe(2);
    const start = bag.at?.kind === 'epub' ? bag.at.value.start : -1;
    // After "Call me Ishmael." (and the block break the sanitiser keeps between them).
    expect(start).toBeGreaterThanOrEqual('Call me Ishmael.'.length);
    expect(start).toBeLessThanOrEqual('Call me Ishmael.'.length + 1);
    expect(bag.at).toEqual(epubLocation({ section: 2, start, end: start }));
  });

  it('an unreadable EPUB has an empty outline', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = new OutlineCache(async () => new Uint8Array([1, 2, 3]).buffer, () => ({}) as never);
    expect(await cache.get('m', 'Books/Moby.epub', 'v1', 'epub')).toEqual([]);
    warn.mockRestore();
  });
});
