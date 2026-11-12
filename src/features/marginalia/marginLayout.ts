import { FIT_GUTTER } from '../../renderers/pdf/layout';

/**
 * Margin column geometry (M4 spec §5.2), pure: no DOM. Positions are CSS px in the PDF scroller's
 * content coordinates (the space of PageLayoutBox), where the renderer's margin layer lives.
 */

/**
 * 'dots' is focus mode's: it turns a showing margin ('full' or 'tabs') into dots, and marginModeFor with
 * `{ dots: true }` gives dots to a column too narrow for tabs that still has room for them.
 */
export type MarginMode = 'off' | 'tabs' | 'full' | 'dots';

/**
 * A reading column narrower than this never shows notes, whatever page 1's width (the window minimum is
 * 800); wider ones need page room for page 1 at FULL_MIN_SCALE too (marginModeFor).
 */
export const NARROW_BELOW = 820;
/**
 * "Readable page first": notes ('full') only when a fit leaves page 1 at least this scale. Below it the
 * margin shows tabs, which cost far less room, so the page stays a normal reading size.
 */
export const FULL_MIN_SCALE = 0.9;
/** Tabs (and focus mode's dots, the other compact form) only when a fit leaves page 1 at least this scale. */
export const TABS_MIN_SCALE = 0.75;
/** The zoom floor (50 %): the least scale a fit ever gives page 1 ('off' has no other floor). */
export const MIN_PAGE_SCALE = 0.5;
/**
 * The page width marginModeFor assumes while page 1's is unknown: US Letter (612 pt). The renderer reports
 * the real width before its first fit (open's onPageSize), so only an unusual page size can switch modes.
 */
export const ASSUMED_PAGE_WIDTH = 612;
/** A margin note's width (spec: ~240, min 200). */
export const MARGIN_WIDTH = 240;
/** A narrow-window tab's width. */
export const TAB_WIDTH = 120;
/** Focus mode: a dot's box (the button you hover, focus or click: 24 px, WCAG 2.5.8); the dot itself is 8 px. */
export const DOT_WIDTH = 24;
/** Room kept right of the column, beyond its own width. */
export const MARGIN_RIGHT_ROOM = 16;
const MARGIN_RESERVE_FULL = MARGIN_WIDTH + MARGIN_RIGHT_ROOM;
const MARGIN_RESERVE_TABS = TAB_WIDTH + MARGIN_RIGHT_ROOM;
/** Space between two stacked notes. */
export const NOTE_GAP = 8;

/** The vertical scrollbar's width: the reading column's usable width is this much less than it measures. */
const SCROLLBAR_GUTTER = 15;

/**
 * Page room a mode leaves: fit zooms fit page 1 into the reading column less the mode's reserve on both
 * sides (the page is centred, the empty left gutter mirrors the column on the right; fitArea), the fit
 * gutters and the vertical scrollbar.
 */
export function pageRoom(columnWidth: number, mode: MarginMode): number {
  return columnWidth - 2 * marginReserve(mode) - FIT_GUTTER - SCROLLBAR_GUTTER;
}

/** The least scale a fit must leave page 1 at for each mode to be picked. */
export function modeMinScale(mode: MarginMode): number {
  if (mode === 'full') return FULL_MIN_SCALE;
  if (mode === 'tabs' || mode === 'dots') return TABS_MIN_SCALE;
  return MIN_PAGE_SCALE;
}

/**
 * What the margin shows in a reading column `columnWidth` px wide, readable page first: 'off' until it is
 * measured. Notes ('full') need a column of at least NARROW_BELOW and page room (pageRoom) for page 1
 * (`pageWidth` at scale 1) at FULL_MIN_SCALE; otherwise tabs, when they leave it at TABS_MIN_SCALE;
 * otherwise 'off' (the notebook is the only surface). Focus mode (`dots`) gives dots to a column too
 * narrow for tabs when dots leave page 1 at TABS_MIN_SCALE. While page 1's width is unknown it is taken
 * to be ASSUMED_PAGE_WIDTH.
 *
 * The page room is pageRoom's: the fit centres the page with the reserve mirrored on its left, so the
 * reserve counts twice. Reads only the column's width and page 1's width at scale 1, neither of which
 * the mode changes, so it cannot oscillate.
 */
export function marginModeFor(
  columnWidth: number,
  pageWidth: number | null = null,
  opts: { dots?: boolean } = {},
): MarginMode {
  if (!(columnWidth > 0)) return 'off';
  const width = pageWidth !== null && pageWidth > 0 ? pageWidth : ASSUMED_PAGE_WIDTH;
  const fits = (mode: MarginMode) => pageRoom(columnWidth, mode) >= width * modeMinScale(mode);
  if (columnWidth >= NARROW_BELOW && fits('full')) return 'full';
  if (fits('tabs')) return 'tabs';
  // Focus mode (`dots`): a column too narrow for tabs may still have room for dots by the same rule.
  return opts.dots && fits('dots') ? 'dots' : 'off';
}

/** The room (px) the renderer keeps free right of the pages; fit zooms fit the pages into the rest. */
export function marginReserve(mode: MarginMode): number {
  if (mode === 'full') return MARGIN_RESERVE_FULL;
  if (mode === 'tabs') return MARGIN_RESERVE_TABS;
  if (mode === 'dots') return DOT_WIDTH + MARGIN_RIGHT_ROOM;
  return 0;
}

export interface MarginBox {
  id: string;
  /** Top of the note's line: where it wants to sit. */
  anchor: number;
  height: number;
}

/**
 * The top of every note (spec §5.2). In anchor order (ties keep the input order) each note sits at its
 * anchor unless that overlaps the note above (plus `gap`); then it is pushed down. With `focusedId`, that
 * note sits exactly at its anchor, the notes after it are pushed down from it and the notes before it are
 * pushed up (Google Docs style). When the notes above can't fit between `minTop` and the focused note, the
 * column flows down from `minTop` as if nothing were focused, so no note is ever placed above the content.
 * Finally, notes that would end below `maxBottom` (the last page's bottom) stack upward from it, so the
 * column never makes the scroller taller than its pages — unless they don't all fit between `minTop` and
 * `maxBottom`: then the column flows down from `minTop` and may run past the last page, since a note above
 * `minTop` could never be reached.
 */
export function layoutMargin(
  boxes: readonly MarginBox[],
  focusedId: string | null = null,
  gap = NOTE_GAP,
  minTop = 0,
  maxBottom = Infinity,
): Map<string, number> {
  const order = boxes
    .map((b, i) => ({ b, i }))
    .sort((x, y) => x.b.anchor - y.b.anchor || x.i - y.i)
    .map((x) => x.b);
  const tops: number[] = new Array(order.length);
  const flowDown = (from: number, floor: number) => {
    let next = floor;
    for (let i = from; i < order.length; i++) {
      tops[i] = Math.max(order[i].anchor, next);
      next = tops[i] + order[i].height + gap;
    }
  };
  const f = focusedId === null ? -1 : order.findIndex((b) => b.id === focusedId);
  if (f < 0) {
    flowDown(0, minTop);
  } else {
    tops[f] = Math.max(order[f].anchor, minTop);
    flowDown(f + 1, tops[f] + order[f].height + gap);
    let ceiling = tops[f];
    for (let i = f - 1; i >= 0; i--) {
      tops[i] = Math.min(order[i].anchor, ceiling - gap - order[i].height);
      ceiling = tops[i];
    }
    if (f > 0 && tops[0] < minTop) flowDown(0, minTop);
  }
  let floor = maxBottom;
  for (let i = order.length - 1; i >= 0 && tops[i] + order[i].height > floor; i--) {
    tops[i] = floor - order[i].height;
    floor = tops[i] - gap;
  }
  // More notes than fit between minTop and maxBottom: flow down from minTop again. Running past the
  // last page is better than a note above the content, where it can't be reached.
  if (order.length > 0 && tops[0] < minTop) flowDown(0, minTop);
  return new Map(order.map((b, i) => [b.id, tops[i]]));
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * A thread from a note's left edge (`from`) to its spot (`to`): a soft S-curve, leaving and arriving level.
 * The bow grows with the horizontal gap and, up to 60 px, with the vertical one: a note pushed far from its
 * spot gets a smooth curve instead of a near-vertical kink.
 */
export function threadPath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const dx = Math.max(12, Math.abs(from.x - to.x) * 0.45, Math.min(Math.abs(from.y - to.y) * 0.25, 60));
  return `M${r1(from.x)} ${r1(from.y)} C${r1(from.x - dx)} ${r1(from.y)} ${r1(to.x + dx)} ${r1(to.y)} ${r1(to.x)} ${r1(to.y)}`;
}
