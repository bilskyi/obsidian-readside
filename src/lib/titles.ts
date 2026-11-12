/** A file name or title made readable: `_` and runs of whitespace become one space, ends trimmed. */
export function displayTitle(basenameOrTitle: string): string {
  return basenameOrTitle.replace(/[_\s]+/g, ' ').trim();
}

/** The file name of a path without its extension ('' for no path). */
export function fileStem(path: string): string {
  const p = path ?? '';
  return p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
}

/**
 * The title to show for a book. A stored title of its own is shown as it is; a title that is just the
 * file name (or none) is shown made readable, so books stored before titles were prettified look right.
 */
export function bookDisplayTitle(book: { title: string | null; path: string }): string {
  return hasOwnTitle(book) ? book.title!.trim() : displayTitle(fileStem(book.path)) || 'Untitled';
}

/** True when the stored title is not just the book's file name (raw or made readable). */
export function hasOwnTitle(book: { title: string | null; path: string }): boolean {
  const title = book.title?.trim();
  if (!title) return false;
  const stem = fileStem(book.path);
  return title !== stem && title !== displayTitle(stem);
}
