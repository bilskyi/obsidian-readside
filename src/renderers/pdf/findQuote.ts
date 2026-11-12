import type { PdfLocationValue } from '../../lib/types';

export function normalizeWithMap(s: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      if (!prevSpace) {
        text += ' ';
        map.push(i);
        prevSpace = true;
      }
    } else {
      text += ch;
      map.push(i);
      prevSpace = false;
    }
  }
  return { text, map };
}

export function normalizeText(s: string): string {
  return normalizeWithMap(s).text.trim();
}

export function quoteMatches(pageText: string, start: number, end: number, quote: string): boolean {
  if (start < 0 || end > pageText.length || start >= end) return false;
  return normalizeText(pageText.slice(start, end)) === normalizeText(quote);
}

/** Finds `quote` in one page's text (whitespace-insensitive); offsets refer to the original text. */
export function findQuoteInPage(text: string, quote: string): { start: number; end: number } | null {
  const q = normalizeText(quote);
  if (!q) return null;
  const n = normalizeWithMap(text);
  const i = n.text.indexOf(q);
  if (i < 0) return null;
  return { start: n.map[i], end: n.map[i + q.length - 1] + 1 };
}

/** Page numbers 1..numPages, nearest to `nearPage` first (lower page on ties); document order without a hint. */
export function pageOrder(numPages: number, nearPage?: number): number[] {
  const all = Array.from({ length: Math.max(0, numPages) }, (_, i) => i + 1);
  if (nearPage === undefined || numPages < 1) return all;
  const h = Math.min(numPages, Math.max(1, nearPage));
  return all.sort((a, b) => Math.abs(a - h) - Math.abs(b - h) || a - b);
}

export function findQuoteInPages(
  pages: { page: number; text: string }[],
  quote: string,
  nearPage?: number,
): PdfLocationValue | null {
  const ordered =
    nearPage === undefined
      ? pages
      : [...pages].sort(
          (a, b) => Math.abs(a.page - nearPage) - Math.abs(b.page - nearPage) || a.page - b.page,
        );
  for (const p of ordered) {
    const v = findQuoteInPage(p.text, quote);
    if (v) return { page: p.page, ...v };
  }
  return null;
}
