import type { ShelfEntry } from '../store/bookStore';
import { isZip } from './epubCover';
import { COVER_EXTENSIONS, type CoverChoice, type CoverExt, type IndexEntry } from '../store/types';

/** How long after a request a thumbnail job starts: the book's own open (or the shelf's first paint) goes first. */
export const COVER_DELAY_MS = 1500;
/** The largest pasted image taken as a cover. */
/** The pause between two queued thumbnail jobs, so a big shelf never hogs the main thread. */
export const JOB_GAP_MS = 50;
/** A `.tmp` younger than this may belong to a write in flight: the sweep leaves it. */
export const TMP_GRACE_MS = 60_000;
export const MAX_PASTED_BYTES = 10 * 1024 * 1024;

/** The adapter calls covers need; Obsidian's `app.vault.adapter` satisfies it. */
export interface CoverAdapter {
  exists(path: string): Promise<boolean>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
  rename(path: string, newPath: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  getResourcePath(path: string): string;
  stat(path: string): Promise<{ mtime: number } | null>;
}

/** The index calls covers need (BookStore satisfies it). */
export interface CoverIndex {
  entryOf(bookId: string): (IndexEntry & { path: string }) | null;
  bookIds(): Set<string>;
  setCover(bookId: string, cover: CoverChoice | null): Promise<void>;
  setThumb(bookId: string, fp: string): Promise<void>;
}

export interface CoverDeps {
  adapter: CoverAdapter;
  /** `<configDir>/plugins/margin-reader` */
  root: string;
  index: CoverIndex;
  /** Resolves once the store and pdf.js are ready (a job waits for it; a rejection skips the job). */
  ready: () => Promise<void>;
  readBytes: (path: string) => Promise<ArrayBuffer>;
  /** Page 1 as WebP bytes, or null when it can't be drawn. */
  render: (bytes: ArrayBuffer) => Promise<ArrayBuffer | null>;
  /** The cover image of an EPUB (a zip) as WebP bytes, or null. Without it an EPUB goes to `render`. */
  renderEpub?: (bytes: ArrayBuffer) => Promise<ArrayBuffer | null>;
  /** The resource URL of a vault image, or null when there is no such image (deleted, or not an image). */
  vaultImage: (path: string) => string | null;
  delayMs?: number;
  /** The pause between two queued thumbnail jobs (default JOB_GAP_MS). */
  gapMs?: number;
}

/** What a shelf card draws: an image, or the colour tile (`src` null). */
export interface CoverView {
  src: string | null;
  /** The automatic thumbnail is wanted and not made yet: the card asks for it. */
  wantsThumb: boolean;
}

const COVER_FILE = new RegExp(`^(.+?)(-custom)?\\.(${COVER_EXTENSIONS.join('|')})$`);
const withQuery = (url: string, v: string) => `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(v)}`;

/**
 * Book covers (plugin only): first-page thumbnails rendered in the background, one at a time, into
 * `covers/<bookId>.webp`; pasted images in `covers/<bookId>-custom.<ext>`; and what each shelf card shows.
 */
export class CoverManager {
  private readonly deps: CoverDeps;
  private readonly delayMs: number;
  private readonly gapMs: number;
  private queue: string[] = [];
  private queued = new Set<string>();
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** `bookId fingerprint` pairs whose page 1 could not be drawn this session: not tried again. */
  private failed = new Set<string>();
  /** Book id → how many times its thumbnail was rewritten this session (so a rewritten file is not shown from cache). */
  private written = new Map<string, number>();
  private listeners = new Set<(bookId: string) => void>();
  private disposed = false;

  constructor(deps: CoverDeps) {
    this.deps = deps;
    this.delayMs = deps.delayMs ?? COVER_DELAY_MS;
    this.gapMs = deps.gapMs ?? JOB_GAP_MS;
  }

  get dir(): string {
    return `${this.deps.root}/covers`;
  }
  thumbPath(bookId: string): string {
    return `${this.dir}/${bookId}.webp`;
  }
  pastedPath(bookId: string, ext: CoverExt): string {
    return `${this.dir}/${bookId}-custom.${ext}`;
  }

  /** Tells `listener` when a book's cover file changed; returns the unsubscribe. */
  onChange(listener: (bookId: string) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** What the shelf card of `entry` shows (its cover choice and thumbnail record come from the index). */
  view(entry: Pick<ShelfEntry, 'bookId' | 'missing'>): CoverView {
    const found = this.deps.index.entryOf(entry.bookId);
    if (!found) return { src: null, wantsThumb: false };
    const e = { bookId: entry.bookId, missing: entry.missing, fingerprint: found.fingerprint, thumb: found.thumb ?? null };
    const c = found.cover;
    if (c?.kind === 'tile') return { src: null, wantsThumb: false };
    if (c?.kind === 'vault') {
      const src = this.deps.vaultImage(c.path);
      if (src) return { src, wantsThumb: false };
      // The image is gone (deleted while Margin wasn't watching): automatic until the user chooses again.
    }
    if (c?.kind === 'pasted') {
      return { src: withQuery(this.deps.adapter.getResourcePath(this.pastedPath(e.bookId, c.ext)), c.at), wantsThumb: false };
    }
    if (e.thumb !== null && e.thumb === e.fingerprint) {
      const v = `${e.thumb.slice(-8)}-${this.written.get(e.bookId) ?? 0}`;
      return { src: withQuery(this.deps.adapter.getResourcePath(this.thumbPath(e.bookId)), v), wantsThumb: false };
    }
    const wantsThumb = !e.missing && !this.failed.has(`${e.bookId} ${e.fingerprint}`);
    return { src: null, wantsThumb };
  }

  /**
   * Asks for the book's first-page thumbnail. In the background: the job starts COVER_DELAY_MS later, one
   * book at a time, and is skipped when the thumbnail on disk is from the book's current content.
   */
  request(bookId: string): void {
    if (this.disposed || this.queued.has(bookId)) return;
    this.queued.add(bookId);
    this.queue.push(bookId);
    this.kick();
  }

  /** Resolves once every requested job has run (tests; and nothing else waits on covers). */
  async idle(): Promise<void> {
    while (this.running || this.timer !== null) {
      if (this.running) await this.running;
      else await new Promise((r) => setTimeout(r, this.delayMs + 1));
    }
  }

  private kick(): void {
    if (this.running || this.timer !== null || this.queue.length === 0 || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.drain().finally(() => {
        this.running = null;
        this.kick();
      });
    }, this.delayMs);
  }

  private async drain(): Promise<void> {
    while (this.queue.length && !this.disposed) {
      const bookId = this.queue.shift()!;
      try {
        await this.generate(bookId);
      } catch (e) {
        console.debug(`margin: no cover for ${bookId}`, e);
      } finally {
        this.queued.delete(bookId);
      }
      if (this.queue.length && !this.disposed) await new Promise((r) => setTimeout(r, this.gapMs));
    }
  }

  private async generate(bookId: string): Promise<void> {
    await this.deps.ready();
    const e = this.deps.index.entryOf(bookId);
    if (!e || e.missing || this.disposed) return;
    // A tile, a pasted image, or a vault image that is there shows no thumbnail: none is made.
    const c = e.cover;
    if (c?.kind === 'tile' || c?.kind === 'pasted' || (c?.kind === 'vault' && this.deps.vaultImage(c.path) !== null)) return;
    const fp = e.fingerprint;
    const key = `${bookId} ${fp}`;
    if (this.failed.has(key)) return;
    const path = this.thumbPath(bookId);
    if (e.thumb === fp && (await this.deps.adapter.exists(path))) return;
    let webp: ArrayBuffer | null = null;
    try {
      const bytes = await this.deps.readBytes(e.path);
      webp = await (this.deps.renderEpub && isZip(bytes) ? this.deps.renderEpub : this.deps.render)(bytes);
    } catch {
      webp = null;
    }
    if (!webp) {
      // The colour tile stays; not tried again this session for this content.
      this.failed.add(key);
      this.emit(bookId);
      return;
    }
    if (this.disposed) return;
    // A write that fails (the rename, say) is not remembered as failed: the next request tries again.
    await this.write(path, webp);
    this.written.set(bookId, (this.written.get(bookId) ?? 0) + 1);
    await this.deps.index.setThumb(bookId, fp);
    this.emit(bookId);
  }

  /**
   * The user's choice from the card menu. A pasted image no longer chosen is removed. `install` puts a new
   * file in place once the index took the choice; if it fails the choice is put back.
   */
  async choose(bookId: string, cover: CoverChoice | null, install?: () => Promise<void>): Promise<void> {
    const before = this.deps.index.entryOf(bookId)?.cover;
    await this.deps.index.setCover(bookId, cover);
    if (install) {
      try {
        await install();
      } catch (e) {
        await this.deps.index.setCover(bookId, before ?? null).catch(() => {});
        throw e;
      }
    }
    if (before?.kind === 'pasted' && !(cover?.kind === 'pasted' && cover.ext === before.ext)) {
      await this.removeIfThere(this.pastedPath(bookId, before.ext));
    }
    if (cover === null || cover.kind === 'page') this.request(bookId);
    this.emit(bookId);
  }

  /**
   * An image pasted as the book's cover. It is written under a temp name first; the earlier `-custom` file is
   * replaced only after the index took the new choice, and on any failure the temp file is removed.
   */
  async paste(bookId: string, data: ArrayBuffer, ext: CoverExt): Promise<void> {
    if (data.byteLength > MAX_PASTED_BYTES) throw new Error('the image is larger than 10 MB');
    const { adapter } = this.deps;
    const path = this.pastedPath(bookId, ext);
    const tmp = `${path}.tmp`;
    try {
      if (!(await adapter.exists(this.dir))) await adapter.mkdir(this.dir);
      await adapter.writeBinary(tmp, data);
      await this.choose(bookId, { kind: 'pasted', ext, at: new Date().toISOString() }, async () => {
        if (await adapter.exists(path)) await adapter.remove(path);
        await adapter.rename(tmp, path);
      });
    } catch (e) {
      await this.removeIfThere(tmp);
      throw e;
    }
  }

  /**
   * After the store loads: cover files of books the index no longer knows, pasted images their book chose
   * something else over, and writes cut short (`.tmp`, older than a minute) are removed, so the folder never outgrows the index.
   */
  async sweep(): Promise<void> {
    const { adapter, index } = this.deps;
    if (!(await adapter.exists(this.dir))) return;
    const ids = index.bookIds();
    for (const f of (await adapter.list(this.dir)).files) {
      const name = f.slice(f.lastIndexOf('/') + 1);
      if (name.endsWith('.tmp')) {
        // A write in flight owns a young .tmp.
        const st = await adapter.stat(f).catch(() => null);
        if (st && Date.now() - st.mtime < TMP_GRACE_MS) continue;
      }
      const m = COVER_FILE.exec(name);
      let keep = false;
      if (m && ids.has(m[1])) {
        if (!m[2]) keep = m[3] === 'webp';
        else {
          // Known book: a pasted image is only removed once the index names another valid choice. An unset (or
          // dropped-as-invalid) cover is kept: after an index recovery the file is all that is left of the choice.
          const c = index.entryOf(m[1])?.cover;
          keep = !c || (c.kind === 'pasted' && c.ext === m[3]);
        }
      }
      if (keep) continue;
      try {
        await adapter.remove(f);
      } catch (e) {
        console.warn(`margin: could not remove the unused cover ${f}`, e);
      }
    }
  }

  /** No more jobs (the plugin is unloading); a job in flight stops before it writes. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.queued.clear();
    this.listeners.clear();
  }

  /** tmp → remove → rename, like the store's writes. */
  private async write(path: string, data: ArrayBuffer): Promise<void> {
    const { adapter } = this.deps;
    if (!(await adapter.exists(this.dir))) await adapter.mkdir(this.dir);
    const tmp = `${path}.tmp`;
    try {
      await adapter.writeBinary(tmp, data);
      if (await adapter.exists(path)) await adapter.remove(path);
      await adapter.rename(tmp, path);
    } catch (e) {
      await this.removeIfThere(tmp);
      throw e;
    }
  }

  private async removeIfThere(path: string): Promise<void> {
    try {
      if (await this.deps.adapter.exists(path)) await this.deps.adapter.remove(path);
    } catch (e) {
      console.warn(`margin: could not remove ${path}`, e);
    }
  }

  private emit(bookId: string): void {
    for (const l of [...this.listeners]) {
      try {
        l(bookId);
      } catch (e) {
        console.error('margin: cover listener failed', e);
      }
    }
  }
}
