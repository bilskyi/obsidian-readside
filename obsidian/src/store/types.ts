import type { Annotation, Book, Thought } from '../../../src/lib/types';

/** `<root>/books/<bookId>.json`: everything the reader stores for one book (spec §5). */
export interface BookFile {
  version: 1;
  book: Book;
  annotations: Annotation[];
  thoughts: Thought[];
}

export interface IndexEntry {
  bookId: string;
  /** `<size>:<sha256 of the first 256 KiB>` */
  fingerprint: string;
  /** The file was deleted; the book's data is kept for a later reattach. */
  missing: boolean;
  /**
   * When the book was last opened in Margin (ISO time), so the picker can sort without reading book
   * files. Optional: index files written before it existed load without it.
   */
  openedAt?: string;
  /**
   * What the shelf shows of the book, so it never reads book files to draw its grid. Optional: index files
   * written before it existed load without it, and it is filled in the first time the book loads.
   */
  summary?: BookSummary;
  /** The cover the user chose on the shelf. Optional: absent is automatic (the first page, else the colour tile). */
  cover?: CoverChoice;
  /**
   * The fingerprint the first-page thumbnail (`covers/<bookId>.webp`) was rendered from: when it equals the
   * entry's own fingerprint the thumbnail is current. Optional: absent means none was made yet.
   */
  thumb?: string;
}

/** Image types a cover may be (vault images and pasted ones). */
export const COVER_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] as const;
export type CoverExt = (typeof COVER_EXTENSIONS)[number];

/**
 * What a book's cover is: the colour tile from its title, the first page, an image in the vault (followed
 * when it moves, dropped when it is deleted), or an image pasted into `covers/<bookId>-custom.<ext>`.
 */
export type CoverChoice =
  | { kind: 'tile' }
  | { kind: 'page' }
  | { kind: 'vault'; path: string }
  /** `at`: when it was pasted (ISO), so a new paste of the same type is not shown from the cache. */
  | { kind: 'pasted'; ext: CoverExt; at: string };

/** A book at a glance, kept in its index entry: refreshed after each write of the book (spec: the Shelf). */
export interface BookSummary {
  title: string | null;
  /** The furthest point reached, 0–1 (the book's own `progress`). */
  progress: number | null;
  /** The page of the book's last location, when it is a PDF location. */
  page: number | null;
  /** How many pages the PDF has, once a reader has reported it. */
  pageCount?: number;
  annotationCount: number;
  thoughtCount: number;
  /** Local `yyyy-mm` of each thought's creation → how many: "thoughts this month" without the book file. */
  thoughtsByMonth: Record<string, number>;
  /**
   * The newest of the book's added time and its highlights' and thoughts' `updatedAt`. Not the opened
   * time: reading alone (the entry's own `openedAt`) never changes a summary's structure.
   */
  updatedAt: string;
}

/** `<root>/index.json`: vault path → book. */
export interface IndexFile {
  version: 1;
  entries: Record<string, IndexEntry>;
}

/** The DataAdapter calls the store uses; Obsidian's `app.vault.adapter` satisfies it. */
export interface StoreAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(path: string, newPath: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}
