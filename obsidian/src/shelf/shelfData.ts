import { parseLocation, placeName, placeNameFor, spotOf } from '../../../src/lib/location';
import { bookDisplayTitle } from '../../../src/lib/titles';
import type { Color, Location } from '../../../src/lib/types';
import { formatOf, type DeepReadonly, type ShelfEntry } from '../store/bookStore';
import type { BookFile } from '../store/types';
import type { CoverView } from '../covers/covers';

/** How long typing pauses before the shelf searches. */
export const SEARCH_DEBOUNCE_MS = 250;
/** How long the shelf waits after a store change before it redraws. */
export const REFRESH_DEBOUNCE_MS = 300;
/** Book files read at the same time. */
export const LOAD_CONCURRENCY = 3;
/** Books a search reads before it shows what it has found so far. */
export const SEARCH_CHUNK = 12;
/** The most book files a search reads (the most recently changed first). */
export const MAX_SEARCH_BOOKS = 200;
/** The most book files read to find the recent thoughts. */
export const MAX_RECENT_BOOKS = 30;
/** The most book files read to find a highlight to resurface. */
export const MAX_RESURFACE_BOOKS = 12;
export const RECENT_COUNT = 5;
/** A highlight comes back once it is at least this old. */
export const RESURFACE_AGE_DAYS = 14;
export const MAX_HITS_PER_BOOK = 5;
export const MAX_HITS = 60;
/** At or above this, a book reads as finished. */
export const FINISHED_AT = 0.995;

const DAY_MS = 86_400_000;

/** A book card: the index entry and its summary, made ready to show. */
export interface ShelfBook {
  path: string;
  bookId: string;
  missing: boolean;
  title: string;
  /** From the file's extension: an EPUB's place is a section (`§ N`) and its progress a share of the book. */
  format: 'pdf' | 'epub';
  progress: number;
  page: number | null;
  pageCount: number | null;
  /** null: not known until the book is loaded once (an index from before summaries). */
  annotationCount: number | null;
  thoughtCount: number | null;
  thoughtsByMonth: Record<string, number>;
  /** For ordering: last opened, else last changed. */
  sortKey: string;
  /** The newest change to the book's highlights and thoughts ('' when not known). */
  updatedAt: string;
  /** What its cover shows (no image: the colour tile). */
  cover: CoverView;
}

const TILE: CoverView = { src: null, wantsThumb: false };

/** `coverOf`: each book's cover (absent: every book shows its colour tile). */
export function shelfBooks(entries: readonly ShelfEntry[], coverOf?: (e: ShelfEntry) => CoverView): ShelfBook[] {
  const books = entries.map((e): ShelfBook => {
    const s = e.summary;
    return {
      path: e.path,
      bookId: e.bookId,
      missing: e.missing,
      title: bookDisplayTitle({ title: s?.title ?? null, path: e.path }),
      format: formatOf(e.path),
      progress: Math.min(1, Math.max(0, s?.progress ?? 0)),
      page: s?.page ?? null,
      pageCount: s?.pageCount ?? null,
      annotationCount: s ? s.annotationCount : null,
      thoughtCount: s ? s.thoughtCount : null,
      thoughtsByMonth: s?.thoughtsByMonth ?? {},
      sortKey: e.openedAt ?? s?.updatedAt ?? '',
      updatedAt: s?.updatedAt ?? '',
      cover: coverOf ? coverOf(e) : TILE,
    };
  });
  return books.sort((a, b) => (a.sortKey !== b.sortKey ? (a.sortKey < b.sortKey ? 1 : -1) : a.title.localeCompare(b.title)));
}

/** A cover colour of the book's own, the same every time: a hue from the title, dark enough for light text. */
export function coverColor(title: string): string {
  let h = 2166136261;
  for (let i = 0; i < title.length; i++) {
    h ^= title.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  return `hsl(${hue} 28% 32%)`;
}

/**
 * "Finished", "p. 42 of 310", "p. 42", or "Not started". An EPUB's sections are not pages of even length:
 * how far in it is ("42%"), else its section ("§ 3").
 */
export function whereLabel(b: Pick<ShelfBook, 'progress' | 'page' | 'pageCount'> & { format?: ShelfBook['format'] }): string {
  if (b.progress >= FINISHED_AT) return 'Finished';
  if (b.format === 'epub') {
    if (b.progress > 0) return `${Math.max(1, Math.round(b.progress * 100))}%`;
    return b.page !== null && b.page > 1 ? placeNameFor('epub', b.page) : 'Not started';
  }
  if (b.page !== null && b.pageCount !== null) return `p. ${b.page} of ${b.pageCount}`;
  if (b.page !== null) return `p. ${b.page}`;
  return 'Not started';
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function countsLabel(b: Pick<ShelfBook, 'annotationCount' | 'thoughtCount'>): string {
  if (b.annotationCount === null || b.thoughtCount === null) return '';
  return `${plural(b.annotationCount, 'highlight', 'highlights')} · ${plural(b.thoughtCount, 'thought', 'thoughts')}`;
}

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/**
 * "4 books in this vault · 61 highlights · 23 thoughts this month"; books whose file is gone are not counted
 * as in the vault: "3 books in this vault, 1 missing · …".
 */
export function summaryLine(books: readonly ShelfBook[], now: Date): string {
  const month = monthKey(now);
  let highlights = 0;
  let thoughts = 0;
  let missing = 0;
  for (const b of books) {
    highlights += b.annotationCount ?? 0;
    thoughts += b.thoughtsByMonth[month] ?? 0;
    if (b.missing) missing++;
  }
  const present = `${plural(books.length - missing, 'book', 'books')} in this vault${missing ? `, ${missing} missing` : ''}`;
  return `${present} · ${plural(highlights, 'highlight', 'highlights')} · ${plural(thoughts, 'thought', 'thoughts')} this month`;
}

/** What a card says to a screen reader: "Walden, p. 42 of 310, 3 highlights · 1 thought". */
export function cardLabel(b: ShelfBook): string {
  return [b.title, b.missing ? 'File missing' : whereLabel(b), countsLabel(b)].filter(Boolean).join(', ');
}

/** "today", "3 days ago", "2 weeks ago", "3 months ago", "a year ago". */
export function ago(iso: string, now: Date): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / DAY_MS);
  if (!(days >= 1)) return 'today';
  if (days < 14) return days === 1 ? 'yesterday' : `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? 'a year ago' : `${years} years ago`;
}

/** Where the store's book files come from. */
export interface BookSource {
  file(bookId: string): Promise<DeepReadonly<BookFile>>;
}

export type LoadedBooks = Map<string, DeepReadonly<BookFile>>;

/**
 * Reads the books' files, `LOAD_CONCURRENCY` at a time, into `into` (books already there are not read
 * again). An unreadable book is left out. `stop` ends it early (the view closed, a newer query).
 */
export async function loadBooks(source: BookSource, ids: readonly string[], into: LoadedBooks, stop: () => boolean = () => false): Promise<void> {
  const queue = ids.filter((id) => !into.has(id));
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined && !stop(); id = queue.shift()) {
      try {
        into.set(id, await source.file(id));
      } catch {
        // an unreadable book file has nothing to show
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOAD_CONCURRENCY, queue.length) }, worker));
}

/** The location a thought points at: its own, else its highlight's. */
function thoughtLocation(f: DeepReadonly<BookFile>, t: DeepReadonly<BookFile>['thoughts'][number]): Location | null {
  if (t.location) return parseLocation(t.location);
  const a = t.anchorId ? f.annotations.find((x) => x.id === t.anchorId) : undefined;
  return a ? parseLocation(a.location) : null;
}

/** The page (pdf) or section (epub) of a location; null without one. */
const pageOf = (loc: Location | null) => (loc ? (spotOf(loc)?.page ?? null) : null);

/** What a location's place is called on the shelf: `p. 42` (pdf), `§ 7` (epub); null without a page. */
export const placeOf = (loc: Location | null): string | null => (loc && spotOf(loc) ? placeName(loc) : null);

/** A thought's Markdown as one line of plain text. */
export function plainText(md: string): string {
  return md
    .replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]+)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/(\*\*|__|\*|_|`|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- search ----

export interface Snippet {
  before: string;
  match: string;
  after: string;
}

export interface SearchHit {
  kind: 'highlight' | 'thought';
  id: string;
  snippet: Snippet;
  location: Location | null;
  page: number | null;
}

export interface SearchGroup {
  book: ShelfBook;
  hits: SearchHit[];
  /** Matches in this book beyond the ones shown. */
  more: number;
}

const SNIPPET_SIDE = 48;

/** The text around the first match, cut at word boundaries, with "…" where it was cut. */
export function snippetAround(text: string, at: number, length: number): Snippet {
  let start = Math.max(0, at - SNIPPET_SIDE);
  let end = Math.min(text.length, at + length + SNIPPET_SIDE);
  if (start > 0) {
    const sp = text.indexOf(' ', start);
    if (sp !== -1 && sp < at) start = sp + 1;
  }
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end);
    if (sp > at + length) end = sp;
  }
  return {
    before: (start > 0 ? '…' : '') + text.slice(start, at),
    match: text.slice(at, at + length),
    after: text.slice(at + length, end) + (end < text.length ? '…' : ''),
  };
}

/** The books the query is to read, most recently changed first, at most MAX_SEARCH_BOOKS; missing books are left out. */
export function searchOrder(books: readonly ShelfBook[]): string[] {
  return books
    .filter((b) => !b.missing && (b.annotationCount === null || b.annotationCount + (b.thoughtCount ?? 0) > 0))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, MAX_SEARCH_BOOKS)
    .map((b) => b.bookId);
}

/** Highlights (their text and note) and thoughts that contain the query, ignoring case, grouped by book in shelf order. */
export function searchBooks(query: string, books: readonly ShelfBook[], loaded: LoadedBooks): SearchGroup[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [];
  const groups: SearchGroup[] = [];
  let shown = 0;
  for (const book of books) {
    const f = loaded.get(book.bookId);
    if (!f || book.missing) continue;
    const hits: SearchHit[] = [];
    let total = 0;
    const consider = (kind: SearchHit['kind'], id: string, text: string, location: Location | null) => {
      const at = text.toLocaleLowerCase().indexOf(q);
      if (at === -1) return false;
      total++;
      if (hits.length < MAX_HITS_PER_BOOK && shown < MAX_HITS) {
        hits.push({ kind, id, snippet: snippetAround(text, at, q.length), location, page: pageOf(location) });
        shown++;
      }
      return true;
    };
    for (const a of f.annotations) {
      const loc = parseLocation(a.location);
      if (!consider('highlight', a.id, a.quote.replace(/\s+/g, ' '), loc) && a.note) consider('highlight', a.id, a.note.replace(/\s+/g, ' '), loc);
    }
    for (const t of f.thoughts) consider('thought', t.id, plainText(t.body), thoughtLocation(f, t));
    if (hits.length) groups.push({ book, hits, more: total - hits.length });
  }
  return groups;
}

// ---- recent thoughts ----

export interface RecentThought {
  id: string;
  book: ShelfBook;
  text: string;
  location: Location | null;
  page: number | null;
  /** The highlight colour it hangs off, else null (a thought at a place). */
  color: Color | null;
  updatedAt: string;
}

/**
 * The newest `count` thoughts by `updatedAt`. Books are read newest change first, and reading stops once
 * no unread book can hold a newer thought than the ones found (a summary's `updatedAt` bounds its thoughts);
 * at most MAX_RECENT_BOOKS are read. Missing books are left out (they can't be opened).
 */
export async function recentThoughts(books: readonly ShelfBook[], source: BookSource, loaded: LoadedBooks, stop: () => boolean = () => false, count = RECENT_COUNT): Promise<RecentThought[]> {
  const candidates = books
    .filter((b) => !b.missing && (b.thoughtCount === null || b.thoughtCount > 0))
    // Unknown books first: nothing bounds them.
    .sort((a, b) => (a.thoughtCount === null) !== (b.thoughtCount === null) ? (a.thoughtCount === null ? -1 : 1) : a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)
    .slice(0, MAX_RECENT_BOOKS);
  const found: RecentThought[] = [];
  for (let i = 0; i < candidates.length && !stop(); i += LOAD_CONCURRENCY) {
    const next = candidates[i];
    if (found.length >= count && next.thoughtCount !== null && found[count - 1].updatedAt >= next.updatedAt) break;
    const chunk = candidates.slice(i, i + LOAD_CONCURRENCY);
    await loadBooks(source, chunk.map((b) => b.bookId), loaded, stop);
    for (const book of chunk) {
      const f = loaded.get(book.bookId);
      if (!f) continue;
      for (const t of f.thoughts) {
        const text = plainText(t.body);
        if (!text) continue;
        const location = thoughtLocation(f, t);
        const anchor = t.anchorId ? f.annotations.find((a) => a.id === t.anchorId) : undefined;
        found.push({ id: t.id, book, text, location, page: pageOf(location), color: anchor?.color ?? null, updatedAt: t.updatedAt });
      }
    }
    found.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    found.length = Math.min(found.length, count);
  }
  return found;
}

// ---- from your shelf, a while ago ----

export interface Resurfaced {
  id: string;
  book: ShelfBook;
  quote: string;
  location: Location | null;
  page: number | null;
  createdAt: string;
}

/**
 * A random highlight at least RESURFACE_AGE_DAYS old, other than `skip` when there is another. Books are
 * tried in random order, a few at a time, until one has such a highlight; at most MAX_RESURFACE_BOOKS are read.
 */
export async function resurface(
  books: readonly ShelfBook[],
  source: BookSource,
  loaded: LoadedBooks,
  now: Date,
  random: () => number,
  skip: string | null = null,
  stop: () => boolean = () => false,
): Promise<Resurfaced | null> {
  const cutoff = new Date(now.getTime() - RESURFACE_AGE_DAYS * DAY_MS).toISOString();
  const candidates = books.filter((b) => !b.missing && (b.annotationCount === null || b.annotationCount > 0));
  // Fisher–Yates with the given random source.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const tried = candidates.slice(0, MAX_RESURFACE_BOOKS);
  const pool: Resurfaced[] = [];
  let skipped: Resurfaced | null = null;
  for (let i = 0; i < tried.length && !stop(); i += LOAD_CONCURRENCY) {
    const chunk = tried.slice(i, i + LOAD_CONCURRENCY);
    await loadBooks(source, chunk.map((b) => b.bookId), loaded, stop);
    for (const book of chunk) {
      const f = loaded.get(book.bookId);
      if (!f) continue;
      for (const a of f.annotations) {
        if (a.createdAt > cutoff || !a.quote.trim()) continue;
        const location = parseLocation(a.location);
        const r = { id: a.id, book, quote: a.quote.replace(/\s+/g, ' ').trim(), location, page: pageOf(location), createdAt: a.createdAt };
        if (a.id === skip) skipped = r;
        else pool.push(r);
      }
    }
    if (pool.length) break;
  }
  if (!pool.length) return skipped;
  return pool[Math.floor(random() * pool.length)];
}
