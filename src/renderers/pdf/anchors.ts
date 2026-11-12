import type { PdfLocationValue } from '../../lib/types';
import type { AnchorPoint } from '../types';

/** A pin's thread ends this far inside the page's right edge: in the page margin, beside its line. */
export const PIN_INSET = 12;
/** A page-level thought (no line of its own) sits this far below the page top. */
export const PAGE_TOP_INSET = 16;

/** What the renderer measured on a rendered page, relative to the page box (px). */
export interface AnchorMeasure {
  /** A highlight's first line: its top and the right end of its rects on that line. */
  highlight: { top: number; right: number } | null;
  /** A point's text line top; null on a page without text (or for a page-level location). */
  lineTop: number | null;
}

/** A location's last measured place on its page, as fractions of the page box (survives zoom). */
export interface AnchorFraction {
  fy: number;
  fx: number;
}

/** The top of the first rect and the furthest right end among the rects on that same line. */
export function firstLineEnd(
  rects: readonly { top: number; bottom: number; right: number }[],
): { top: number; right: number } | null {
  if (rects.length === 0) return null;
  const first = rects[0];
  const mid = (first.top + first.bottom) / 2;
  let right = first.right;
  for (const r of rects) if (r.top <= mid && r.bottom >= mid) right = Math.max(right, r.right);
  return { top: first.top, right };
}

/**
 * Where a thought's spot is (scroller content coordinates), given its page box and, for a rendered page,
 * what was measured there (`m`). On an unrendered page (`m` null) it is estimated: from the location's
 * last measured place (`cached`), else from `y`, else the page top.
 */
export function anchorFor(
  page: { top: number; left: number; width: number; height: number },
  v: PdfLocationValue,
  m: AnchorMeasure | null,
  cached: AnchorFraction | null = null,
): AnchorPoint {
  const pinX = page.left + page.width - PIN_INSET;
  if (m?.highlight) return { top: page.top + m.highlight.top, x: page.left + m.highlight.right, measured: true };
  if (m && m.lineTop !== null) return { top: page.top + m.lineTop, x: pinX, measured: true };
  if (!m && cached) return { top: page.top + cached.fy * page.height, x: page.left + cached.fx * page.width, measured: false };
  const measured = m !== null;
  if (v.y !== undefined) return { top: page.top + v.y * page.height, x: pinX, measured };
  return { top: page.top + PAGE_TOP_INSET, x: pinX, measured };
}
