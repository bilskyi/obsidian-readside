import { parseLocation, spotOf } from '../../../src/lib/location';
import { displayTitle } from '../../../src/lib/titles';
import type { BookEntry } from '../../../src/lib/types';
import { MarginError, notFound } from './errors';
import { COVER_EXTENSIONS, type BookFile, type BookSummary, type CoverChoice, type CoverExt, type IndexEntry, type IndexFile, type StoreAdapter } from './types';

export const WRITE_COALESCE_MS = 50;
export const BACKUPS_KEPT = 7;
/** How long index summary updates gather after a book write before the index is written (flush writes them at once). */
export const SUMMARY_COALESCE_MS = 500;
/**
 * How long a summary that only moved the reading position (progress, page) waits for the index: reading
 * does not rewrite index.json each page. It goes in sooner with the next structural change, or on flush
 * (view close, unload, quit).
 */
export const POSITION_SUMMARY_MS = 5 * 60_000;

export interface StoreOptions {
  now?: () => Date;
  uuid?: () => string;
  coalesceMs?: number;
  /**
   * True when a vault path still holds a file. With it, `openPath` also reattaches a book whose entry is not
   * marked missing but whose file is gone (moved while Margin wasn't watching: plugin off, Obsidian closed,
   * a sync). Without it only entries marked missing reattach.
   */
  pathExists?: (path: string) => boolean;
  summaryDelayMs?: number;
  positionSummaryMs?: number;
}

/** A book on the shelf, from the index alone (plus the live book when it is loaded). */
export interface ShelfEntry {
  path: string;
  bookId: string;
  missing: boolean;
  /** When it was last opened in Margin. */
  openedAt: string | null;
  /** null: an index written before summaries, for a book not loaded since. */
  summary: BookSummary | null;
}

/** What a summary update carries: the book as written, and/or the page count a reader reported. */
interface SummaryUpdate {
  file?: DeepReadonly<BookFile>;
  pageCount?: number;
}

const monthOf = (iso: string): string | null => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const plainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * A summary read from index.json, checked field by field: a clean copy of it, or null when any field is not
 * what the shelf draws from (it is then dropped and fills in again from the book file). Unknown fields go.
 */
export function validSummary(v: unknown): BookSummary | null {
  if (!plainObject(v)) return null;
  const { title, progress, page, pageCount, annotationCount, thoughtCount, thoughtsByMonth, updatedAt } = v;
  if (title !== null && typeof title !== 'string') return null;
  if (progress !== null && !finite(progress)) return null;
  if (page !== null && !finite(page)) return null;
  if (pageCount !== undefined && !validPageCount(pageCount)) return null;
  if (!finite(annotationCount) || annotationCount < 0 || !finite(thoughtCount) || thoughtCount < 0) return null;
  if (!plainObject(thoughtsByMonth) || !Object.values(thoughtsByMonth).every(finite)) return null;
  if (typeof updatedAt !== 'string') return null;
  const out: BookSummary = { title, progress, page, annotationCount, thoughtCount, thoughtsByMonth: { ...(thoughtsByMonth as Record<string, number>) }, updatedAt };
  if (pageCount !== undefined) out.pageCount = pageCount as number;
  return out;
}

/**
 * A cover choice read from index.json: a clean copy, or null when it is not one (it is then dropped and the
 * book's cover is automatic again). A vault path must be a relative vault path; unknown fields go.
 */
export function validCover(v: unknown): CoverChoice | null {
  if (!plainObject(v)) return null;
  switch (v.kind) {
    case 'tile':
      return { kind: 'tile' };
    case 'page':
      return { kind: 'page' };
    case 'vault': {
      const path = v.path;
      if (typeof path !== 'string' || path === '' || path.startsWith('/') || path.split('/').includes('..')) return null;
      return { kind: 'vault', path };
    }
    case 'pasted':
      if (!(COVER_EXTENSIONS as readonly unknown[]).includes(v.ext) || typeof v.at !== 'string') return null;
      return { kind: 'pasted', ext: v.ext as CoverExt, at: v.at };
    default:
      return null;
  }
}

/** What a book file says about itself (an EPUB's OPF title and author). */
export interface BookMetaInput {
  title?: string | null;
  author?: string | null;
}

/** A book's format, from its file's extension: `.epub` (any case) is an EPUB, anything else a PDF. */
export const formatOf = (path: string): 'pdf' | 'epub' => (/\.epub$/i.test(path) ? 'epub' : 'pdf');

const validPageCount = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1;

/** summarize() per live book object: books are replaced on change, never changed in place, so this never goes stale. */
const summaries = new WeakMap<object, BookSummary>();

/**
 * The index summary of a book (its page count is not in the book file: the caller carries it over). Cached
 * per book object: the result is shared, so copy it before changing it.
 */
export function summarize(f: DeepReadonly<BookFile>): BookSummary {
  const cached = summaries.get(f);
  if (cached) return cached;
  const b = f.book;
  const loc = parseLocation(b.lastLocation);
  const thoughtsByMonth: Record<string, number> = {};
  let updatedAt = typeof b.addedAt === 'string' ? b.addedAt : '';
  for (const t of f.thoughts) {
    const m = monthOf(t.createdAt);
    if (m) thoughtsByMonth[m] = (thoughtsByMonth[m] ?? 0) + 1;
    if (t.updatedAt > updatedAt) updatedAt = t.updatedAt;
  }
  for (const a of f.annotations) if (a.updatedAt > updatedAt) updatedAt = a.updatedAt;
  const page = loc ? (spotOf(loc)?.page ?? null) : null;
  const out: BookSummary = {
    title: typeof b.title === 'string' ? b.title : null,
    progress: finite(b.progress) ? b.progress : null,
    page: finite(page) ? page : null,
    annotationCount: f.annotations.length,
    thoughtCount: f.thoughts.length,
    thoughtsByMonth,
    updatedAt,
  };
  summaries.set(f, out);
  return out;
}

/** Two summaries that differ at most in the reading position (progress, page). */
const samePastPosition = (a: BookSummary, b: BookSummary) =>
  JSON.stringify({ ...a, progress: null, page: null }) === JSON.stringify({ ...b, progress: null, page: null });

/** A mutation applied to the live book, waiting for the write that persists it. */
interface Pending {
  apply: (f: BookFile) => unknown;
  result: unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

interface Slot {
  live: BookFile;
  /** JSON of the last successful write: what is on disk. */
  persisted: string;
  batch: Pending[];
  timer: ReturnType<typeof setTimeout> | null;
  writing: Promise<void> | null;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const stem = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
/**
 * A title that was the file's name follows a rename (a readable one stays readable: displayTitle); a
 * title of its own is kept.
 */
const retitle = (title: string | null, oldPath: string, newPath: string) =>
  title === null || title === stem(oldPath)
    ? stem(newPath)
    : title === displayTitle(stem(oldPath))
      ? displayTitle(stem(newPath))
      : title;
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
/** The index fingerprint format: `<size>:<sha256 hex>`. */
const FINGERPRINT = /^\d+:[0-9a-f]{64}$/;
/**
 * The index key of a missing book that has no free vault path to sit under. Obsidian forbids `:` in
 * file names, so this never collides with, or falls under, a real vault path.
 */
const ORPHAN = 'margin-missing:';
const BACKUP_DAY = /^\d{4}-\d{2}-\d{2}\.json$/;

/**
 * Something `load()` repaired, reported once the load is done so the user can be told (the plugin shows a
 * Notice). `name` is the book's title, else its vault path, else its id.
 */
export type RecoveryEvent =
  /** A book's interrupted write did not parse and it had no readable backup: its data is only in `keptAs`. */
  | { kind: 'book-kept-aside'; bookId: string; name: string; keptAs: string }
  /** A book's interrupted write did not parse: it was restored from `backup`; the damaged copy is `keptAs`. */
  | { kind: 'backup-restored'; bookId: string; name: string; keptAs: string; backup: string }
  /**
   * The index (or its interrupted write) did not parse: it was kept as `keptAs` and rebuilt from the book
   * files; `books` are the ones that came back as missing (they are not reported again as orphans-swept).
   */
  | { kind: 'index-rebuilt'; keptAs: string; books: { bookId: string; name: string }[] }
  /** Book files the index did not reference came back as missing books. */
  | { kind: 'orphans-swept'; books: { bookId: string; name: string }[] };

/** A recovery before the index is read: the name is filled in once it is. */
type RawRecovery =
  | { kind: 'book-kept-aside'; bookId: string; keptAs: string }
  | { kind: 'backup-restored'; bookId: string; title: string | null; keptAs: string; backup: string }
  | { kind: 'index-rebuilt'; keptAs: string }
  | { kind: 'orphans-swept'; books: { bookId: string; title: string | null }[] };

/** A deep read-only view: what `file()` and `peek()` hand out, so only `mutate` can change a book. */
export type DeepReadonly<T> = T extends (infer U)[]
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

const closedError = () => new MarginError('Readside has been turned off; this change was not saved.');

function parseIndex(json: string): IndexFile | null {
  try {
    const v = JSON.parse(json) as Partial<IndexFile> | null;
    const entries = v?.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return null;
    const out: Record<string, IndexEntry> = {};
    for (const [key, e] of Object.entries(entries)) {
      if (!e || typeof e !== 'object' || typeof e.bookId !== 'string' || typeof e.fingerprint !== 'string') return null;
      // A summary is only a cache of the book file: a bad one is dropped (the entry stays) and fills in again.
      // A bad cover choice or thumbnail record is dropped the same way: the cover is automatic again.
      const { summary, cover, thumb, ...rest } = e as IndexEntry;
      const entry: IndexEntry = rest;
      if ('summary' in e) {
        const valid = validSummary(summary);
        if (valid) entry.summary = valid;
      }
      if ('cover' in e) {
        const valid = validCover(cover);
        if (valid) entry.cover = valid;
      }
      if (typeof thumb === 'string' && thumb !== '') entry.thumb = thumb;
      out[key] = entry;
    }
    return { version: 1, entries: out };
  } catch {
    return null;
  }
}

function parseBookFile(json: string, where: string): BookFile {
  const v = JSON.parse(json) as Partial<BookFile>;
  if (v.version !== 1 || !v.book || !Array.isArray(v.annotations) || !Array.isArray(v.thoughts)) {
    throw new MarginError(`unreadable book file ${where}`);
  }
  return v as BookFile;
}

/**
 * The plugin's source of truth (spec §5): one JSON file per book plus an index from vault path to
 * book. Mutations apply to the in-memory book at once and are written through one coalescing queue
 * per book; each write is tmp → remove → rename.
 */
export class BookStore {
  readonly root: string;
  readonly now: () => Date;
  readonly uuid: () => string;
  private readonly adapter: StoreAdapter;
  private readonly coalesceMs: number;
  private readonly pathExists: ((path: string) => boolean) | null;
  private index: IndexFile = { version: 1, entries: {} };
  private slots = new Map<string, Slot>();
  private loading = new Map<string, Promise<Slot>>();
  /** annotation / thought id → book id, for the books loaded so far. */
  private owners = new Map<string, string>();
  private listeners = new Set<(bookId: string) => void>();
  private indexQueue: Promise<void> = Promise.resolve();
  /** openPath, renamePath and markMissing run one at a time, in call order. */
  private indexOps: Promise<unknown> = Promise.resolve();
  private backedUp = new Map<string, string>();
  private recoveryListeners = new Set<(event: RecoveryEvent) => void>();
  /** What the load in progress repaired, reported when it ends. */
  private recovered: RawRecovery[] = [];
  /** Set by close(): the plugin is unloading, nothing may change any more. */
  private closed = false;
  private readonly summaryDelayMs: number;
  /** Book id → the summary update waiting to go into the index (through the index ops, in one write). */
  private pendingSummaries = new Map<string, SummaryUpdate>();
  private summaryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The long timer of summaries that only moved the reading position (POSITION_SUMMARY_MS). */
  private positionTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly positionSummaryMs: number;
  /** The last index write failed: the next summary pass writes even when nothing changed in memory. */
  private indexUnsaved = false;
  private indexListeners = new Set<() => void>();

  constructor(adapter: StoreAdapter, root: string, opts: StoreOptions = {}) {
    this.adapter = adapter;
    this.root = root;
    this.now = opts.now ?? (() => new Date());
    this.uuid = opts.uuid ?? (() => crypto.randomUUID());
    this.coalesceMs = opts.coalesceMs ?? WRITE_COALESCE_MS;
    this.pathExists = opts.pathExists ?? null;
    this.summaryDelayMs = opts.summaryDelayMs ?? SUMMARY_COALESCE_MS;
    this.positionSummaryMs = opts.positionSummaryMs ?? POSITION_SUMMARY_MS;
  }

  get booksDir(): string {
    return `${this.root}/books`;
  }
  get backupsDir(): string {
    return `${this.root}/backups`;
  }
  get indexPath(): string {
    return `${this.root}/index.json`;
  }
  bookPath(id: string): string {
    return `${this.booksDir}/${id}.json`;
  }

  async load(): Promise<void> {
    this.recovered = [];
    try {
      await this.loadIndex();
    } finally {
      this.reportRecoveries();
    }
  }

  private async loadIndex(): Promise<void> {
    for (const dir of [this.root, this.booksDir, this.backupsDir]) {
      if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
    }
    await this.recover(`${this.indexPath}.tmp`, (t) => parseIndex(t) !== null);
    for (const f of (await this.adapter.list(this.booksDir)).files) {
      if (f.endsWith('.json.tmp')) await this.recover(f, (t) => !!parseBookFile(t, f));
    }
    this.index = { version: 1, entries: {} };
    if (await this.adapter.exists(this.indexPath)) {
      const parsed = parseIndex(await this.adapter.read(this.indexPath));
      // A corrupt index is kept aside, never overwritten; the sweep below rebuilds it from the book files.
      if (parsed) this.index = parsed;
      else this.recovered.push({ kind: 'index-rebuilt', keptAs: await this.keepAside(this.indexPath, this.indexPath) });
    }
    await this.sweep();
  }

  /**
   * A tmp left by an interrupted write (tmp → remove main → rename). A tmp that parses is the newest copy:
   * it goes into place, and a main file still next to it (the write stopped before removing it) is kept as
   * `<main>.prev-<time>`. A tmp that does not parse is a write cut short: next to its main file it goes;
   * alone it is kept as `<main>.corrupt-<time>` and a book falls back to its newest readable backup. A file
   * that parses is never deleted.
   */
  private async recover(tmp: string, readable: (text: string) => boolean): Promise<void> {
    if (!(await this.adapter.exists(tmp))) return;
    const main = tmp.slice(0, -'.tmp'.length);
    let ok = false;
    try {
      ok = readable(await this.adapter.read(tmp));
    } catch {
      ok = false;
    }
    const hasMain = await this.adapter.exists(main);
    if (ok) {
      if (hasMain) await this.keepAside(main, main, 'prev');
      await this.adapter.rename(tmp, main);
      return;
    }
    if (hasMain) {
      await this.adapter.remove(tmp);
      return;
    }
    const keptAs = await this.keepAside(tmp, main);
    if (main === this.indexPath) {
      this.recovered.push({ kind: 'index-rebuilt', keptAs });
      return;
    }
    const bookId = main.slice(this.booksDir.length + 1, -'.json'.length);
    const backup = await this.newestBackup(bookId);
    if (backup === null) {
      this.recovered.push({ kind: 'book-kept-aside', bookId, keptAs });
      return;
    }
    await this.atomicWrite(main, backup.text);
    this.recovered.push({ kind: 'backup-restored', bookId, title: backup.title, keptAs, backup: backup.path });
  }

  /**
   * Renames a file to `<base>.<kind>-<time>` (a free name), so nothing overwrites or deletes it; returns that
   * name. `corrupt`: it is unreadable. `prev`: a newer copy replaced it.
   */
  private async keepAside(path: string, base: string, kind: 'corrupt' | 'prev' = 'corrupt'): Promise<string> {
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    let target = `${base}.${kind}-${stamp}`;
    for (let n = 2; await this.adapter.exists(target); n++) target = `${base}.${kind}-${stamp}-${n}`;
    console.warn(kind === 'corrupt' ? `margin: ${path} is unreadable; kept as ${target}` : `margin: ${path} was replaced by its newer interrupted write; kept as ${target}`);
    await this.adapter.rename(path, target);
    return target;
  }

  private async backupsOf(bookId: string): Promise<string[]> {
    const prefix = `${this.backupsDir}/${bookId}-`;
    return (await this.adapter.list(this.backupsDir)).files
      .filter((f) => f.startsWith(prefix) && BACKUP_DAY.test(f.slice(prefix.length)))
      .sort();
  }

  /** The newest backup of a book that parses (its path, content and book title), or null. */
  private async newestBackup(bookId: string): Promise<{ path: string; text: string; title: string | null } | null> {
    for (const f of (await this.backupsOf(bookId)).reverse()) {
      try {
        const text = await this.adapter.read(f);
        const title = parseBookFile(text, f).book.title;
        return { path: f, text, title: typeof title === 'string' ? title : null };
      } catch {
        // try an older one
      }
    }
    return null;
  }

  /**
   * Every book file the index does not reference comes back as a missing entry, so its data stays
   * reachable (reattach by fingerprint, or an explicit lookup). It is always keyed by the unique orphan
   * key, never its own stored path, so an unrelated file later appearing there cannot attach. Its fingerprint is the book's
   * `contentHash` when that has the index format; otherwise it is `''`, which no file matches, so the
   * book never reattaches by fingerprint. Book files are only read here, never written or removed.
   */
  private async sweep(): Promise<void> {
    const referenced = new Set(Object.values(this.index.entries).map((e) => e.bookId));
    const swept: { bookId: string; title: string | null }[] = [];
    for (const f of (await this.adapter.list(this.booksDir)).files) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(this.booksDir.length + 1, -'.json'.length);
      if (referenced.has(id)) continue;
      let file: BookFile;
      try {
        file = parseBookFile(await this.adapter.read(f), f);
      } catch (e) {
        console.warn(`margin: ${f} is not referenced by the index and is unreadable; left as it is`, e);
        continue;
      }
      const key = this.orphanKey(id);
      const fp = typeof file.book.contentHash === 'string' && FINGERPRINT.test(file.book.contentHash) ? file.book.contentHash : '';
      this.index.entries[key] = { bookId: id, fingerprint: fp, missing: true };
      referenced.add(id);
      swept.push({ bookId: id, title: typeof file.book.title === 'string' ? file.book.title : null });
    }
    if (swept.length) {
      this.recovered.push({ kind: 'orphans-swept', books: swept });
      await this.saveIndex().catch((e) => console.warn('margin: could not save the rebuilt index', e));
    }
  }

  private has(path: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.index.entries, path);
  }

  private orphanKey(bookId: string): string {
    let key = `${ORPHAN}${bookId}`;
    for (let n = 2; this.has(key); n++) key = `${ORPHAN}${bookId}:${n}`;
    return key;
  }

  /** Runs index-mutating operations one at a time, so none of them works from a stale index. */
  private serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.indexOps.then(op);
    this.indexOps = run.catch(() => {});
    return run;
  }

  /** Tells `listener` what each later `load()` repaired; returns the unsubscribe. */
  onRecovery(listener: (event: RecoveryEvent) => void): () => void {
    this.recoveryListeners.add(listener);
    return () => {
      this.recoveryListeners.delete(listener);
    };
  }

  /** The book's title, else the vault path the index has for it, else its id. */
  private nameOf(bookId: string, title: string | null): string {
    if (title) return title;
    const path = Object.keys(this.index.entries).find((p) => !p.startsWith(ORPHAN) && this.index.entries[p].bookId === bookId);
    return path ?? bookId;
  }

  private reportRecoveries(): void {
    const raw = this.recovered;
    this.recovered = [];
    const named = (books: { bookId: string; title: string | null }[]) =>
      books.map((b) => ({ bookId: b.bookId, name: this.nameOf(b.bookId, b.title) }));
    // A rebuilt index names the books its rebuild swept back, in one message.
    const rebuilt = raw.some((r) => r.kind === 'index-rebuilt');
    const swept = raw.flatMap((r) => (r.kind === 'orphans-swept' ? r.books : []));
    let sweptReported = false;
    for (const r of raw) {
      let event: RecoveryEvent;
      if (r.kind === 'orphans-swept' && rebuilt) continue;
      if (r.kind === 'index-rebuilt') {
        event = { kind: 'index-rebuilt', keptAs: r.keptAs, books: sweptReported ? [] : named(swept) };
        sweptReported = true;
      } else if (r.kind === 'book-kept-aside') event = { ...r, name: this.nameOf(r.bookId, null) };
      else if (r.kind === 'backup-restored') {
        event = { kind: r.kind, bookId: r.bookId, name: this.nameOf(r.bookId, r.title), keptAs: r.keptAs, backup: r.backup };
      } else if (r.kind === 'orphans-swept') {
        event = { kind: 'orphans-swept', books: named(r.books) };
      } else continue;
      for (const l of this.recoveryListeners) {
        try {
          l(event);
        } catch (e) {
          console.error('margin: recovery listener failed', e);
        }
      }
    }
  }

  onChange(listener: (bookId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Tells `listener` whenever the in-memory index changes (an entry added, moved, marked, summarised).
   * Listeners run synchronously inside index operations (openPath, renamePath, markMissing, markOpened, the
   * summary pass): they must not await `flush()` (or anything that waits for the index operations), which
   * would wait for the operation that is calling them. Schedule such work for later instead.
   */
  onIndexChange(listener: () => void): () => void {
    this.indexListeners.add(listener);
    return () => {
      this.indexListeners.delete(listener);
    };
  }

  /**
   * Every book with a vault path (books kept only as orphans are left out), from the index alone: no book
   * file is read. A loaded book's summary is made from its live state, so it is never behind the index.
   */
  shelfEntries(): ShelfEntry[] {
    const out: ShelfEntry[] = [];
    for (const [path, e] of Object.entries(this.index.entries)) {
      if (path.startsWith(ORPHAN)) continue;
      const live = this.slots.get(e.bookId)?.live;
      let summary: BookSummary | null = e.summary ?? null;
      if (live) {
        summary = { ...summarize(live) };
        const pageCount = e.summary?.pageCount;
        if (validPageCount(pageCount)) summary.pageCount = pageCount;
      }
      const openedAt = typeof e.openedAt === 'string' ? e.openedAt : (live?.book.openedAt ?? null);
      out.push({ path, bookId: e.bookId, missing: e.missing, openedAt, summary });
    }
    return out;
  }

  /** A reader reported how many pages the book has: it goes into the index summary (shown as "p. N of M"). */
  setPageCount(bookId: string, pageCount: number): void {
    if (!Number.isInteger(pageCount) || pageCount < 1) return;
    this.queueSummary(bookId, { pageCount });
  }

  bookIdForPath(path: string): string | null {
    return this.index.entries[path]?.bookId ?? null;
  }
  /** True when the index has an entry for the book (at a path, missing, or kept as an orphan). */
  hasBook(bookId: string): boolean {
    return Object.values(this.index.entries).some((e) => e.bookId === bookId);
  }
  entry(path: string): IndexEntry | null {
    return this.index.entries[path] ?? null;
  }
  /** The live book, read-only: change it only through `mutate`. */
  peek(bookId: string): DeepReadonly<BookFile> | null {
    return this.slots.get(bookId)?.live ?? null;
  }
  ownerOf(id: string): string | null {
    return this.owners.get(id) ?? null;
  }
  /** The live book, read-only: change it only through `mutate`. */
  async file(bookId: string): Promise<DeepReadonly<BookFile>> {
    return (await this.slot(bookId)).live;
  }

  /**
   * A book to look at without keeping it (the shelf's search and lists): the live book when it is loaded,
   * else the file read and parsed now, with no slot made and no ids tracked, so it is gone once the caller
   * drops it. An index entry without a summary still gets one from what was read.
   */
  async peekFile(bookId: string): Promise<DeepReadonly<BookFile>> {
    const ready = this.slots.get(bookId) ?? (await this.loading.get(bookId));
    if (ready) return ready.live;
    const path = this.bookPath(bookId);
    if (!(await this.adapter.exists(path))) throw notFound('book', bookId);
    const text = await this.adapter.read(path);
    // Loaded while this read: the live book is newer than the file.
    const live = this.slots.get(bookId)?.live;
    if (live) return live;
    const f = parseBookFile(text, path);
    // A summary the index lacks, or one that is behind the file, is made from what was read (a position-only
    // difference waits on the long timer; queueSummary decides). An equal one costs nothing.
    const entry = Object.values(this.index.entries).find((e) => e.bookId === bookId);
    if (entry && (!entry.summary || !this.sameSummary(f, entry.summary))) this.queueSummary(bookId, { file: f });
    return f;
  }

  /**
   * The book for a vault file: the one at this path, a missing one with the same content, or a new one.
   * `meta` (an EPUB's OPF title and author) names a new book only, and is called only then: an existing
   * book keeps its title, and reopening it never reads the metadata.
   */
  openPath(path: string, fingerprint: string, title: string, meta?: () => BookMetaInput | null): Promise<BookFile> {
    if (this.closed) return Promise.reject(closedError());
    return this.serial(() => this.open(path, fingerprint, title, meta));
  }

  /** Entries are read again after every await: nothing is written back from before one. */
  private async open(path: string, fingerprint: string, title: string, meta?: () => BookMetaInput | null): Promise<BookFile> {
    const known = this.has(path) ? this.index.entries[path] : undefined;
    if (known) {
      const bookId = known.bookId;
      try {
        const f = await this.file(bookId);
        const cur = this.has(path) ? this.index.entries[path] : undefined;
        if (cur?.bookId !== bookId) return this.open(path, fingerprint, title, meta);
        if (cur.missing || cur.fingerprint !== fingerprint) {
          this.index.entries[path] = { ...cur, fingerprint, missing: false };
          await this.saveIndex();
        }
        if (f.book.contentHash !== fingerprint) await this.mutate(bookId, (d) => void (d.book.contentHash = fingerprint));
        return clone((await this.file(bookId)) as BookFile);
      } catch (e) {
        if (!String(e).startsWith('not found')) throw e;
        // its book file is gone: start over
        if (this.has(path) && this.index.entries[path].bookId === bookId) delete this.index.entries[path];
      }
    }
    // The same content elsewhere: a book marked missing, else one whose file is no longer in the vault (moved
    // while Margin wasn't watching). A copy, whose original is still there, gets a book of its own.
    const matches = Object.entries(this.index.entries).filter(([, e]) => e.fingerprint === fingerprint);
    const gone = (p: string) => !p.startsWith(ORPHAN) && this.pathExists !== null && !this.pathExists(p);
    const lost = matches.find(([, e]) => e.missing) ?? matches.find(([p]) => gone(p));
    if (lost) {
      const [oldPath, e] = lost;
      delete this.index.entries[oldPath];
      this.index.entries[path] = { ...e, missing: false };
      await this.saveIndex();
      await this.mutate(e.bookId, (d) => {
        d.book.path = path;
        d.book.title = retitle(d.book.title, oldPath, path);
      });
      return clone((await this.file(e.bookId)) as BookFile);
    }
    const id = this.uuid();
    let m: BookMetaInput | null = null;
    try {
      m = meta?.() ?? null;
    } catch (e) {
      console.warn(`margin: could not read the metadata of ${path}`, e);
    }
    const ownTitle = m?.title?.trim();
    const author = m?.author?.trim() || null;
    const file: BookFile = {
      version: 1,
      book: {
        id, contentHash: fingerprint, path, format: formatOf(path), title: ownTitle || title, author, lastLocation: null,
        addedAt: this.now().toISOString(), openedAt: null, zoom: null, progress: null,
      },
      annotations: [],
      thoughts: [],
    };
    const json = JSON.stringify(file, null, 2);
    await this.atomicWrite(this.bookPath(id), json);
    this.slots.set(id, { live: file, persisted: json, batch: [], timer: null, writing: null });
    this.index.entries[path] = { bookId: id, fingerprint, missing: false };
    // Its summary: from the live book until its first write records one (shelfEntries reads the live book).
    await this.saveIndex();
    return clone(file);
  }

  /** A file or folder moved: every book at or under `oldPath` follows. */
  renamePath(oldPath: string, newPath: string): Promise<void> {
    if (this.closed) return Promise.reject(closedError());
    return this.serial(() => this.rename(oldPath, newPath));
  }

  /**
   * An entry already at a destination (a missing book, or a stale one) is displaced, never dropped: it
   * stays as a missing entry under its unique orphan key (never a path an unrelated file could take).
   */
  private async rename(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) return;
    const target = (p: string) => newPath + p.slice(oldPath.length);
    const sources = () => Object.keys(this.index.entries).filter((p) => under(p, oldPath));
    const displacedBy = (from: string[]) => {
      const moving = new Set(from);
      return from.map(target).filter((to) => this.has(to) && !moving.has(to));
    };
    if (sources().length === 0) return;
    const from = sources();
    if (from.length === 0) return;
    const moves = from.map((p) => ({ from: p, to: target(p), entry: this.index.entries[p] }));
    const displaced = displacedBy(from).map((to) => ({ key: to, entry: this.index.entries[to] }));
    for (const m of moves) delete this.index.entries[m.from];
    for (const d of displaced) delete this.index.entries[d.key];
    for (const m of moves) this.index.entries[m.to] = m.entry;
    for (const d of displaced) {
      this.index.entries[this.orphanKey(d.entry.bookId)] = { ...d.entry, missing: true };
    }
    await this.saveIndex();
    await Promise.all(
      moves.map(({ from, to, entry }) =>
        this.mutate(entry.bookId, (d) => {
          d.book.path = to;
          d.book.title = retitle(d.book.title, from, to);
        }).catch((e) => console.warn(`margin: could not update the book for ${to}`, e)),
      ),
    );
  }

  /** A file or folder was deleted: its books are kept, marked missing. */
  markMissing(path: string): Promise<void> {
    if (this.closed) return Promise.reject(closedError());
    return this.serial(async () => {
      let changed = false;
      for (const [p, e] of Object.entries(this.index.entries)) {
        if (under(p, path) && !e.missing) {
          this.index.entries[p] = { ...e, missing: true };
          changed = true;
        }
      }
      if (changed) await this.saveIndex();
    });
  }

  /** A view opened the book at `path`: its index entry records when, for the picker's order. */
  markOpened(path: string): Promise<void> {
    if (this.closed) return Promise.reject(closedError());
    return this.serial(async () => {
      const e = this.has(path) ? this.index.entries[path] : undefined;
      if (!e) return;
      this.index.entries[path] = { ...e, openedAt: this.now().toISOString() };
      await this.saveIndex();
    });
  }

  /** Every book id the index knows (at a path, missing, or kept as an orphan). */
  bookIds(): Set<string> {
    return new Set(Object.values(this.index.entries).map((e) => e.bookId));
  }

  /** The entry of a book with a vault path (the first one), else null: a book kept only as an orphan has none. */
  entryOf(bookId: string): (IndexEntry & { path: string }) | null {
    for (const [path, e] of Object.entries(this.index.entries)) {
      if (!path.startsWith(ORPHAN) && e.bookId === bookId) return { ...e, path };
    }
    return null;
  }

  /** The user chose a cover for the book (null: automatic again). Every entry of the book carries it. */
  setCover(bookId: string, cover: CoverChoice | null): Promise<void> {
    return this.updateEntries((e) => e.bookId === bookId, (e) => {
      if (cover === null) delete e.cover;
      else e.cover = cover;
    });
  }

  /** The first-page thumbnail of the book was rendered from the file with fingerprint `fp`. */
  setThumb(bookId: string, fp: string): Promise<void> {
    return this.updateEntries((e) => e.bookId === bookId, (e) => void (e.thumb = fp));
  }

  /** A vault file or folder moved: covers chosen from an image at or under `oldPath` follow it. */
  followCoverMove(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) return Promise.resolve();
    const moving = (e: IndexEntry) => e.cover?.kind === 'vault' && under(e.cover.path, oldPath);
    return this.updateEntries(moving, (e) => {
      if (e.cover?.kind === 'vault') e.cover = { kind: 'vault', path: newPath + e.cover.path.slice(oldPath.length) };
    });
  }

  /** A vault file or folder was deleted: covers chosen from an image at or under it go back to automatic. */
  dropCoverPath(path: string): Promise<void> {
    return this.updateEntries((e) => e.cover?.kind === 'vault' && under(e.cover.path, path), (e) => void delete e.cover);
  }

  /** Changes the matching entries (a copy of each), as one index operation; writes the index only when one changed. */
  private updateEntries(match: (e: IndexEntry) => boolean, change: (e: IndexEntry) => void): Promise<void> {
    if (this.closed) return Promise.reject(closedError());
    return this.serial(async () => {
      let changed = false;
      for (const [key, e] of Object.entries(this.index.entries)) {
        if (!match(e)) continue;
        const next = { ...e };
        change(next);
        if (JSON.stringify(next) === JSON.stringify(e)) continue;
        this.index.entries[key] = next;
        changed = true;
      }
      if (changed) await this.saveIndex();
    });
  }

  /** Vault path → when it was last opened in Margin, from the index alone (no book file is read). */
  openedAtByPath(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [path, e] of Object.entries(this.index.entries)) {
      if (!path.startsWith(ORPHAN) && typeof e.openedAt === 'string') out.set(path, e.openedAt);
    }
    return out;
  }

  async listBooks(): Promise<BookEntry[]> {
    const out: BookEntry[] = [];
    for (const e of Object.values(this.index.entries)) {
      try {
        out.push({ ...clone((await this.file(e.bookId)).book), missing: e.missing });
      } catch {
        // an unreadable book file is left out
      }
    }
    const key = (b: BookEntry) => b.openedAt ?? b.addedAt;
    return out.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
  }

  /**
   * Applies `apply` to a copy of the live book (a throw changes nothing), makes it live, and resolves
   * with its result once a write containing it has landed. A failed write rejects.
   */
  mutate<T>(bookId: string, apply: (f: BookFile) => T): Promise<T> {
    if (this.closed) return Promise.reject(closedError());
    // A loaded book changes synchronously, so a read right after the call already sees the change.
    const ready = this.slots.get(bookId);
    return ready ? this.applyTo(bookId, ready, apply) : this.slot(bookId).then((s) => this.applyTo(bookId, s, apply));
  }

  private applyTo<T>(bookId: string, slot: Slot, apply: (f: BookFile) => T): Promise<T> {
    let result: T;
    const draft = clone(slot.live);
    try {
      result = apply(draft);
    } catch (e) {
      return Promise.reject(e);
    }
    slot.live = draft;
    this.track(draft);
    this.emit(bookId);
    return new Promise<T>((resolve, reject) => {
      slot.batch.push({ apply, result, resolve: resolve as (v: unknown) => void, reject });
      this.schedule(bookId, slot);
    });
  }

  /**
   * Writes pending changes now (one book, or all) and waits for writes in flight, loads and index
   * operations. Never call it from inside an index operation (openPath / renamePath / markMissing, or a
   * listener they trigger and await): it waits for that operation, which would wait for it.
   */
  async flush(bookId?: string): Promise<void> {
    // A book still loading has mutations waiting on it: let them apply, then write them below.
    const loads = bookId ? [this.loading.get(bookId)] : [...this.loading.values()];
    await Promise.all(loads.map((p) => p?.then(() => undefined, () => undefined)));
    const ids = bookId ? [bookId] : [...this.slots.keys()];
    await Promise.all(
      ids.map((id) => {
        const slot = this.slots.get(id);
        if (!slot) return undefined;
        if (slot.timer) {
          clearTimeout(slot.timer);
          slot.timer = null;
        }
        return slot.batch.length || slot.writing ? this.drain(id, slot) : undefined;
      }),
    );
    // The summaries those writes (and earlier ones) left waiting, position-only ones too: into the index now.
    this.kickSummaries();
    await this.indexQueue;
    await this.indexOps;
  }

  /**
   * The plugin is unloading and has flushed: every later mutation (mutate, openPath, renamePath,
   * markMissing) rejects, so nothing can change in memory that would never be written. Reads and
   * flush still work.
   */
  close(): void {
    this.closed = true;
    // Nothing more goes into the index (the flush before this wrote what was waiting).
    for (const t of [this.summaryTimer, this.positionTimer]) if (t !== null) clearTimeout(t);
    this.summaryTimer = null;
    this.positionTimer = null;
  }

  /** close() has run. */
  get isClosed(): boolean {
    return this.closed;
  }

  private slot(bookId: string): Promise<Slot> {
    const ready = this.slots.get(bookId);
    if (ready) return Promise.resolve(ready);
    let p = this.loading.get(bookId);
    if (!p) {
      p = this.readSlot(bookId).finally(() => this.loading.delete(bookId));
      this.loading.set(bookId, p);
    }
    return p;
  }

  private async readSlot(bookId: string): Promise<Slot> {
    const path = this.bookPath(bookId);
    if (!(await this.adapter.exists(path))) throw notFound('book', bookId);
    const persisted = await this.adapter.read(path);
    const slot: Slot = { live: parseBookFile(persisted, path), persisted, batch: [], timer: null, writing: null };
    this.slots.set(bookId, slot);
    this.track(slot.live);
    // An index from before summaries (or one that missed a write): the summary fills in now.
    this.queueSummary(bookId, { file: slot.live });
    return slot;
  }

  private track(f: BookFile): void {
    for (const a of f.annotations) this.owners.set(a.id, f.book.id);
    for (const t of f.thoughts) this.owners.set(t.id, f.book.id);
  }

  private emit(bookId: string): void {
    for (const l of this.listeners) {
      try {
        l(bookId);
      } catch (e) {
        console.error('margin: change listener failed', e);
      }
    }
  }

  private schedule(bookId: string, slot: Slot): void {
    if (slot.timer || slot.writing) return; // a write in flight picks the batch up when it finishes
    slot.timer = setTimeout(() => {
      slot.timer = null;
      void this.drain(bookId, slot);
    }, this.coalesceMs);
  }

  private drain(bookId: string, slot: Slot): Promise<void> {
    if (!slot.writing) {
      slot.writing = this.writeBatches(bookId, slot).finally(() => {
        slot.writing = null;
        if (slot.batch.length) this.schedule(bookId, slot);
      });
    }
    return slot.writing;
  }

  private async writeBatches(bookId: string, slot: Slot): Promise<void> {
    while (slot.batch.length) {
      const batch = slot.batch;
      slot.batch = [];
      try {
        // The live book is replaced, never changed in place, so this is the content written.
        const written = slot.live;
        const json = JSON.stringify(written, null, 2);
        await this.backup(bookId, slot.persisted);
        await this.atomicWrite(this.bookPath(bookId), json);
        slot.persisted = json;
        this.queueSummary(bookId, { file: written });
        for (const p of batch) p.resolve(p.result);
      } catch (e) {
        this.rollback(bookId, slot);
        for (const p of batch) p.reject(e);
      }
    }
  }

  /** After a failed write: back to what is on disk, then the mutations queued meanwhile, again and in order. */
  private rollback(bookId: string, slot: Slot): void {
    slot.live = parseBookFile(slot.persisted, this.bookPath(bookId));
    const later = slot.batch;
    slot.batch = [];
    for (const p of later) {
      try {
        const draft = clone(slot.live);
        p.result = p.apply(draft);
        slot.live = draft;
        slot.batch.push(p);
      } catch (err) {
        p.reject(err);
      }
    }
    this.track(slot.live);
    this.emit(bookId);
  }

  /** On the first save of a (local) day, the content about to be replaced goes to backups/; at most 7 per book. */
  private async backup(bookId: string, previous: string): Promise<void> {
    const today = localDay(this.now());
    if (this.backedUp.get(bookId) === today) return;
    try {
      const target = `${this.backupsDir}/${bookId}-${today}.json`;
      if (!(await this.adapter.exists(target))) await this.adapter.write(target, previous);
      const mine = await this.backupsOf(bookId);
      for (const f of mine.slice(0, Math.max(0, mine.length - BACKUPS_KEPT))) await this.adapter.remove(f);
      this.backedUp.set(bookId, today);
    } catch (e) {
      console.warn(`margin: backup of ${bookId} failed`, e); // a backup never blocks a save
    }
  }

  /**
   * Gathers a summary update. One that changes what the shelf counts or names (counts, title, months, the
   * newest change, the page count) goes into the index SUMMARY_COALESCE_MS later; one that only moved the
   * reading position waits for POSITION_SUMMARY_MS, the next structural change, or flush. Either way the
   * shelf stays live: shelfEntries reads loaded books themselves.
   */
  private queueSummary(bookId: string, u: SummaryUpdate): void {
    if (this.closed) return;
    const prev = this.pendingSummaries.get(bookId);
    const merged = { file: u.file ?? prev?.file, pageCount: u.pageCount ?? prev?.pageCount };
    this.pendingSummaries.set(bookId, merged);
    if (this.structural(bookId, u)) {
      if (this.summaryTimer === null) this.summaryTimer = setTimeout(() => this.kickSummaries(), this.summaryDelayMs);
    } else if (this.positionTimer === null) {
      this.positionTimer = setTimeout(() => this.kickSummaries(), this.positionSummaryMs);
    }
  }

  /** Whether the index's summary is what `f` would give (its page count kept). */
  private sameSummary(f: BookFile, stored: BookSummary): boolean {
    const next = { ...summarize(f) };
    if (stored.pageCount !== undefined) next.pageCount = stored.pageCount;
    return JSON.stringify(next) === JSON.stringify(stored);
  }

  /** Whether an update changes more than the reading position of the summary the index has for the book. */
  private structural(bookId: string, u: SummaryUpdate): boolean {
    const e = Object.values(this.index.entries).find((x) => x.bookId === bookId);
    if (!e?.summary) return true;
    if (u.pageCount !== undefined && u.pageCount !== e.summary.pageCount) return true;
    if (!u.file) return false;
    const next = { ...summarize(u.file) };
    if (e.summary.pageCount !== undefined) next.pageCount = e.summary.pageCount;
    return !samePastPosition(next, e.summary);
  }

  /** The waiting summary updates, as one index operation (serialised with the others), one index write. */
  private kickSummaries(): void {
    for (const t of [this.summaryTimer, this.positionTimer]) if (t !== null) clearTimeout(t);
    this.summaryTimer = null;
    this.positionTimer = null;
    if (this.closed || this.pendingSummaries.size === 0) return;
    const batch = this.pendingSummaries;
    this.pendingSummaries = new Map();
    void this.serial(() => this.applySummaries(batch)).catch((e) => {
      console.warn('margin: could not save book summaries', e);
      this.requeue(batch);
    });
  }

  /**
   * A summary write failed: its updates wait again (newer ones queued meanwhile win), for the next
   * structural change, flush or the long timer, so a failing disk is not retried in a tight loop.
   */
  private requeue(batch: Map<string, SummaryUpdate>): void {
    if (this.closed) return;
    for (const [bookId, u] of batch) {
      const later = this.pendingSummaries.get(bookId);
      this.pendingSummaries.set(bookId, { file: later?.file ?? u.file, pageCount: later?.pageCount ?? u.pageCount });
    }
    if (this.positionTimer === null && this.summaryTimer === null) {
      this.positionTimer = setTimeout(() => this.kickSummaries(), this.positionSummaryMs);
    }
  }

  /** Entries are read inside the operation, so a move or open queued before it is never undone. */
  private async applySummaries(batch: Map<string, SummaryUpdate>): Promise<void> {
    let changed = false;
    for (const [bookId, u] of batch) {
      for (const [key, e] of Object.entries(this.index.entries)) {
        if (e.bookId !== bookId) continue;
        const live = this.slots.get(bookId)?.live;
        const current = e.summary === undefined ? null : validSummary(e.summary);
        const from = u.file ? summarize(u.file) : (current ?? (live ? summarize(live) : null));
        if (!from) continue;
        const next = { ...from };
        const pageCount = u.pageCount ?? current?.pageCount;
        if (validPageCount(pageCount)) next.pageCount = pageCount;
        else delete next.pageCount;
        if (JSON.stringify(next) === JSON.stringify(e.summary ?? null)) continue;
        this.index.entries[key] = { ...e, summary: next };
        changed = true;
      }
    }
    // After a failed index write the disk is behind memory even when this pass changed nothing.
    if (changed || this.indexUnsaved) await this.saveIndex();
  }

  private saveIndex(): Promise<void> {
    for (const l of this.indexListeners) {
      try {
        l();
      } catch (e) {
        console.error('margin: index listener failed', e);
      }
    }
    const json = JSON.stringify(this.index, null, 2);
    const run = this.indexQueue.then(() => this.atomicWrite(this.indexPath, json));
    // Writes land in order, each with the whole index: the last one to settle says whether the disk is behind.
    this.indexQueue = run.then(
      () => void (this.indexUnsaved = false),
      () => void (this.indexUnsaved = true),
    );
    return run;
  }

  private async atomicWrite(path: string, data: string): Promise<void> {
    const tmp = `${path}.tmp`;
    await this.adapter.write(tmp, data);
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
    await this.adapter.rename(tmp, path);
  }
}
