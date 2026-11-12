export type Format = 'pdf' | 'epub' | 'txt' | 'md' | 'html';

export const COLORS = ['yellow', 'green', 'blue', 'pink', 'purple'] as const;
export type Color = (typeof COLORS)[number];

export interface PdfLocationValue {
  page: number; // 1-based
  start: number; // char offset in the page's text-layer text
  end: number;
  /**
   * Point locations only (start === end): top of the line as a fraction of the page height, 0–1.
   * Used where the offset can't be placed (a page without a text layer).
   */
  y?: number;
}

/** A place in an epub: offsets into one spine section's text. Label `§ <section>`. */
export interface EpubLocationValue {
  section: number; // 1-based index in the spine (every itemref, linear or not)
  start: number; // char offset in the section's text (indexText of its sanitised root)
  end: number;
  /** Point locations only (start === end): 0–1 fraction of the section's height. */
  y?: number;
  /**
   * The text model the section number and offsets were written in (EPUB_TEXT_MODEL in lib/location;
   * see SANITIZER_VERSION). Absent in locations written before it existed: model 3. A future model bump
   * migrates older locations (re-anchor by quote; points snap to the nearest block start).
   */
  v?: number;
}

export type Location =
  | { kind: 'pdf'; value: PdfLocationValue; label: string }
  | { kind: 'epub'; value: EpubLocationValue; label: string }
  | { kind: 'text'; value: { start: number; end: number }; label: string };

export interface Book {
  id: string;
  contentHash: string;
  path: string;
  format: Format;
  title: string | null;
  author: string | null;
  lastLocation: string | null; // Location JSON
  addedAt: string;
  openedAt: string | null;
  zoom: string | null; // 'fit-width' | 'fit-page' | '<percent>'; null = fit width
  progress: number | null; // furthest point reached, 0–1
}

export interface BookEntry extends Book {
  missing: boolean;
}

export interface Annotation {
  id: string;
  bookId: string;
  location: string; // Location JSON
  quote: string;
  color: Color;
  note: string | null;
  unanchored: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ImportResult {
  books: Book[];
  errors: string[];
}

export interface RelocateResult {
  book: Book;
  hashMatches: boolean;
}

export interface NewAnnotationInput {
  bookId: string;
  location: Location;
  quote: string;
  color: Color;
  note?: string | null;
}

export interface AnnotationPatchInput {
  location?: Location;
  /** Must not be blank. Honoured only where Backend.patchesQuote (Obsidian); desktop drops it. */
  quote?: string;
  color?: Color;
  note?: string; // "" clears
  unanchored?: boolean;
}

export interface Thought {
  id: string;
  bookId: string;
  body: string; // Markdown, stored verbatim
  anchorId: string | null; // annotation it hangs off
  location: string | null; // Location JSON; used when anchorId is null
  position: number; // tiebreak within the same place
  createdAt: string;
  updatedAt: string;
  labelSection: string | null; // automatic label line 1 (outline section)
  labelSnippet: string | null; // automatic label line 2, e.g. 'p. 42 · “The law…”'; null until computed
  labelCustom: string | null; // the user's rename; replaces both lines
}

export interface NewThoughtInput {
  bookId: string;
  body?: string;
  anchorId?: string | null;
  location?: Location | null;
}

export interface ThoughtPatchInput {
  body?: string;
  anchorId?: string | null; // null unlinks
  location?: Location | null; // null clears
  position?: number;
  labelCustom?: string | null; // null or "" restores the automatic label
}

/**
 * An outline (table of contents) entry. `page` is null when its destination can't be resolved (pdf
 * page, epub section). `at` is the exact in-page target when the format has one (an epub anchor);
 * absent for PDF.
 */
export interface OutlineEntry {
  title: string;
  page: number | null;
  children: OutlineEntry[];
  at?: Location;
}
