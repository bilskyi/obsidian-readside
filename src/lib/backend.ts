import type {
  Annotation,
  AnnotationPatchInput,
  BookEntry,
  ImportResult,
  Location,
  NewAnnotationInput,
  NewThoughtInput,
  RelocateResult,
  Thought,
  ThoughtPatchInput,
} from './types';
import { tauriBackend } from './tauriBackend';

export interface ConfirmOptions {
  title: string;
  kind?: 'info' | 'warning' | 'error';
  okLabel?: string;
  cancelLabel?: string;
}

/**
 * Everything the shared reader asks of its host: the shape of ipc.ts `api` without the desktop-only
 * calls (deep links, exit), plus a confirmation dialog. Desktop: tauriBackend. Obsidian: VaultBackend.
 */
export interface Backend {
  listBooks(): Promise<BookEntry[]>;
  importBooks(paths: string[]): Promise<ImportResult>;
  relocateBook(bookId: string, path: string, acceptDifferent: boolean): Promise<RelocateResult>;
  readBookBytes(bookId: string): Promise<ArrayBuffer>;
  setLastLocation(bookId: string, location: Location): Promise<void>;
  setBookZoom(bookId: string, zoom: string | null): Promise<void>;
  /** Keeps the maximum: reading backwards never lowers it. */
  setBookProgress(bookId: string, progress: number): Promise<void>;
  listAnnotations(bookId: string): Promise<Annotation[]>;
  getAnnotation(id: string): Promise<Annotation>;
  createAnnotation(input: NewAnnotationInput): Promise<Annotation>;
  updateAnnotation(id: string, patch: AnnotationPatchInput): Promise<Annotation>;
  deleteAnnotation(id: string): Promise<void>;
  listThoughts(bookId: string): Promise<Thought[]>;
  createThought(input: NewThoughtInput): Promise<Thought>;
  /** Absent fields are kept; `null` anchorId/location/labelCustom clear them. */
  updateThought(id: string, patch: ThoughtPatchInput): Promise<Thought>;
  deleteThought(id: string): Promise<void>;
  setThoughtAutoLabels(id: string, section: string | null, snippet: string): Promise<Thought>;
  confirm(message: string, opts: ConfirmOptions): Promise<boolean>;
  /**
   * True when updateAnnotation honours `quote` (Obsidian), so a merged highlight keeps its id. Desktop's
   * store ignores it: a merge there creates the union as a new highlight.
   */
  readonly patchesQuote?: boolean;
}

let active: Backend | null = null;

/** Installs the host's backend; `null` goes back to the default (Tauri). */
export function setBackend(b: Backend | null): void {
  active = b;
}

/** The backend shared modules call. */
export function backend(): Backend {
  return active ?? tauriBackend;
}
