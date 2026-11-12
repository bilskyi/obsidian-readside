import { normalizePath, type App, type TFile } from 'obsidian';
import type { Backlink } from '../../src/features/marginalia/backlinks';
import { parseLocation, pdfLocation, serializeLocation } from '../../src/lib/location';
import type { Location } from '../../src/lib/types';
import { formatOf } from './store/bookStore';

/** Changes settle this long before the open books' backlinks are worked out again. */
export const BACKLINK_DELAY_MS = 400;
/** The text scan for `obsidian://margin` links reads at most this many notes … */
export const SCAN_MAX_FILES = 5000;
/** … and skips notes larger than this (bytes). */
export const SCAN_MAX_BYTES = 512 * 1024;
const SNIPPET_CHARS = 140;

/** N from a link subpath `#page=N` (Obsidian's PDF page links); null for any other subpath. */
export function pageFromSubpath(subpath: string): number | null {
  const m = /^#page=(\d+)(?:&|$)/.exec(subpath);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** A link's target split at its first `#` (the path percent-decoded, as a Markdown link may carry it). */
export function splitLinktext(link: string): { path: string; subpath: string } {
  const hash = link.indexOf('#');
  return hash < 0 ? { path: decode(link), subpath: '' } : { path: decode(link.slice(0, hash)), subpath: link.slice(hash) };
}

export interface MarginUrlHit {
  /** The book's vault path (`file=`). */
  file: string;
  location: Location;
  /** 0-based line. */
  line: number;
  snippet: string;
}

/** An `obsidian://margin?…` URL runs until whitespace or what closes a Markdown link or an HTML attribute. */
const MARGIN_URL = /obsidian:\/\/margin\?([^\s)\]>"'`<]+)/g;

/** The query of a margin URL, decoded (the links.ts format: `file` and `loc`, each encodeURIComponent'd). */
function marginParams(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    // A link copied out of HTML may carry `&amp;` between its parameters: the key is still `loc`.
    if (eq > 0) out[decode(part.slice(0, eq)).replace(/^amp;/, '')] = decode(part.slice(eq + 1).replace(/\+/g, ' '));
  }
  return out;
}

/** Every Margin link (with a place) in a note's text. A link without a `loc`, or with a bad one, has no place and is left out. */
export function marginUrlsIn(text: string): MarginUrlHit[] {
  if (!text.includes('obsidian://margin?')) return [];
  const out: MarginUrlHit[] = [];
  const lines = text.split('\n');
  lines.forEach((lineText, line) => {
    if (!lineText.includes('obsidian://margin?')) return;
    for (const m of lineText.matchAll(MARGIN_URL)) {
      const params = marginParams(m[1]);
      const file = params.file?.trim();
      const location = parseLocation(params.loc ?? null);
      if (file && location) out.push({ file, location, line, snippet: snippetOf(lineText) });
    }
  });
  return out;
}

/** A note's line made readable: link targets dropped (`[text](url)` → text, `[[a|b]]` → b), list and quote marks trimmed. */
export function snippetOf(line: string): string {
  const flat = line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]*)\]\]/g, (_, t: string) => t.replace(/#page=(\d+)/, ', page $1').replace(/\.(?:pdf|epub)\b/i, ''))
    .replace(/obsidian:\/\/margin\?\S+/g, '')
    .replace(/^\s*(?:[-*+]\s+(?:\[.\]\s+)?|\d+[.)]\s+|>\s*)+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(flat);
  return chars.length > SNIPPET_CHARS ? `${chars.slice(0, SNIPPET_CHARS).join('').trimEnd()}…` : flat;
}

const lineOf = (text: string, line: number) => text.split('\n')[line] ?? '';

interface Watcher {
  file: TFile;
  onChange: (links: Backlink[]) => void;
  /** What onChange was last given (serialized), so an unchanged refresh says nothing. */
  last: string | null;
  /** Bumped by each refresh of this watcher: only the newest may report (an older one may finish later). */
  seq: number;
}

/**
 * Where vault notes link into open books (feature: backlinks in the margin). Two kinds of link count:
 * - `obsidian://margin?file=<book>&loc=…` (Margin's Copy Link). Obsidian doesn't index external URLs, so
 *   these come from a text scan: each Markdown note is read once (cachedRead, bounded by SCAN_MAX_FILES
 *   and SCAN_MAX_BYTES) and its Margin links kept by path; `changed` events hand over the new text, so
 *   later updates read nothing.
 * - `[[Book.pdf#page=N]]` and `[x](Book.pdf#page=N)`: the notes linking the PDF are found in
 *   `metadataCache.resolvedLinks`, their links in `getFileCache(file).links` (and `.embeds`).
 * Nothing runs until a view watches a book; refreshes are debounced (BACKLINK_DELAY_MS) and never block
 * opening. A book no note links to costs a pass over resolvedLinks and the scan table, and draws nothing.
 */
export class BacklinkIndex {
  private readonly watchers = new Set<Watcher>();
  /** Margin links per note path, with the mtime they were read at. Null until the first watch. */
  private scanned: Map<string, { mtime: number; hits: MarginUrlHit[] }> | null = null;
  private scanning: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /** The scan hit SCAN_MAX_FILES once (said once, in the console). */
  private warnedCap = false;

  constructor(
    private readonly app: App,
    private readonly opts: { delayMs?: number; maxFiles?: number; maxBytes?: number } = {},
  ) {}

  /** Calls `onChange` with the book's backlinks now (soon, asynchronously) and after every change that alters them. */
  watch(file: TFile, onChange: (links: Backlink[]) => void): () => void {
    if (this.disposed) return () => {};
    const w: Watcher = { file, onChange, last: null, seq: 0 };
    this.watchers.add(w);
    void this.refresh([w]);
    return () => void this.watchers.delete(w);
  }

  /** metadataCache `changed`: the note's new text. */
  changed(file: TFile, data: string): void {
    if (this.disposed || file.extension !== 'md' || !this.scanned) return;
    // Nothing watched: no parsing. The entry goes, so the next watch's scan reads the note afresh.
    if (this.watchers.size === 0) {
      this.scanned.delete(file.path);
      return;
    }
    this.scanned.set(file.path, { mtime: file.stat.mtime, hits: this.isMarginNote(file) ? [] : marginUrlsIn(data) });
    this.schedule();
  }

  /** metadataCache `resolved`: resolvedLinks has caught up. */
  resolved(): void {
    this.schedule();
  }

  renamed(file: { path: string }, oldPath: string): void {
    const entry = this.scanned?.get(oldPath);
    if (entry && this.scanned) {
      this.scanned.delete(oldPath);
      this.scanned.set(file.path, entry);
    }
    this.schedule();
  }

  deleted(file: { path: string }): void {
    this.scanned?.delete(file.path);
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.watchers.clear();
  }

  private schedule(): void {
    if (this.disposed || this.watchers.size === 0) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh([...this.watchers]), this.opts.delayMs ?? BACKLINK_DELAY_MS);
  }

  private async refresh(watchers: Watcher[]): Promise<void> {
    try {
      const seqs = new Map(watchers.map((w) => [w, ++w.seq]));
      await this.scan();
      for (const w of watchers) {
        if (this.disposed || !this.watchers.has(w) || seqs.get(w) !== w.seq) continue;
        const links = await this.collect(w.file);
        if (this.disposed || !this.watchers.has(w) || seqs.get(w) !== w.seq) continue;
        const key = JSON.stringify(links);
        if (key === w.last) continue;
        w.last = key;
        w.onChange(links);
      }
    } catch (e) {
      console.warn('margin: could not work out the backlinks', e);
    }
  }

  /** Reads the notes not yet scanned (or changed since); one pass at a time. */
  private scan(): Promise<void> {
    this.scanned ??= new Map();
    this.scanning ??= (async () => {
      try {
        const table = this.scanned!;
        const max = this.opts.maxFiles ?? SCAN_MAX_FILES;
        const maxBytes = this.opts.maxBytes ?? SCAN_MAX_BYTES;
        // The most recently changed notes first: in a vault past the cap, those are the ones read.
        // Sorted only on the first scan (an empty table): later passes skip unchanged notes by mtime anyway.
        const files = [...this.app.vault.getMarkdownFiles()];
        const all = table.size === 0 ? files.sort((a, b) => b.stat.mtime - a.stat.mtime) : files;
        if (all.length > max && !this.warnedCap) {
          this.warnedCap = true;
          console.warn(`margin: the vault has ${all.length} notes; Margin links are looked for in the ${max} most recently changed`);
        }
        for (const f of all.slice(0, max)) {
          // Nothing watches any more (the book closed mid-scan): stop; the next watch picks up from here.
          if (this.disposed || this.watchers.size === 0) return;
          if (f.stat.size > maxBytes || table.get(f.path)?.mtime === f.stat.mtime) continue;
          const mtime = f.stat.mtime;
          const text = await this.app.vault.cachedRead(f);
          // A `changed` event that landed meanwhile already holds the newer text.
          if ((table.get(f.path)?.mtime ?? -Infinity) <= mtime) {
            table.set(f.path, { mtime, hits: this.isMarginNote(f) ? [] : marginUrlsIn(text) });
          }
        }
      } finally {
        this.scanning = null;
      }
    })();
    return this.scanning;
  }

  /**
   * Margin's own notes (a book's notebook note, and the "(edited …)" copies of one) carry `margin-book` in
   * their frontmatter. They link every highlight and thought back into the book, so they never count.
   */
  private isMarginNote(note: TFile): boolean {
    const fm = this.app.metadataCache.getFileCache(note)?.frontmatter as Record<string, unknown> | undefined;
    const v = fm?.['margin-book'];
    return v !== undefined && v !== null && v !== '';
  }

  /** The book's backlinks, in a stable order. */
  async collect(pdf: TFile): Promise<Backlink[]> {
    const out: Backlink[] = [];
    const cache = this.app.metadataCache;
    // `[[Book.pdf#page=N]]`, `[x](Book.pdf#page=N)`, `![[Book.pdf#page=N]]`: a PDF's pages only. An EPUB has
    // no pages (`#page=N` there is not a place Margin can name); its backlinks are Margin's own links below.
    const pageLinks = pdf.extension.toLowerCase() === 'pdf';
    for (const [source, dests] of pageLinks ? Object.entries(cache.resolvedLinks) : []) {
      if (!dests[pdf.path]) continue;
      const note = this.app.vault.getFileByPath(source);
      if (!note || note.extension !== 'md' || this.isMarginNote(note)) continue;
      const meta = cache.getFileCache(note);
      const refs = [...(meta?.links ?? []), ...(meta?.embeds ?? [])];
      let text: string | null = null;
      for (const ref of refs) {
        const { path, subpath } = splitLinktext(ref.link);
        const page = pageFromSubpath(subpath);
        if (page === null || cache.getFirstLinkpathDest(path, source)?.path !== pdf.path) continue;
        text ??= await this.app.vault.cachedRead(note);
        const line = ref.position.start.line;
        out.push({
          id: `${source}:${line}:${ref.position.start.col}`,
          location: pdfLocation({ page, start: 0, end: 0 }),
          sourcePath: source,
          sourceTitle: note.basename,
          snippet: snippetOf(lineOf(text, line)),
          line,
        });
      }
    }
    // `obsidian://margin?file=<book>&loc=…`
    for (const [source, entry] of this.scanned ?? []) {
      // A link whose location is for the other format (an epub place on a PDF, a page on an EPUB) names no
      // place in this book: left out rather than sent to the renderer.
      const hits = entry.hits.filter((h) => normalizePath(h.file) === pdf.path && h.location.kind === formatOf(pdf.path));
      if (!hits.length) continue;
      const note = this.app.vault.getFileByPath(source);
      if (!note || this.isMarginNote(note)) continue;
      hits.forEach((h, i) =>
        out.push({
          id: `${source}:${h.line}:url${i}:${serializeLocation(h.location)}`,
          location: h.location,
          sourcePath: source,
          sourceTitle: note.basename,
          snippet: h.snippet,
          line: h.line,
        }),
      );
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}
