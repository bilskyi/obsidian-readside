import type { Zoom } from '../types';

/** Horizontal room left around a fitted page (24px each side). */
export const FIT_GUTTER = 48;
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;

/** Pages further than this from the current page release their rendered content when they leave the observer margin. */
export const KEEP_RENDERED_RADIUS = 3;

/** How often a scroll updates the current page (and so the toolbar's page number and progress). */
export const SCROLL_PAGE_MS = 120;

/** Settle delay after the last scroller resize before re-fitting (the notebook drag fires many). */
export const RESIZE_SETTLE_MS = 120;

/** Height of the flash band for a point location on a page without text. */
export const POINT_BAND_PX = 18;

/** The reading line: a third of the way down the viewport (`clientHeight / 3`, as the page probe reads it). */
export const readingLineY = (clientHeight: number): number => clientHeight / 3;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Fit-to-width scale for a page of `pageWidth` (at scale 1) in a container `containerWidth` wide. */
export function fitScale(containerWidth: number, pageWidth: number): number {
  if (!(pageWidth > 0)) return 1;
  return clamp((containerWidth - FIT_GUTTER) / pageWidth, MIN_SCALE, MAX_SCALE);
}

/**
 * The box fit zooms fit pages into: the scroller minus the margin column's reserve on both sides (never
 * negative). The fitted page is then exactly centred (pageLane): the column sits in the right gutter and
 * an equal empty gutter mirrors it on the left, so the page itself, not page plus column, is centred.
 */
export function fitArea(clientWidth: number, clientHeight: number, reserve: number): { width: number; height: number } {
  return { width: Math.max(0, clientWidth - 2 * Math.max(0, reserve)), height: clientHeight };
}

/**
 * Where the page lane sits across the scroller (content coordinates). The lane is page 1's width at the
 * current scale (the width fit zooms fit); `reserve` is the margin column's room right of it.
 *
 * - Wide (clientWidth ≥ lane + 2 × reserve + FIT_GUTTER): the lane is exactly centred; the column sits
 *   in the right gutter and the left gutter is the same empty width. A fit zoom (fitArea: lane =
 *   clientWidth − 2 × reserve − FIT_GUTTER) lands exactly on this threshold, so a fitted page is centred.
 * - Narrower (a fixed zoom, or a fit clamped at the zoom floor): the lane moves left just enough to keep
 *   reserve + half a gutter on its right; it slides continuously from the centre, with no jump at the
 *   threshold.
 * - Wider than the scroller (zoomed): the lane starts half a gutter in and `extent` (the scroll width) runs
 *   half a gutter past the reserve, so both sides scroll into view and nothing is cut off on the left.
 *
 * `left` is never below half a gutter. The reserve decides placement only, never the margin mode.
 */
export function pageLane(clientWidth: number, laneWidth: number, reserve: number): { left: number; extent: number } {
  const half = FIT_GUTTER / 2;
  const r = Math.max(0, reserve);
  const centred = (clientWidth - laneWidth) / 2;
  const roomy = clientWidth - laneWidth - r - half;
  const left = Math.max(half, Math.min(centred, roomy));
  // Floored: at a fit zoom the sum is clientWidth give or take a float's last bit, and a sub-pixel
  // overflow must not bring in a horizontal scrollbar.
  return { left, extent: Math.max(clientWidth, Math.floor(left + laneWidth + r + half)) };
}

/**
 * A page's left edge in a lane at `laneLeft`, `laneWidth` wide: centred on the lane, except that a page
 * wider than the lane (an oversize plate) never starts left of half a gutter (it runs right, under the
 * column, instead of off the left edge where it could not be scrolled to).
 */
export function pageLeft(laneLeft: number, laneWidth: number, pageWidth: number): number {
  return Math.max(FIT_GUTTER / 2, laneLeft + (laneWidth - pageWidth) / 2);
}

export interface PageBox {
  top: number;
  height: number;
}

/**
 * A scroll position relative to a page: `fraction` of the page's height (scales with the page) plus a
 * fixed-pixel `offset` for padding and gaps, which do not scale.
 */
export interface ScrollPosition {
  index: number;
  fraction: number;
  offset: number;
}

/** Where `scrollTop` sits relative to the pages (sorted by top). */
export function capturePosition(pages: PageBox[], scrollTop: number): ScrollPosition {
  if (pages.length === 0) return { index: 0, fraction: 0, offset: 0 };
  let index = pages.findIndex((p) => p.top + p.height > scrollTop);
  if (index === -1) {
    index = pages.length - 1;
    const p = pages[index];
    return { index, fraction: 1, offset: scrollTop - (p.top + p.height) };
  }
  const p = pages[index];
  if (scrollTop < p.top) return { index, fraction: 0, offset: scrollTop - p.top };
  return { index, fraction: p.height > 0 ? (scrollTop - p.top) / p.height : 0, offset: 0 };
}

/** The scrollTop that puts `pos` at the same place in a re-laid-out page list. */
export function restoreScrollTop(pos: ScrollPosition, pages: PageBox[]): number {
  if (pages.length === 0) return 0;
  const p = pages[Math.min(pos.index, pages.length - 1)];
  return Math.max(0, p.top + pos.fraction * p.height + pos.offset);
}

/** A width change the renderer applied: from one fitted width to another, at a timestamp (ms). */
export interface WidthChange {
  from: number;
  to: number;
  at: number;
}

/**
 * True when going from `fitWidth` to `width` at time `at` exactly undoes `prev` within `windowMs`:
 * the signature of a re-fit toggling a classic vertical scrollbar, which would otherwise loop.
 */
export function isReversal(
  prev: WidthChange | null,
  fitWidth: number,
  width: number,
  at: number,
  windowMs: number,
): boolean {
  return !!prev && prev.to === fitWidth && prev.from === width && at - prev.at < windowMs;
}

/** capturePosition for a reference line `anchorY` px below the scroller's top (the reading line, or the pinch point). */
export function captureAt(pages: PageBox[], scrollTop: number, anchorY: number): ScrollPosition {
  return capturePosition(pages, scrollTop + anchorY);
}

/** The scrollTop that puts the line captured by captureAt back `anchorY` px below the scroller's top. */
export function restoreAt(pos: ScrollPosition, pages: PageBox[], anchorY: number): number {
  return Math.max(0, restoreScrollTop(pos, pages) - anchorY);
}

/**
 * Index of the page under the reading line (a third down the viewport), or -1 without pages. Once a
 * scrollable book is at its very bottom it is the last page, even if that page is shorter than the
 * viewport and the reading line still sits on the one before.
 */
export function readingPageIndex(pages: PageBox[], scrollTop: number, clientHeight: number, scrollHeight: number): number {
  if (pages.length === 0) return -1;
  if (scrollHeight > clientHeight + 2 && scrollTop + clientHeight >= scrollHeight - 2) return pages.length - 1;
  const probe = scrollTop + clientHeight / 3;
  const i = pages.findIndex((p) => p.top + p.height > probe);
  return i === -1 ? pages.length - 1 : i;
}

/** A page's horizontal box in the scroller's content coordinates (offsetLeft, offsetWidth). */
export interface PageSpan {
  left: number;
  width: number;
}

/**
 * Where a point `anchorX` px right of the scroller's left edge sits across `page`, as a fraction of
 * the page's width (clamped to the page: a pointer beside it holds on to its nearest edge). Measured
 * against the page, not the scroll width, so a centred page zooming into an overflowing one keeps
 * the point under the pointer.
 */
export function captureX(page: PageSpan, scrollLeft: number, anchorX: number): number {
  if (!(page.width > 0)) return 0.5;
  return clamp((scrollLeft + anchorX - page.left) / page.width, 0, 1);
}

/** The scrollLeft that puts fraction `fx` of the re-laid-out `page` back `anchorX` px from the left edge. */
export function restoreX(fx: number, page: PageSpan, anchorX: number): number {
  return Math.max(0, page.left + fx * page.width - anchorX);
}

export interface RefitInput {
  /** The scroller's size now. */
  width: number;
  height: number;
  /** The size the current scale was fitted to. */
  fitWidth: number;
  fitHeight: number;
  zoom: Zoom;
  /** The current scale, and the one the zoom mode asks for at `width` × `height`. */
  scale: number;
  target: number;
  lastChange: WidthChange | null;
  /** When the resize burst started, now, and the reversal window (all ms). */
  resizedAt: number;
  now: number;
  windowMs: number;
}

/** What a scroller resize should do: nothing; re-emit the page layout (pages moved sideways); or re-lay out at `scale`. */
export type RefitDecision =
  | { action: 'keep' }
  | { action: 'layout'; fitWidth: number; fitHeight: number; lastChange: WidthChange | null }
  | { action: 'rescale'; scale: number; fitWidth: number; fitHeight: number; lastChange: WidthChange | null };

export function decideRefit(i: RefitInput): RefitDecision {
  // Hidden (0 wide or high) or a sub-pixel jitter: keep the current layout.
  if (i.width <= 0 || i.height <= 0) return { action: 'keep' };
  const widthChanged = Math.abs(i.width - i.fitWidth) > 1;
  const heightMatters = i.zoom === 'fit-page' && Math.abs(i.height - i.fitHeight) > 1;
  if (!widthChanged && !heightMatters) return { action: 'keep' };
  // The resize that our own last refit caused, exactly undoing it (a classic scrollbar toggling):
  // keep the layout rather than loop. scrollbar-gutter in pdf.css normally prevents this already.
  if (widthChanged && isReversal(i.lastChange, i.fitWidth, i.width, i.resizedAt, i.windowMs)) return { action: 'keep' };
  const record = {
    fitWidth: i.width,
    fitHeight: i.height,
    lastChange: widthChanged ? { from: i.fitWidth, to: i.width, at: i.now } : i.lastChange,
  };
  // A fixed percentage keeps its scale, and a fit mode may land on the same (clamped) one: centred
  // pages still moved sideways, so the layout is re-emitted.
  if (typeof i.zoom === 'number' || i.target === i.scale) return { action: 'layout', ...record };
  return { action: 'rescale', scale: i.target, ...record };
}
