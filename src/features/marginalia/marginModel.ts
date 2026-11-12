import { thoughtPlace, type ThoughtLabel } from '../../lib/labels';
import { compareLocations, spotOf } from '../../lib/location';
import type { Annotation, Color, Location, Thought } from '../../lib/types';
import type { PageLayout, PageLayoutBox } from '../../renderers/types';

/** A thought the margin can show: it has a place on a page (a pdf page or an epub section). */
export interface MarginEntry {
  thought: Thought;
  /** The highlight's location for an anchored thought, else the thought's own (a pin or a page). */
  location: Location;
  page: number;
  /** The highlight it hangs off; null for a pin or page thought. */
  anchor: Annotation | null;
  /** The highlight's colour; null = blue ink (a pin or page thought). */
  color: Color | null;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The margin's thoughts in reading order (location, then position, then id). General thoughts (no place)
 * and thoughts on an unanchored highlight (its stored spot is known to be wrong) stay in the notebook only.
 */
export function marginEntries(thoughts: readonly Thought[], annotations: readonly Annotation[]): MarginEntry[] {
  const anchors = new Map(annotations.map((a) => [a.id, a]));
  const out: MarginEntry[] = [];
  for (const thought of thoughts) {
    const highlight = thought.anchorId ? (anchors.get(thought.anchorId) ?? null) : null;
    if (highlight?.unanchored) continue;
    const place = thoughtPlace(thought, anchors);
    const spot = place ? spotOf(place.location) : null;
    if (!place || !spot) continue;
    const anchor = place.quote !== null ? highlight : null;
    out.push({ thought, location: place.location, page: spot.page, anchor, color: anchor?.color ?? null });
  }
  return out.sort(
    (a, b) =>
      compareLocations(a.location, b.location) || a.thought.position - b.thought.position || cmp(a.thought.id, b.thought.id),
  );
}

/** Pages this close to the current page keep their notes (and editors) mounted; the renderer keeps them rendered too. */
export const MOUNT_RADIUS = 3;
/** Space between the widest page's right edge and the column. */
export const MARGIN_GAP = 20;
/** The scroller's bottom padding (pdf.css) below the last page. */
const SCROLL_PAD = 24;

/**
 * The pages whose notes are mounted (virtualised by page): every rendered page, the current page ± 3, and
 * the `keep` pages (the focused note's, a requested note's, an open card's) wherever they are.
 */
export function pagesToMount(
  layout: PageLayout | null,
  currentPage: number | null,
  keep: readonly (number | null)[] = [],
): Set<number> {
  const out = new Set<number>();
  if (!layout) return out;
  const count = layout.pages.length;
  for (const p of layout.pages) if (p.ready) out.add(p.page);
  if (currentPage !== null) {
    for (let p = Math.max(1, currentPage - MOUNT_RADIUS); p <= Math.min(count, currentPage + MOUNT_RADIUS); p++) out.add(p);
  }
  for (const p of keep) if (p !== null && p >= 1 && p <= count) out.add(p);
  return out;
}

/**
 * The column's left edge: right of the widest page that fits the fit area (`layout.fitRight`), so an
 * oversize plate runs under the column instead of pushing it off screen. Only when page 1 itself overflows
 * the fit area (a large fixed zoom), or the fit area is unknown, does the widest page decide.
 */
export function columnLeft(layout: PageLayout): number {
  const fit = layout.fitRight ?? Infinity;
  const first = layout.pages[0];
  const overflow = first !== undefined && first.left + first.width > fit;
  let right = 0;
  for (const p of layout.pages) {
    const edge = p.left + p.width;
    if (overflow || edge <= fit) right = Math.max(right, edge);
  }
  return right + MARGIN_GAP;
}

/** The last page's bottom: no note may end below it (layoutMargin's maxBottom). */
export function lastPageBottom(layout: PageLayout): number {
  let bottom = 0;
  for (const p of layout.pages) bottom = Math.max(bottom, p.top + p.height);
  return bottom;
}

/** Height of the scroller's content: the last page's bottom plus the scroller's bottom padding. */
export function contentHeight(layout: PageLayout): number {
  return lastPageBottom(layout) + SCROLL_PAD;
}

/** How far into a page, from its right edge, hovering offers the margin "+". */
export const PLUS_STRIP = 48;

/**
 * The page whose margin "+" the pointer at (`x`, `y`) (content coordinates) is in: over that page's
 * right strip or the column beside it (up to `columnRight`); null over the text, past the column or
 * between pages.
 */
export function plusPage(layout: PageLayout, x: number, y: number, columnRight: number): PageLayoutBox | null {
  for (const p of layout.pages) {
    if (y < p.top || y > p.top + p.height) continue;
    const right = p.left + p.width;
    return x >= right - PLUS_STRIP && x <= columnRight ? p : null;
  }
  return null;
}

/** The one line a narrow-window tab shows: the custom name, else the section, else the snippet. */
export function labelLine(label: ThoughtLabel): string {
  if (label.kind === 'custom') return label.text;
  if (label.kind === 'auto') return label.section ?? label.snippet;
  return '';
}
