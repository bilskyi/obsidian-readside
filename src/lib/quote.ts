/** `> quote` (every line quoted), a blank line, then the link: what "Copy quote with link" puts on the clipboard. */
export function quoteWithLink(quote: string, link: string): string {
  const quoted = quote
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');
  return `${quoted}\n\n${link}`;
}

/**
 * A quote as plain text: every run of whitespace one space, trimmed. An EPUB quote carries the book's
 * source indentation and a line break at each block boundary; on the clipboard those are layout, not text.
 */
export function plainQuote(q: string): string {
  return q.replace(/\s+/g, ' ').trim();
}

/**
 * A stored quote as the notebook and the mirror note show it. An EPUB quote carries the book's source
 * indentation (`"end.\n\t\t\tNext para."`): each line's whitespace runs become one space, trimmed, and blank
 * lines are dropped, so block boundaries stay line breaks. Any other quote (`kind` `pdf`, `text`, unknown)
 * is returned as stored. Display only: the stored quote stays raw, since quote re-anchoring reads it.
 */
export function displayQuote(quote: string, kind: string | null | undefined): string {
  if (kind !== 'epub') return quote;
  return quote
    .split(/\r\n?|\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}
