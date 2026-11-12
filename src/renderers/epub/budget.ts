/**
 * One work budget per opened book, shared by every section's `sanitizeSection` and every `scopeCss` call
 * (as the font `families` map is). The per-section and per-sheet caps bound one call; this bounds their
 * sum, so a book of thousands of sections, each just under the caps, still opens in bounded time.
 *
 * Exhausting it never throws: the section being sanitised stops where the budget ran out, later sections
 * open empty, and both are marked `data-epub-truncated` (epub.css shows a note). Later CSS is dropped.
 * Which text survives depends on these numbers, so they are part of the text model (SANITIZER_VERSION).
 */
export interface BookBudget {
  /** Output nodes (elements + text) left for the whole book. */
  nodes: number;
  /** CSS rules left to examine. */
  cssRules: number;
  /** CSS characters left to parse (sheets and their imports). */
  cssChars: number;
}

export const BOOK_BUDGET: Readonly<BookBudget> = {
  nodes: 2_000_000,
  cssRules: 200_000,
  cssChars: 16 * 1024 * 1024,
};

/** A fresh budget for one book (it is spent as the book opens). */
export const bookBudget = (): BookBudget => ({ ...BOOK_BUDGET });
