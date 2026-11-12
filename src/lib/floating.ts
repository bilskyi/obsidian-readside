/**
 * Placement for the reader's floating UI (the selection popover, the page menu, the zoom menu), pure but
 * for floatBounds. In Obsidian the reader is one pane among others and its root clips what overflows it,
 * so a floating thing must stay inside the reader's own box, not merely inside the window.
 */

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Room kept between a floating thing and the edge of its bounds. */
export const FLOAT_INSET = 8;

/**
 * Where a span `size` long starting at `start` may sit inside [lo, hi] with `inset` kept each side. Too long
 * to fit: it starts at the low edge (its beginning, where the first controls are, stays visible).
 */
export function clampSpan(start: number, size: number, lo: number, hi: number, inset = FLOAT_INSET): number {
  const min = lo + inset;
  const max = hi - inset - size;
  return Math.max(min, Math.min(start, max));
}

/** The intersection of two boxes (empty boxes keep right ≥ left and bottom ≥ top). */
export function intersect(a: Bounds, b: Bounds): Bounds {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  return { left, top, right: Math.max(left, Math.min(a.right, b.right)), bottom: Math.max(top, Math.min(a.bottom, b.bottom)) };
}

/**
 * The box `el`'s floating UI must stay in (viewport coordinates): the reader root's rect (`.reader`, else
 * Obsidian's `.margin-app`) intersected with the element's window. Without a root, or with one not laid
 * out (0 wide or high), that window.
 */
export function floatBounds(el: Element | null): Bounds {
  // The window the element lives in: an Obsidian popout window is not the main `window`.
  const view = el?.ownerDocument?.defaultView ?? window;
  const win: Bounds = { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight };
  const root = el?.closest('.reader') ?? el?.closest('.margin-app') ?? null;
  if (!root) return win;
  const r = root.getBoundingClientRect();
  if (!(r.width > 0) || !(r.height > 0)) return win;
  return intersect({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, win);
}

/**
 * A popover over an anchor box (a selection): centred above it, `gap` px off; below it instead when it
 * would not fit above inside `bounds`; shifted sideways (and, as a last resort, up or down) to stay inside.
 */
export function placeOver(
  anchor: { top: number; bottom: number; left: number; width: number },
  size: { width: number; height: number },
  bounds: Bounds,
  gap: number,
  inset = FLOAT_INSET,
): { top: number; left: number; below: boolean } {
  const above = anchor.top - gap - size.height;
  const below = above < bounds.top + inset;
  const top = clampSpan(below ? anchor.bottom + gap : above, size.height, bounds.top, bounds.bottom, inset);
  const left = clampSpan(anchor.left + anchor.width / 2 - size.width / 2, size.width, bounds.left, bounds.right, inset);
  return { top, left, below };
}

/** A menu at a point (a right-click): its top left at the point, moved just enough to stay inside `bounds`. */
export function placeAt(
  x: number,
  y: number,
  size: { width: number; height: number },
  bounds: Bounds,
  inset = FLOAT_INSET,
): { top: number; left: number } {
  return {
    top: clampSpan(y, size.height, bounds.top, bounds.bottom, inset),
    left: clampSpan(x, size.width, bounds.left, bounds.right, inset),
  };
}

/** How far a box laid out at [left, left + width] must move sideways to sit inside `bounds` (0 if it does). */
export function shiftInto(left: number, width: number, bounds: Bounds, inset = FLOAT_INSET): number {
  return clampSpan(left, width, bounds.left, bounds.right, inset) - left;
}

/**
 * Where `left: 0; top: 0` of a `position: fixed` child of `el`'s parent lands, in viewport coordinates.
 * Normally the viewport's own corner (0, 0); but an ancestor with `contain: strict|paint|layout`, a
 * transform or a filter becomes the containing block of fixed descendants — Obsidian's `.workspace-leaf`
 * is `contain: strict` — so there a fixed box is placed relative to the leaf, not the window. Found with a
 * hidden zero-size fixed probe, appended next to `el` and removed at once. Subtract it from a viewport
 * position before writing it as a fixed box's `left`/`top`.
 */
export function fixedOrigin(el: Element | null): { x: number; y: number } {
  const parent = el?.parentElement;
  if (!parent) return { x: 0, y: 0 };
  const probe = parent.ownerDocument.createElement('div');
  probe.className = 'fixed-origin-probe';
  probe.setAttribute('aria-hidden', 'true');
  parent.appendChild(probe);
  try {
    const r = probe.getBoundingClientRect();
    return { x: Number.isFinite(r.left) ? r.left : 0, y: Number.isFinite(r.top) ? r.top : 0 };
  } finally {
    probe.remove();
  }
}
