import { buildNotebook, type NotebookEntry } from '../../../src/features/notebook/notebookModel';
import { thoughtLabel, thoughtPlace } from '../../../src/lib/labels';
import { placeName } from '../../../src/lib/location';
import { displayQuote } from '../../../src/lib/quote';
import { sectionPathAt } from '../../../src/lib/outline';
import type { Annotation, Book, Location, OutlineEntry, Thought } from '../../../src/lib/types';
import { buildObsidianUrl } from '../links';

export const MIRROR_NOTICE =
  '<!-- This note is written by Readside. Edit thoughts in Readside; changes made here are kept in a conflict copy. -->';

export interface MirrorInput {
  book: Book;
  annotations: Annotation[];
  thoughts: Thought[];
  /** The book's outline, for the section headings; [] when it has none. */
  outline: readonly OutlineEntry[];
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** `%%` opens an Obsidian comment (hiding the rest of the note): written `%&#37;`, so no `%%` survives. */
const noComment = (s: string) => s.replace(/%%/g, '%&#37;');

/**
 * Quoted book text (a highlight, an auto-label snippet), kept readable: only what makes Obsidian load,
 * link or hide something is neutralised: `<` (raw HTML) as `&lt;`, `![` (an image embed) as `!\[`, the
 * second `[` of `[[` (a wikilink) as `\[`, and `%%` (a comment) as `%&#37;`. Prose without them comes out
 * unchanged.
 */
export const quoteText = (s: string): string =>
  noComment(s.replace(/</g, '&lt;').replace(/\[\[+/g, (run) => `[${'\\['.repeat(run.length - 1)}`).replace(/!\[/g, '!\\['));

/**
 * Book text (an OPF title, a TOC entry) as literal Markdown text: Markdown's specials are backslash-escaped,
 * `<` becomes `&lt;` and `%%` becomes `%&#37;`, so a title can't embed a remote image, a raw HTML tag, a
 * wikilink, a tag or a comment in the vault. A title without any of them comes out unchanged.
 */
export const mdText = (s: string): string => noComment(s.replace(/[\\[\]!*_#|`]/g, (c) => `\\${c}`).replace(/</g, '&lt;'));
const fileStem = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The book's title, else its file name without the extension. */
export const bookTitle = (book: Book): string => book.title?.trim() || fileStem(book.path);

/** A wikilink to the book file; a path with `|`, `#`, `^` or `]]` would break one, so it is the plain path then. */
const bookLink = (path: string) => (/[|#^]|\]\]/.test(path) ? path : `[[${path}]]`);

/** `[p. 42](obsidian://readside?…)`; an EPUB place is named by its section (`§ 7`), whatever its stored label says. */
const pageLink = (path: string, location: Location) =>
  `[${location.kind === 'epub' ? placeName(location) : location.label}](${buildObsidianUrl(path, location)})`;

function quoteBlock(book: Book, a: Annotation, location: Location | null): string[] {
  const { path } = book;
  const lines = [location ? `> [!quote] ${pageLink(path, location)}` : '> [!quote]'];
  for (const l of displayQuote(a.quote, location?.kind ?? book.format).split(/\r\n?|\n/)) lines.push(`> ${quoteText(l)}`.trimEnd());
  if (a.note) {
    lines.push('>');
    a.note.split('\n').forEach((l, i) => lines.push((i === 0 ? `> *Note:* ${l}` : `> ${l}`).trimEnd()));
  }
  return lines;
}

function thoughtBlock(path: string, t: Thought, location: Location | null, anchors: ReadonlyMap<string, Annotation>): string[] {
  const label = thoughtLabel(t, thoughtPlace(t, anchors));
  // An automatic label quotes the book; a custom one is the reader's own text.
  const heading = label.kind === 'custom' ? label.text : label.kind === 'auto' ? quoteText(label.snippet) : 'Note';
  const lines = [`### ${oneLine(heading)}`];
  if (location) lines.push(pageLink(path, location));
  const body = t.body.replace(/\s+$/, '');
  if (body) lines.push(body);
  return lines;
}

/**
 * The book's notebook as Markdown (spec §6), in the desktop notebook's order: general thoughts under
 * "Notes" first, then one section per outline entry, "No section" for placed entries before the first
 * outline entry (or without an outline), "Unanchored" highlights last. Pure.
 */
export function generateMirror({ book, annotations, thoughts, outline }: MirrorInput): string {
  const anchors = new Map(annotations.map((a) => [a.id, a]));
  const general: string[][] = [];
  const unanchored: string[][] = [];
  const noSection: string[][] = [];
  // Keyed by the outline entry itself, so two sections with the same title stay apart.
  const sections = new Map<OutlineEntry, string[][]>();
  const block = (e: NotebookEntry) =>
    e.kind === 'annotation' ? quoteBlock(book, e.annotation, e.location) : thoughtBlock(book.path, e.thought, e.location, anchors);

  for (const group of buildNotebook(annotations, thoughts)) {
    for (const e of group.entries) {
      if (group.key === 'general') general.push(block(e));
      else if (group.key === 'unanchored') unanchored.push(block(e));
      else {
        const path = e.location ? sectionPathAt(outline, e.location) : [];
        const section = path.length ? path[path.length - 1] : null;
        if (!section) noSection.push(block(e));
        else sections.set(section, [...(sections.get(section) ?? []), block(e)]);
      }
    }
  }

  const out = [
    '---',
    `margin-book: ${JSON.stringify(bookLink(book.path))}`,
    `margin-progress: ${round2(book.progress ?? 0)}`,
    'tags: [margin]',
    '---',
    MIRROR_NOTICE,
    `# ${mdText(oneLine(bookTitle(book)))}`,
  ];
  /** `title` is Markdown as is: Margin's own headings pass plain text, book text passes through mdText. */
  const section = (title: string, blocks: string[][]) => {
    if (blocks.length === 0) return;
    out.push('', `## ${title}`);
    for (const b of blocks) out.push('', ...b);
  };
  section('Notes', general);
  for (const [entry, blocks] of sections) section(mdText(oneLine(entry.title)), blocks);
  section('No section', noSection);
  section('Unanchored', unanchored);
  return `${out.join('\n')}\n`;
}
