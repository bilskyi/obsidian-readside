import { describe, expect, it } from 'vitest';
import { pdfLocation, serializeLocation } from '../../src/lib/location';
import type { Annotation, Book, Location, OutlineEntry, Thought } from '../../src/lib/types';
import { buildObsidianUrl } from '../src/links';
import { generateMirror, MIRROR_NOTICE } from '../src/mirror/generate';
import { epubLocation, epubPoint } from '../../src/lib/location';

const PATH = 'Books/Walden.pdf';
const book: Book = {
  id: 'b1', contentHash: 'h', path: PATH, format: 'pdf', title: 'Walden', author: null, lastLocation: null,
  addedAt: 't0', openedAt: null, zoom: null, progress: 0.4234,
};
const outline: OutlineEntry[] = [
  { title: 'Economy', page: 1, children: [] },
  { title: 'Where I Lived', page: 5, children: [] },
];
const at = (page: number, start = 0, end = 0) => pdfLocation({ page, start, end });
const annotation = (id: string, location: Location, quote: string, extra: Partial<Annotation> = {}): Annotation => ({
  id, bookId: 'b1', location: serializeLocation(location), quote, color: 'yellow', note: null, unanchored: false,
  createdAt: id, updatedAt: id, ...extra,
});
const thought = (id: string, extra: Partial<Thought>): Thought => ({
  id, bookId: 'b1', body: '', anchorId: null, location: null, position: 1, createdAt: 't', updatedAt: 't',
  labelSection: null, labelSnippet: null, labelCustom: null, ...extra,
});
const L = (loc: Location) => buildObsidianUrl(PATH, loc);

describe('generateMirror', () => {
  it('writes the notebook as Markdown (golden)', () => {
    const a1 = at(2, 0, 19);
    const a2 = at(6, 4, 23);
    const pin = at(5);
    const md = generateMirror({
      book,
      outline,
      annotations: [
        annotation('a1', a1, 'Simplify, simplify.'),
        annotation('a2', a2, 'I went to the woods', { note: 'deliberately' }),
        annotation('a3', at(9, 0, 9), 'Lost line', { unanchored: true }),
      ],
      thoughts: [
        thought('g1', { body: 'Overall idea', position: 1 }),
        thought('t1', { anchorId: 'a1', body: 'Less is more.\n', position: 2, labelSection: 'Economy', labelSnippet: 'p. 2 · “Simplify, simplify.”' }),
        thought('t2', { location: serializeLocation(pin), labelCustom: 'My pin', position: 3 }),
      ],
    });
    expect(md).toBe(
      [
        '---',
        'margin-book: "[[Books/Walden.pdf]]"',
        'margin-progress: 0.42',
        'tags: [margin]',
        '---',
        MIRROR_NOTICE,
        '# Walden',
        '',
        '## Notes',
        '',
        '### Note',
        'Overall idea',
        '',
        '## Economy',
        '',
        `> [!quote] [p. 2](${L(a1)})`,
        '> Simplify, simplify.',
        '',
        '### p. 2 · “Simplify, simplify.”',
        `[p. 2](${L(a1)})`,
        'Less is more.',
        '',
        '## Where I Lived',
        '',
        '### My pin',
        `[p. 5](${L(pin)})`,
        '',
        `> [!quote] [p. 6](${L(a2)})`,
        '> I went to the woods',
        '>',
        '> *Note:* deliberately',
        '',
        '## Unanchored',
        '',
        '> [!quote]',
        '> Lost line',
        '',
      ].join('\n'),
    );
  });

  it('an empty book: front matter, notice and title; the title falls back to the file name; the path is YAML-quoted', () => {
    const md = generateMirror({ book: { ...book, title: null, path: 'Books/He said "hi".pdf', progress: null }, annotations: [], thoughts: [], outline: [] });
    expect(md).toBe(
      ['---', 'margin-book: "[[Books/He said \\"hi\\".pdf]]"', 'margin-progress: 0', 'tags: [margin]', '---', MIRROR_NOTICE, '# He said "hi"', ''].join('\n'),
    );
  });

  it('without an outline placed entries go under "No section"; a thought without a stored label is named by its page; bodies are verbatim', () => {
    const md = generateMirror({
      book,
      outline: [],
      annotations: [annotation('a1', at(2, 0, 1), 'Q')],
      thoughts: [thought('t1', { anchorId: 'a1', body: '## Heading in a body\n- item' })],
    });
    expect(md).toContain('## No section\n\n> [!quote]');
    expect(md).toContain('### p. 2\n[p. 2](');
    expect(md).toContain('## Heading in a body\n- item\n');
  });

  it('a path a wikilink can’t hold (| # ^ ]]) is written as the plain quoted path; the YAML stays one valid line', () => {
    for (const path of ['Books/a|b.pdf', 'Books/a#b.pdf', 'Books/a^b.pdf', 'Books/a]]b.pdf', 'Books/"q" #1.pdf']) {
      const md = generateMirror({ book: { ...book, path }, annotations: [], thoughts: [], outline: [] });
      const line = md.split('\n')[1];
      expect(line).toBe(`margin-book: ${JSON.stringify(path)}`);
      expect(JSON.parse(line.slice('margin-book: '.length))).toBe(path);
    }
    const plain = generateMirror({ book: { ...book, path: 'Books/a [draft] (1).pdf' }, annotations: [], thoughts: [], outline: [] });
    expect(plain.split('\n')[1]).toBe('margin-book: "[[Books/a [draft] (1).pdf]]"');
  });
});

describe('generateMirror: an epub', () => {
  it('files each entry under the outline entry its exact target puts it in', () => {
    const toc: OutlineEntry[] = [
      { title: 'Loomings', page: 2, children: [], at: epubPoint(2, 0) },
      { title: 'The Carpet-Bag', page: 2, children: [], at: epubPoint(2, 400) },
    ];
    const md = generateMirror({
      book: { ...book, path: 'Books/Moby.epub', format: 'epub' },
      outline: toc,
      annotations: [
        annotation('e1', epubLocation({ section: 2, start: 10, end: 25 }), 'Call me Ishmael'),
        annotation('e2', epubLocation({ section: 2, start: 500, end: 520 }), 'Nantucket'),
      ],
      thoughts: [],
    });
    const loomings = md.indexOf('## Loomings');
    const carpet = md.indexOf('## The Carpet-Bag');
    expect(loomings).toBeGreaterThan(-1);
    expect(carpet).toBeGreaterThan(loomings);
    expect(md.indexOf('Call me Ishmael')).toBeGreaterThan(loomings);
    expect(md.indexOf('Call me Ishmael')).toBeLessThan(carpet);
    expect(md.indexOf('Nantucket')).toBeGreaterThan(carpet);
  });
});

describe('generateMirror: an epub book (E7)', () => {
  it('writes the notebook grouped by TOC sections, links named § N carrying the epub location (golden)', () => {
    const MOBY = 'Books/Moby.epub';
    const moby: Book = { ...book, id: 'm', path: MOBY, format: 'epub', title: 'Moby-Dick', author: 'Herman Melville', progress: 0.25 };
    const toc: OutlineEntry[] = [
      { title: 'Etymology', page: 1, children: [] },
      { title: 'Loomings', page: 2, children: [{ title: 'The Carpet-Bag', page: 2, children: [], at: epubPoint(2, 400) }] },
    ];
    const h1 = epubLocation({ section: 2, start: 0, end: 15 });
    const h2 = epubLocation({ section: 2, start: 410, end: 420 });
    // A stored label that is not § N: the link still names the section.
    const pin: Location = { ...epubPoint(1, 0, 0.5), label: 'stale' };
    const E = (loc: Location) => buildObsidianUrl(MOBY, loc);
    const md = generateMirror({
      book: moby,
      outline: toc,
      annotations: [annotation('h1', h1, 'Call me Ishmael'), annotation('h2', h2, 'a shirt or two')],
      thoughts: [
        thought('t1', { anchorId: 'h1', body: 'Opening.', position: 1, labelSection: 'Loomings', labelSnippet: '§ 2 · “Call me Ishmael”' }),
        thought('t2', { location: serializeLocation(pin), labelCustom: 'Whale words', position: 2 }),
      ],
    });
    expect(md).toBe(
      [
        '---',
        'margin-book: "[[Books/Moby.epub]]"',
        'margin-progress: 0.25',
        'tags: [margin]',
        '---',
        MIRROR_NOTICE,
        '# Moby-Dick',
        '',
        '## Etymology',
        '',
        '### Whale words',
        `[§ 1](${E(pin)})`,
        '',
        '## Loomings',
        '',
        `> [!quote] [§ 2](${E(h1)})`,
        '> Call me Ishmael',
        '',
        '### § 2 · “Call me Ishmael”',
        `[§ 2](${E(h1)})`,
        'Opening.',
        '',
        '## The Carpet-Bag',
        '',
        `> [!quote] [§ 2](${E(h2)})`,
        '> a shirt or two',
        '',
      ].join('\n'),
    );
    const u = new URL(E(h2));
    expect(JSON.parse(u.searchParams.get('loc')!)).toEqual({ kind: 'epub', value: { section: 2, start: 410, end: 420, v: 3 }, label: '§ 2' });
  });
});

describe('generateMirror: book text is literal Markdown (E7 fix round 1)', () => {
  it('a hostile title and TOC entry are escaped: no remote image, HTML tag, wikilink or tag reaches the note (golden)', () => {
    const md = generateMirror({
      book: { ...book, title: '<img src=https://x/t.gif> ![](https://x/a.png) [[x]] #tag', path: 'Books/Evil.epub', format: 'epub', progress: 0 },
      outline: [{ title: 'Part_1 | *bold* `code` \\ <b>', page: 1, children: [] }],
      annotations: [annotation('a1', epubLocation({ section: 1, start: 0, end: 3 }), 'Hi!')],
      thoughts: [],
    });
    const loc = epubLocation({ section: 1, start: 0, end: 3 });
    expect(md).toBe(
      [
        '---',
        'margin-book: "[[Books/Evil.epub]]"',
        'margin-progress: 0',
        'tags: [margin]',
        '---',
        MIRROR_NOTICE,
        '# &lt;img src=https://x/t.gif> \\!\\[\\](https://x/a.png) \\[\\[x\\]\\] \\#tag',
        '',
        '## Part\\_1 \\| \\*bold\\* \\`code\\` \\\\ &lt;b>',
        '',
        `> [!quote] [§ 1](${buildObsidianUrl('Books/Evil.epub', loc)})`,
        '> Hi!',
        '',
      ].join('\n'),
    );
  });

  it('an ordinary title and TOC entry come out byte for byte as before', () => {
    const md = generateMirror({ book: { ...book, title: 'Walden; or, Life in the Woods (1854) — “Economy”' }, outline: [{ title: 'Where I Lived, and What I Lived For', page: 1, children: [] }], annotations: [annotation('a1', at(1, 0, 1), 'Q')], thoughts: [] });
    expect(md).toContain('\n# Walden; or, Life in the Woods (1854) — “Economy”\n');
    expect(md).toContain('\n## Where I Lived, and What I Lived For\n');
  });
});

describe('generateMirror: quoted book text can’t load anything (E7 fix round 2)', () => {
  it('a hostile quote and snippet: < becomes &lt;, ![ becomes !\\[, everything else verbatim (golden)', () => {
    const a1 = at(1, 0, 40);
    const md = generateMirror({
      book,
      outline: [],
      annotations: [annotation('a1', a1, '<img src=https://x/t.gif> and ![](https://x)\nWow! [a] *b* _c_ #d')],
      thoughts: [thought('t1', { anchorId: 'a1', body: 'mine <b>', position: 1, labelSnippet: 'p. 1 · “<img src=https://x/t.gif> ![](https://x)”' })],
    });
    expect(md.split('\n').slice(7).join('\n')).toBe(
      [
        '',
        '## No section',
        '',
        `> [!quote] [p. 1](${L(a1)})`,
        '> &lt;img src=https://x/t.gif> and !\\[](https://x)',
        '> Wow! [a] *b* _c_ #d',
        '',
        '### p. 1 · “&lt;img src=https://x/t.gif> !\\[](https://x)”',
        `[p. 1](${L(a1)})`,
        'mine <b>',
        '',
      ].join('\n'),
    );
  });
});

describe('generateMirror: comments and wikilinks in book text (final review A4)', () => {
  it('%% becomes %&#37; and the second [ of [[ is escaped, in quotes, snippets and titles; no raw %% or [[ is left (golden)', () => {
    const a1 = at(1, 0, 40);
    const md = generateMirror({
      book: { ...book, title: 'Odd %%hidden%% title' },
      outline: [{ title: 'Part %%% one', page: 1, children: [] }],
      annotations: [annotation('a1', a1, 'see [[Secret note]] and [[[x]]] %%comment%% 100%%%\r\nnext line\rthird')],
      thoughts: [thought('t1', { anchorId: 'a1', position: 1, labelSnippet: 'p. 1 · “[[Secret note]] %%c%%”' })],
    });
    expect(md.split('\n').slice(6).join('\n')).toBe(
      [
        '# Odd %&#37;hidden%&#37; title',
        '',
        '## Part %&#37;% one',
        '',
        `> [!quote] [p. 1](${L(a1)})`,
        '> see [\\[Secret note]] and [\\[\\[x]]] %&#37;comment%&#37; 100%&#37;%',
        '> next line',
        '> third',
        '',
        '### p. 1 · “[\\[Secret note]] %&#37;c%&#37;”',
        `[p. 1](${L(a1)})`,
        '',
      ].join('\n'),
    );
    const body = md.slice(md.indexOf(MIRROR_NOTICE) + MIRROR_NOTICE.length);
    expect(body).not.toContain('%%');
    expect(body).not.toContain('[[');
  });

  it('ordinary PDF prose (spacing, tabs, single % and [) comes out byte for byte as before', () => {
    const a1 = at(1, 0, 40);
    const quote = 'Wow!  two  spaces, 50% off [sic]\n\tindented line ';
    const md = generateMirror({ book, outline: [], annotations: [annotation('a1', a1, quote)], thoughts: [] });
    expect(md).toContain(`\n> [!quote] [p. 1](${L(a1)})\n> Wow!  two  spaces, 50% off [sic]\n> \tindented line\n`);
  });
});

describe('generateMirror: EPUB quotes are shown without source indentation (final review A3)', () => {
  const EB = 'Books/Moby.epub';
  const moby: Book = { ...book, id: 'm', path: EB, format: 'epub', title: 'Moby-Dick' };
  const RAW = 'end.\n\t\t\tNext   para.\r\n   \n\nLast\tone ';

  it('each line collapsed and trimmed, blank lines dropped; anchored and unanchored alike', () => {
    const h = epubLocation({ section: 2, start: 0, end: 30 });
    const md = generateMirror({
      book: moby,
      outline: [],
      annotations: [annotation('h1', h, RAW), annotation('h2', h, RAW, { unanchored: true })],
      thoughts: [],
    });
    expect(md).toContain(`\n> [!quote] [§ 2](${buildObsidianUrl(EB, h)})\n> end.\n> Next para.\n> Last one\n`);
    expect(md).toContain('\n> [!quote]\n> end.\n> Next para.\n> Last one\n');
  });

  it('the same quote in a PDF keeps its spacing (only the line split changes)', () => {
    const md = generateMirror({ book, outline: [], annotations: [annotation('a1', at(1, 0, 30), RAW)], thoughts: [] });
    expect(md).toContain('\n> end.\n> \t\t\tNext   para.\n>\n>\n> Last\tone\n');
  });
});
