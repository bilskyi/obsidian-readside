// The word under a point in the page text (spec §A5, ⌥-hover): the caret at the point
// (caretPositionFromPoint, else caretRangeFromPoint), then the word around it (Intl.Segmenter, word
// granularity, word-like segments only). DOM-only, so it works on any renderer whose page text is
// real text nodes: the PDF text layer now, EPUB later through the same seam.

export interface WordHit {
  word: string;
  rect: DOMRect;
  node: Text;
  start: number;
  end: number;
}

type SegmenterLike = { segment(text: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }> };
const segmenters = new Map<string, SegmenterLike | null>();
function segmenter(lang?: string): SegmenterLike | null {
  const key = lang ?? '';
  if (!segmenters.has(key)) {
    const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: 'word' }) => SegmenterLike }).Segmenter;
    let s: SegmenterLike | null = null;
    try {
      s = Seg ? new Seg(lang || undefined, { granularity: 'word' }) : null;
    } catch {
      s = Seg ? new Seg(undefined, { granularity: 'word' }) : null;
    }
    segmenters.set(key, s);
  }
  return segmenters.get(key) ?? null;
}

/** Letters, marks and digits, with an apostrophe inside a word (п'ять, don't). */
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
const INNER = /['’ʼ]/u;

/** The word-like segment of `text` that contains `offset`; null on punctuation, space or past the end. */
export function wordBounds(text: string, offset: number, lang?: string): { start: number; end: number } | null {
  if (offset < 0 || offset >= text.length) return null;
  const seg = segmenter(lang);
  if (seg) {
    for (const s of seg.segment(text)) {
      if (offset >= s.index && offset < s.index + s.segment.length) {
        return s.isWordLike ? { start: s.index, end: s.index + s.segment.length } : null;
      }
      if (s.index > offset) break;
    }
    return null;
  }
  // No Segmenter: letters and digits, joined by an inner apostrophe.
  const isWord = (i: number) =>
    i >= 0 && i < text.length && (WORD_CHAR.test(text[i]) || (INNER.test(text[i]) && WORD_CHAR.test(text[i - 1] ?? '') && WORD_CHAR.test(text[i + 1] ?? '')));
  if (!WORD_CHAR.test(text[offset])) return null;
  let start = offset;
  let end = offset + 1;
  while (isWord(start - 1)) start--;
  while (isWord(end)) end++;
  return { start, end };
}

function caretAt(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const d = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof d.caretPositionFromPoint === 'function') {
    const p = d.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  if (typeof d.caretRangeFromPoint === 'function') {
    const r = d.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  return null;
}

function rectOf(node: Text, start: number, end: number): DOMRect {
  const doc = node.ownerDocument;
  const range = doc.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const r = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
  return r ?? node.parentElement?.getBoundingClientRect() ?? new DOMRect();
}

const contains = (r: DOMRect, x: number, y: number) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1;

/**
 * The word at (x, y) inside `within`, or null (no text there, outside `within`, not a word). A caret
 * between characters may sit just after the word under the pointer, so the character before it is tried
 * too; when the word's box can be measured, the point must be inside it (no word for the empty space to
 * the right of a line, where the caret snaps to the line's end).
 */
export function wordAt(doc: Document, x: number, y: number, within: Element, lang?: string): WordHit | null {
  const caret = caretAt(doc, x, y);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE || !within.contains(caret.node)) return null;
  const node = caret.node as Text;
  const text = node.data;
  let fallback: WordHit | null = null;
  for (const o of [caret.offset, caret.offset - 1]) {
    const b = wordBounds(text, o, lang);
    if (!b) continue;
    const rect = rectOf(node, b.start, b.end);
    const hit = { word: text.slice(b.start, b.end), rect, node, start: b.start, end: b.end };
    if (rect.width > 0 && rect.height > 0) {
      if (contains(rect, x, y)) return hit;
    } else {
      fallback ??= hit; // unmeasurable (no layout): trust the caret
    }
  }
  return fallback;
}
