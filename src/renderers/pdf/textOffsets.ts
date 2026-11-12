/**
 * Character offsets into a pdf.js text layer.
 *
 * The page text is the concatenation of all Text nodes in document order, with every <br> (which pdf.js
 * emits after an item with `hasEOL`) counted as one virtual "\n". `joinTextItems` produces the identical
 * string from `getTextContent()` items, so offsets are interchangeable between rendered and unrendered pages.
 */

export type Segment =
  | { node: Text; br: false; start: number; length: number }
  | { node: HTMLBRElement; br: true; start: number; length: 1 };

export interface TextIndex {
  segments: Segment[];
  text: string;
}

export function indexText(container: Node): TextIndex {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) =>
      n.nodeType === Node.TEXT_NODE || n.nodeName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  });
  const segments: Segment[] = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = n as Text;
      segments.push({ node: t, br: false, start: text.length, length: t.data.length });
      text += t.data;
    } else {
      segments.push({ node: n as HTMLBRElement, br: true, start: text.length, length: 1 });
      text += '\n';
    }
  }
  return { segments, text };
}

/** Same string as `indexText` of the DOM pdf.js TextLayer builds from these items. */
export function joinTextItems(items: ReadonlyArray<{ str: string; hasEOL?: boolean } | { type: string }>): string {
  let s = '';
  for (const i of items) {
    if (!('str' in i) || typeof i.str !== 'string') continue;
    s += i.str;
    if (i.hasEOL) s += '\n';
  }
  return s;
}

function offsetIn(idx: TextIndex, node: Node, offset: number): number | null {
  const point = document.createRange();
  try {
    point.setStart(node, offset);
  } catch {
    return null; // offset out of bounds
  }
  let sum = 0;
  for (const seg of idx.segments) {
    if (!seg.br && seg.node === node) return seg.start + offset;
    // Segments are leaves: each lies entirely before or after the point (a point "inside" a BR is before it).
    if (point.comparePoint(seg.node, 0) >= 0) break;
    sum = seg.start + seg.length;
  }
  return sum;
}

export function pointToOffset(container: Node, node: Node, offset: number): number | null {
  if (node !== container && !container.contains(node)) return null;
  return offsetIn(indexText(container), node, offset);
}

export function offsetsToRange(container: Node, start: number, end: number): Range | null {
  const idx = indexText(container);
  if (start < 0 || end > idx.text.length || start >= end) return null;
  const s = idx.segments.find((g) => start >= g.start && start < g.start + g.length);
  const e = idx.segments.find((g) => end > g.start && end <= g.start + g.length);
  if (!s || !e) return null;
  const r = document.createRange();
  if (s.br) r.setStartBefore(s.node);
  else r.setStart(s.node, start - s.start);
  if (e.br) r.setEndAfter(e.node);
  else r.setEnd(e.node, end - e.start);
  return r;
}

export function rangeToPageOffsets(
  range: Range,
  pages: { page: number; el: HTMLElement }[],
): { page: number; start: number; end: number; quote: string } | null {
  const startPage = pages.find((p) => p.el.contains(range.startContainer));
  if (!startPage) return null;
  const idx = indexText(startPage.el);
  const start = offsetIn(idx, range.startContainer, range.startOffset);
  const end = startPage.el.contains(range.endContainer)
    ? offsetIn(idx, range.endContainer, range.endOffset)
    : idx.text.length;
  if (start === null || end === null || start >= end) return null;
  const quote = idx.text.slice(start, end);
  if (!quote.trim()) return null;
  return { page: startPage.page, start, end, quote };
}
