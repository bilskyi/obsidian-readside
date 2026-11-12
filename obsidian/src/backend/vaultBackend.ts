import type { Backend, ConfirmOptions } from '../../../src/lib/backend';
import { serializeLocation } from '../../../src/lib/location';
import {
  COLORS,
  type Annotation,
  type AnnotationPatchInput,
  type BookEntry,
  type Color,
  type ImportResult,
  type Location,
  type NewAnnotationInput,
  type NewThoughtInput,
  type RelocateResult,
  type Thought,
  type ThoughtPatchInput,
} from '../../../src/lib/types';
import type { BookStore, DeepReadonly } from '../store/bookStore';
import { invalid, MarginError, notFound } from '../store/errors';
import type { BookFile } from '../store/types';

export const NOT_IN_OBSIDIAN = 'Readside in Obsidian reads PDFs from your vault: open one from the file explorer.';

export interface VaultBackendDeps {
  readBytes(path: string): Promise<ArrayBuffer>;
  confirm(message: string, opts: ConfirmOptions): Promise<boolean>;
}

const copy = <T>(v: T | DeepReadonly<T>): T => JSON.parse(JSON.stringify(v)) as T;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Notes are stored trimmed; blank is none (Rust normalize_note). */
const normalizeNote = (note: string | null | undefined) => note?.trim() || null;

/** 'fit-width', 'fit-page' or a whole percentage 50–300 without a leading zero (Rust books::is_valid_zoom). */
export const isValidZoom = (z: string): boolean =>
  z === 'fit-width' || z === 'fit-page' || (/^[1-9][0-9]{1,2}$/.test(z) && Number(z) >= 50 && Number(z) <= 300);

function validateColor(color: string): asserts color is Color {
  if (!(COLORS as readonly string[]).includes(color)) throw invalid(`unknown color: ${color}`);
}

/**
 * The plugin's Backend: the Rust command semantics (src-tauri/src/db/*.rs) over the vault BookStore.
 * Every call resolves once the change is written; a failed write rejects, so bodySaves keeps retrying.
 */
export class VaultBackend implements Backend {
  /** updateAnnotation takes `quote`: a merged highlight keeps its id. */
  readonly patchesQuote = true;
  private readonly store: BookStore;
  private readonly deps: VaultBackendDeps;

  constructor(store: BookStore, deps: VaultBackendDeps) {
    this.store = store;
    this.deps = deps;
  }

  private stamp(): string {
    return this.store.now().toISOString();
  }

  private owner(kind: 'annotation' | 'thought', id: string): string {
    const bookId = this.store.ownerOf(id);
    if (!bookId) throw notFound(kind, id);
    return bookId;
  }

  /** Lists of an unknown book are empty, as an SQL query for it would be. */
  private async fileOrNull(bookId: string): Promise<DeepReadonly<BookFile> | null> {
    try {
      return await this.store.file(bookId);
    } catch (e) {
      if (String(e).startsWith('not found')) return null;
      throw e;
    }
  }

  /** An anchor must be an annotation of the same book (Rust thoughts::validate_anchor). */
  private validateAnchor(f: DeepReadonly<BookFile>, anchorId: string): void {
    if (f.annotations.some((a) => a.id === anchorId)) return;
    // ownerOf is never pruned: the annotation must still exist in that book to count as foreign.
    const other = this.store.ownerOf(anchorId);
    const foreign = other !== null && other !== f.book.id && !!this.store.peek(other)?.annotations.some((a) => a.id === anchorId);
    throw invalid(foreign ? `annotation ${anchorId} belongs to another book` : `unknown annotation ${anchorId}`);
  }

  // ---- books ----

  async listBooks(): Promise<BookEntry[]> {
    return this.store.listBooks();
  }

  async importBooks(_paths: string[]): Promise<ImportResult> {
    throw new MarginError(NOT_IN_OBSIDIAN);
  }

  async relocateBook(_bookId: string, _path: string, _acceptDifferent: boolean): Promise<RelocateResult> {
    throw new MarginError(NOT_IN_OBSIDIAN);
  }

  async readBookBytes(bookId: string): Promise<ArrayBuffer> {
    const f = await this.store.file(bookId);
    return this.deps.readBytes(f.book.path);
  }

  async setLastLocation(bookId: string, location: Location): Promise<void> {
    const now = this.stamp();
    await this.store.mutate(bookId, (f) => {
      f.book.lastLocation = serializeLocation(location);
      f.book.openedAt = now;
    });
  }

  async setBookZoom(bookId: string, zoom: string | null): Promise<void> {
    if (zoom !== null && !isValidZoom(zoom)) throw invalid(`invalid zoom ${JSON.stringify(zoom)}`);
    await this.store.mutate(bookId, (f) => void (f.book.zoom = zoom));
  }

  /** Keeps the maximum, clamped to 0–1 (Rust books::set_progress). */
  async setBookProgress(bookId: string, progress: number): Promise<void> {
    if (!Number.isFinite(progress)) throw invalid(`invalid progress ${progress}`);
    const p = Math.min(1, Math.max(0, progress));
    await this.store.mutate(bookId, (f) => void (f.book.progress = Math.max(f.book.progress ?? 0, p)));
  }

  // ---- annotations ----

  async listAnnotations(bookId: string): Promise<Annotation[]> {
    const f = await this.fileOrNull(bookId);
    return f ? copy<Annotation[]>(f.annotations).sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id)) : [];
  }

  async getAnnotation(id: string): Promise<Annotation> {
    const f = await this.store.file(this.owner('annotation', id));
    const a = f.annotations.find((x) => x.id === id);
    if (!a) throw notFound('annotation', id);
    return copy(a);
  }

  async createAnnotation(input: NewAnnotationInput): Promise<Annotation> {
    validateColor(input.color);
    if (!input.quote.trim()) throw invalid('quote must not be empty');
    const now = this.stamp();
    const id = this.store.uuid();
    return this.store.mutate(input.bookId, (f) => {
      const a: Annotation = {
        id,
        bookId: input.bookId,
        location: serializeLocation(input.location),
        quote: input.quote,
        color: input.color,
        note: normalizeNote(input.note),
        unanchored: false,
        createdAt: now,
        updatedAt: now,
      };
      f.annotations.push(a);
      return copy(a);
    });
  }

  /**
   * Absent or null fields are kept; `note: ""` clears (Rust annotations::update). `quote` (not in Rust's
   * patch) replaces the text when a merged highlight takes the union's: it must not be blank.
   */
  async updateAnnotation(id: string, patch: AnnotationPatchInput): Promise<Annotation> {
    const bookId = this.owner('annotation', id);
    const now = this.stamp();
    return this.store.mutate(bookId, (f) => {
      const a = f.annotations.find((x) => x.id === id);
      if (!a) throw notFound('annotation', id);
      if (patch.quote != null && !patch.quote.trim()) throw invalid('quote must not be empty');
      if (patch.location != null) a.location = serializeLocation(patch.location);
      if (patch.quote != null) a.quote = patch.quote;
      if (patch.color != null) {
        validateColor(patch.color);
        a.color = patch.color;
      }
      if (patch.note != null) a.note = normalizeNote(patch.note);
      if (patch.unanchored != null) a.unanchored = patch.unanchored;
      a.updatedAt = now;
      return copy(a);
    });
  }

  /** Its thoughts keep its place: they get its location and lose the anchor (Rust annotations::delete). */
  async deleteAnnotation(id: string): Promise<void> {
    const bookId = this.owner('annotation', id);
    await this.store.mutate(bookId, (f) => {
      const i = f.annotations.findIndex((x) => x.id === id);
      if (i < 0) throw notFound('annotation', id);
      const [a] = f.annotations.splice(i, 1);
      for (const t of f.thoughts) {
        if (t.anchorId === id) {
          t.location = a.location;
          t.anchorId = null;
        }
      }
    });
  }

  // ---- thoughts ----

  async listThoughts(bookId: string): Promise<Thought[]> {
    const f = await this.fileOrNull(bookId);
    return f ? copy<Thought[]>(f.thoughts).sort((a, b) => a.position - b.position || cmp(a.id, b.id)) : [];
  }

  async createThought(input: NewThoughtInput): Promise<Thought> {
    const now = this.stamp();
    const id = this.store.uuid();
    return this.store.mutate(input.bookId, (f) => {
      if (input.anchorId != null) this.validateAnchor(f, input.anchorId);
      const position = f.thoughts.length ? Math.max(...f.thoughts.map((t) => t.position)) + 1 : 1;
      const t: Thought = {
        id,
        bookId: input.bookId,
        body: input.body ?? '',
        anchorId: input.anchorId ?? null,
        location: input.location ? serializeLocation(input.location) : null,
        position,
        createdAt: now,
        updatedAt: now,
        labelSection: null,
        labelSnippet: null,
        labelCustom: null,
      };
      f.thoughts.push(t);
      return copy(t);
    });
  }

  /**
   * body/position: null or absent = keep. anchorId/location/labelCustom: absent = keep, null = clear.
   * A new anchor clears the location (an anchored thought takes its place from the anchor).
   */
  async updateThought(id: string, patch: ThoughtPatchInput): Promise<Thought> {
    const bookId = this.owner('thought', id);
    const now = this.stamp();
    return this.store.mutate(bookId, (f) => {
      const t = f.thoughts.find((x) => x.id === id);
      if (!t) throw notFound('thought', id);
      if (patch.body != null) t.body = patch.body;
      if (patch.location !== undefined) t.location = patch.location === null ? null : serializeLocation(patch.location);
      if (patch.anchorId !== undefined) {
        if (patch.anchorId !== null) {
          this.validateAnchor(f, patch.anchorId);
          t.location = null;
        }
        t.anchorId = patch.anchorId;
      }
      if (patch.position != null) t.position = patch.position;
      if (patch.labelCustom !== undefined) t.labelCustom = patch.labelCustom?.trim() || null;
      t.updatedAt = now;
      return copy(t);
    });
  }

  async deleteThought(id: string): Promise<void> {
    const bookId = this.owner('thought', id);
    await this.store.mutate(bookId, (f) => {
      const i = f.thoughts.findIndex((x) => x.id === id);
      if (i < 0) throw notFound('thought', id);
      f.thoughts.splice(i, 1);
    });
  }

  /** Not a user edit: body, custom label and updatedAt stay (Rust thoughts::set_auto_labels). */
  async setThoughtAutoLabels(id: string, section: string | null, snippet: string): Promise<Thought> {
    const label = snippet.trim();
    if (!label) throw invalid('an automatic label needs a snippet');
    const bookId = this.owner('thought', id);
    return this.store.mutate(bookId, (f) => {
      const t = f.thoughts.find((x) => x.id === id);
      if (!t) throw notFound('thought', id);
      t.labelSection = section?.trim() || null;
      t.labelSnippet = label;
      return copy(t);
    });
  }

  confirm(message: string, opts: ConfirmOptions): Promise<boolean> {
    return this.deps.confirm(message, opts);
  }
}
