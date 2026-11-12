import type { SearchBatch, SearchHit } from '../types';
import { normalizeWithMap } from './findQuote';

/** Characters of context on each side of a hit in its snippet. */
const CONTEXT = 40;
/** Pages scanned between yields to the event loop: cached pages resolve in microtasks, which would otherwise starve input. */
export const SEARCH_YIELD_EVERY = 16;

/** Whitespace collapsed and lower-cased, with `map[i]` = index in `s` of output char i. */
export function foldWithMap(s: string): { text: string; map: number[] } {
  const n = normalizeWithMap(s);
  let text = '';
  for (let i = 0; i < n.text.length; i++) {
    const lc = n.text[i].toLowerCase();
    // Keep a 1:1 map: a char whose lower case is longer (e.g. 'İ') stays as it is.
    text += lc.length === 1 ? lc : n.text[i];
  }
  return { text, map: n.map };
}

const squash = (s: string) => s.replace(/\s+/g, ' ');

export function snippetAround(text: string, start: number, end: number): SearchHit['snippet'] {
  const from = Math.max(0, start - CONTEXT);
  const to = Math.min(text.length, end + CONTEXT);
  return {
    before: (from > 0 ? '…' : '') + squash(text.slice(from, start)).trimStart(),
    match: squash(text.slice(start, end)),
    after: squash(text.slice(end, to)).trimEnd() + (to < text.length ? '…' : ''),
  };
}

/** Every non-overlapping occurrence of `query` on one page, ignoring case and whitespace differences. */
export function findAllInPage(text: string, query: string, page: number): SearchHit[] {
  const q = foldWithMap(query).text.trim();
  if (!q) return [];
  const t = foldWithMap(text);
  const hits: SearchHit[] = [];
  for (let i = t.text.indexOf(q); i >= 0; i = t.text.indexOf(q, i + q.length)) {
    const start = t.map[i];
    const end = t.map[i + q.length - 1] + 1;
    hits.push({ page, start, end, snippet: snippetAround(text, start, end) });
  }
  return hits;
}

/** Pages 1..numPages starting at `from` and wrapping around: the reader's own position first. */
export function wrapOrder(numPages: number, from = 1): number[] {
  if (numPages < 1) return [];
  const f = Math.min(numPages, Math.max(1, Math.floor(from)));
  return Array.from({ length: numPages }, (_, i) => ((f - 1 + i) % numPages) + 1);
}

/**
 * One batch per page of `order`. `getText` resolves a page's text; null ends the search (the renderer
 * closed); a rejection reports the page as having no text. Every SEARCH_YIELD_EVERY pages it yields to
 * the event loop (input, abort). Stops quietly once `signal` aborts, so an abandoned run never yields again.
 */
export async function* searchPages(
  order: readonly number[],
  getText: (page: number) => Promise<string | null>,
  query: string,
  signal?: AbortSignal,
): AsyncGenerator<SearchBatch> {
  let scanned = 0;
  for (const page of order) {
    if (signal?.aborted) return;
    if (++scanned % SEARCH_YIELD_EVERY === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted) return;
    }
    let text: string | null;
    try {
      text = await getText(page);
    } catch {
      text = '';
    }
    if (text === null || signal?.aborted) return;
    yield { page, hits: findAllInPage(text, query, page), noText: !text.trim() };
  }
}
