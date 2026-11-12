import type { App, TFile } from 'obsidian';
import type { Book } from '../../../src/lib/types';
import { normalizeFolder } from '../settings';
import { sha256Hex } from '../store/hash';
import { bookTitle } from './generate';

interface MirrorRecord {
  path: string;
  /** SHA-256 of the content Margin last wrote there. */
  hash: string;
  /**
   * SHA-256 of that content without its `margin-progress:` front-matter line. Progress moves with every new
   * furthest page; on its own it is no reason to rewrite the note. Absent in records from before it existed:
   * such a record counts as changed once, then gets it.
   */
  stable?: string;
}

/** `content` without its `margin-progress:` front-matter line (only inside the leading front matter). */
export function withoutProgress(content: string): string {
  if (!content.startsWith('---\n')) return content;
  const end = content.indexOf('\n---\n', 3);
  if (end < 0) return content;
  const front = content
    .slice(4, end)
    .split('\n')
    .filter((line) => !line.startsWith('margin-progress:'))
    .join('\n');
  return `---\n${front}${content.slice(end)}`;
}

const UNSAFE = /[\\/:*?"<>|#^[\]]/g;
const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;

/** The most UTF-8 bytes a note's name may take (before " (2)" and ".md"); file systems allow 255. */
export const MAX_NAME_BYTES = 150;
/** Windows device names, including the console pair and COM/LPT with a superscript digit (¹ ² ³). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;

/** `name` cut to at most `max` UTF-8 bytes, whole code points only (a surrogate pair is never split). */
function cutToBytes(name: string, max: number): string {
  const enc = new TextEncoder();
  if (enc.encode(name).length <= max) return name;
  let out = '';
  let bytes = 0;
  for (const ch of name) {
    const n = enc.encode(ch).length;
    if (bytes + n > max) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/**
 * `<folder>/<book title or file name>.md`, with characters Obsidian can't use in a file name replaced, at
 * most MAX_NAME_BYTES long, without trailing dots or spaces (Windows drops them) and never a Windows
 * device name (`CON`, `LPT1`…: prefixed with `_`).
 */
export function mirrorPath(folder: string, book: Book): string {
  // A leading dot would hide the note from Obsidian.
  const clean = bookTitle(book).replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '').trim();
  let name = cutToBytes(clean, MAX_NAME_BYTES).replace(/[.\s]+$/, '') || 'Untitled';
  // `CON` or `CON.backup` alike: Windows reads the part before the first dot.
  if (WINDOWS_RESERVED.test(name.split('.')[0].trim())) name = `_${name}`;
  return join(normalizeFolder(folder), `${name}.md`);
}

export interface MirrorWriterDeps {
  app: App;
  /** The plugin's data folder (mirrors.json lives there). */
  root: string;
  notice: (message: string) => void;
  now?: () => Date;
  /** True once the plugin is going (the store closed): nothing more is written or recorded. */
  isClosed?: () => boolean;
}

/** How many times a note edited during Margin's own rewrite is re-read before the write gives up. */
const MAX_RACES = 5;

/**
 * Writes the generated notebook notes (spec §6). It never loses what the user typed: when the note on
 * disk isn't what Margin last wrote there, it is copied to "<name> (edited <date time>).md" first.
 * Writes run one at a time.
 */
export class MirrorWriter {
  private readonly deps: MirrorWriterDeps;
  private records: Record<string, MirrorRecord> | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** Vault paths this writer is creating, modifying or moving right now (both ends of a move). */
  private own = new Map<string, number>();

  constructor(deps: MirrorWriterDeps) {
    this.deps = deps;
  }

  write(bookId: string, desiredPath: string, content: string): Promise<void> {
    const run = this.queue.then(() => this.doWrite(bookId, desiredPath, content));
    this.queue = run.catch(() => {});
    return run;
  }

  /** True while `path` is being written or moved by this writer: vault events for it are the mirror's own. */
  isOwnWrite(path: string): boolean {
    return this.own.has(path);
  }

  /** Marks `paths` as the writer's own for the duration of `op`. */
  private async owning<T>(paths: string[], op: () => Promise<T>): Promise<T> {
    for (const p of paths) this.own.set(p, (this.own.get(p) ?? 0) + 1);
    try {
      return await op();
    } finally {
      for (const p of paths) {
        const n = (this.own.get(p) ?? 1) - 1;
        if (n > 0) this.own.set(p, n);
        else this.own.delete(p);
      }
    }
  }

  private get file(): string {
    return `${this.deps.root}/mirrors.json`;
  }

  private async load(): Promise<Record<string, MirrorRecord>> {
    if (this.records) return this.records;
    const adapter = this.deps.app.vault.adapter;
    let records: Record<string, MirrorRecord> = {};
    await this.recoverTmp();
    if (await adapter.exists(this.file)) {
      try {
        records = (JSON.parse(await adapter.read(this.file)) as { books?: Record<string, MirrorRecord> }).books ?? {};
      } catch (e) {
        // Unreadable: start afresh. Every existing note then counts as edited and is kept in a copy.
        console.warn('margin: mirrors.json is unreadable; existing notebook notes will be kept as copies', e);
      }
    }
    this.records = records;
    return this.records;
  }

  /** Where Margin last wrote this book's note (mirrors.json), which may be a " (2)" variant; null if never. */
  async recordedPath(bookId: string): Promise<string | null> {
    return (await this.load())[bookId]?.path ?? null;
  }

  /** Books with a notebook note on record (settings changes rewrite them). */
  async bookIds(): Promise<string[]> {
    return Object.keys(await this.load());
  }

  /**
   * A mirrors.json.tmp left by an interrupted save: when it parses it is the newer copy and goes into place
   * (a main file still next to it is dropped: it only holds hashes, nothing the user wrote); when it does
   * not, it goes and the main file stays.
   */
  private async recoverTmp(): Promise<void> {
    const adapter = this.deps.app.vault.adapter;
    const tmp = `${this.file}.tmp`;
    if (!(await adapter.exists(tmp))) return;
    let ok = false;
    try {
      const v = JSON.parse(await adapter.read(tmp)) as { books?: unknown } | null;
      ok = !!v && typeof v.books === 'object' && v.books !== null;
    } catch {
      ok = false;
    }
    if (ok && (await adapter.exists(this.file))) await adapter.remove(this.file);
    if (ok) await adapter.rename(tmp, this.file);
    else await adapter.remove(tmp);
  }

  /** Atomic, like the store: tmp, remove the old file, rename the tmp into place. */
  private async save(): Promise<void> {
    const { adapter } = this.deps.app.vault;
    const tmp = `${this.file}.tmp`;
    await adapter.write(tmp, JSON.stringify({ version: 1, books: this.records }, null, 2));
    if (await adapter.exists(this.file)) await adapter.remove(this.file);
    await adapter.rename(tmp, this.file);
  }

  private async doWrite(bookId: string, desiredPath: string, content: string): Promise<void> {
    const { vault, fileManager } = this.deps.app;
    const closed = () => this.deps.isClosed?.() ?? false;
    if (closed()) return;
    const records = await this.load();
    const path = this.claim(bookId, desiredPath, records);
    const known = records[bookId];
    // The book's title or file changed: move the note, so links to it follow.
    if (known && known.path !== path) {
      const old = vault.getFileByPath(known.path);
      if (old && !vault.getAbstractFileByPath(path)) {
        await this.ensureFolder(path);
        await this.owning([known.path, path], () => fileManager.renameFile(old, path));
      }
    }
    const hash = await sha256Hex(content);
    const stable = await sha256Hex(withoutProgress(content));
    const existing = vault.getFileByPath(path);
    // Margin has nothing new for this note (a reading-position save, or only a new furthest page): it is
    // left as it is, so an edit the user is making in it right now is neither copied away nor reverted, and
    // an open note doesn't flicker page by page. Only a deleted note comes back (with today's progress).
    const unchanged = known?.path === path && known.stable === stable;
    if (unchanged && existing) return;
    await this.ensureFolder(path);
    // known.hash is the full content Margin last wrote: the note on disk still matches it when untouched.
    if (existing) await this.replace(existing, content, known?.hash);
    else await this.owning([path], () => vault.create(path, content));
    // Recorded only when it changed.
    if (known?.path === path && known.hash === hash && known.stable === stable) return;
    records[bookId] = { path, hash, stable };
    // Past the unload bound: the next instance owns mirrors.json now; a stale record must not land.
    if (closed()) return;
    await this.save();
  }

  /**
   * Compare-and-replace inside vault.process, so an edit made between Margin's read and its write is
   * never overwritten: on a mismatch the note is left as it is and read again (copy first, then write).
   */
  private async replace(file: TFile, content: string, knownHash: string | undefined): Promise<void> {
    const { vault } = this.deps.app;
    for (let race = 0; race < MAX_RACES; race++) {
      const disk = await vault.read(file);
      if (disk === content) return;
      if (knownHash !== (await sha256Hex(disk))) await this.keepCopy(file, disk);
      let raced = false;
      await this.owning([file.path], () =>
        vault.process(file, (now) => {
          if (now === disk) return content;
          raced = true;
          return now;
        }),
      );
      if (!raced) return;
      // The note changed under us: what is there now is the user's; the next pass keeps it in a copy.
      knownHash = undefined;
    }
    throw new Error(`${file.path} kept changing while Readside rewrote it; it was left as it is`);
  }

  /**
   * `desired`, or `desired` with " (2)", " (3)"… when another book's note already has that path, or when the
   * note is moving (a retitle, a new folder) onto a path where the user has a note of their own (in the vault,
   * not on record): that note is never taken over. A first write to an existing note keeps the path (the note
   * is copied first, as any edited note).
   */
  private claim(bookId: string, desired: string, records: Record<string, MirrorRecord>): string {
    const taken = new Set(
      Object.entries(records)
        .filter(([id]) => id !== bookId)
        .map(([, r]) => r.path),
    );
    const known = records[bookId];
    const moving = known !== undefined && known.path !== desired;
    const free = (p: string) =>
      !taken.has(p) && (!moving || p === known.path || this.deps.app.vault.getAbstractFileByPath(p) === null);
    if (free(desired)) return desired;
    const base = desired.replace(/\.md$/, '');
    for (let n = 2; ; n++) {
      const p = `${base} (${n}).md`;
      if (free(p)) return p;
    }
  }

  private async keepCopy(file: TFile, disk: string): Promise<void> {
    const { vault } = this.deps.app;
    const dir = parentOf(file.path);
    const name = `${file.basename} (edited ${stamp(this.deps.now?.() ?? new Date())})`;
    let target = join(dir, `${name}.md`);
    for (let n = 2; vault.getAbstractFileByPath(target); n++) target = join(dir, `${name} ${n}.md`);
    await this.owning([target], () => vault.create(target, disk));
    this.deps.notice(`Readside kept your edits to “${file.basename}” in “${target.slice(target.lastIndexOf('/') + 1, -3)}”. The notebook note is written by Readside.`);
  }

  private async ensureFolder(path: string): Promise<void> {
    const dir = parentOf(path);
    if (dir && !this.deps.app.vault.getAbstractFileByPath(dir)) await this.deps.app.vault.createFolder(dir);
  }
}
