import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { spotOf } from '../../lib/location';
import type { Location } from '../../lib/types';
import type { PageLayout } from '../../renderers/types';
import { plusPage } from './marginModel';

export const PLUS_SIZE = 22;
/** The "Add thought" label shows beside the "+" only where the column has this much room for it. */
export const PLUS_LABEL_ROOM = 96;
/** A press that moves farther than this before its click is a drag (a selection), not a click. */
const CLICK_SLOP = 4;
/** Over these the "+" hides and a click is theirs, not an empty margin's. */
const MARGIN_PARTS =
  '.margin-note, .margin-tab, .margin-dot, .margin-hint, .margin-backlink, .margin-backlink-pop, .margin-add-here';

interface Spot {
  x: number;
  y: number;
  /** The page's right edge: the guide line runs from here across the column. */
  pageRight: number;
  location: Location;
}

export interface MarginPlusProps {
  /** The page scroller (the margin layer's parent): it receives the pointer events. */
  scroller: HTMLElement | null;
  layout: PageLayout;
  /** The column's right edge: hovering anywhere from a page's right strip to here offers the "+". */
  columnRight: number;
  pointAt: (clientY: number, page: number) => Location | null;
  onAdd: (location: Location) => void;
}

const sameSpot = (a: Spot | null, b: Spot | null) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y);

/**
 * The margin "+" (spec §5.2): hovering a page's right strip or the margin column shows a "+" on the
 * nearest text line, snapping from line to line as the pointer moves, with a quiet guide line across the
 * column at that line and, where there is room, the label "Add thought"; clicking adds a pin there. It
 * never takes focus or the text selection (mousedown is cancelled) and hides while a mouse button is held
 * (a selection being dragged), over a note, and on pages that aren't rendered (their lines are unknown).
 *
 * A click on empty margin (past the page's right edge, not on a note, tab, dot, marker or hint) adds a pin
 * at the nearest line too: the whole column is the target, not only the "+". A press that started a drag,
 * or that came while text was selected, focus was in a thought (its note, card or notebook entry) or a
 * card was open, adds nothing: it only clicks those away.
 */
export function MarginPlus({ scroller, layout, columnRight, pointAt, onAdd }: MarginPlusProps) {
  const [spot, setSpot] = useState<Spot | null>(null);
  const latest = useRef({ layout, columnRight, pointAt, onAdd });
  useLayoutEffect(() => {
    latest.current = { layout, columnRight, pointAt, onAdd };
  });

  // A zoom or re-fit moves the lines: the spot is stale. Only geometry counts — the renderer re-emits
  // the layout as pages render while scrolling, and those emissions must not make the "+" flicker.
  const geometry = [
    layout.scale,
    layout.fitRight ?? '',
    ...layout.pages.map((p) => `${p.page}:${p.top},${p.left},${p.width},${p.height}`),
  ].join('|');
  useEffect(() => setSpot(null), [geometry]);

  useEffect(() => {
    if (!scroller) return;
    const show = (next: Spot | null) => setSpot((cur) => (sameSpot(cur, next) ? cur : next));
    const onMove = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest('.margin-plus')) return; // on the "+" itself: keep it where it is
      if (e.buttons !== 0 || t?.closest(MARGIN_PARTS)) return show(null);
      const { layout: l, columnRight: right, pointAt: at } = latest.current;
      const box = scroller.getBoundingClientRect();
      const x = e.clientX - box.left + scroller.scrollLeft;
      const y = e.clientY - box.top + scroller.scrollTop;
      const page = plusPage(l, x, y, right);
      const location = page ? at(e.clientY, page.page) : null;
      const point = location ? spotOf(location) : null;
      if (!page || !location || !point) return show(null);
      const lineTop = page.top + (point.y ?? 0) * page.height;
      const pageRight = page.left + page.width;
      show({ x: pageRight - PLUS_SIZE / 2, y: lineTop - 4, pageRight, location });
    };
    const onLeave = () => show(null);
    // ---- a click on empty margin ----
    let down: { x: number; y: number; dismisses: boolean } | null = null;
    const onDown = (e: MouseEvent) => {
      // Read before the press moves focus (that happens after mousedown's listeners).
      const sel = window.getSelection();
      const hadSelection = !!sel && !sel.isCollapsed && sel.toString().trim() !== '';
      const active = document.activeElement;
      const writing = active instanceof Element && active.closest('.margin-note, .nb-thought, .margin-card') !== null;
      const cardOpen = scroller.querySelector('.margin-card') !== null;
      down = { x: e.clientX, y: e.clientY, dismisses: hadSelection || writing || cardOpen };
    };
    const onClick = (e: MouseEvent) => {
      const start = down;
      down = null;
      // A press that came while text was selected, a thought was being written or a card was open only
      // clicks those away: it adds nothing.
      if (!start || start.dismisses) return;
      if (e.button !== 0 || e.detail > 1 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (Math.abs(e.clientX - start.x) > CLICK_SLOP || Math.abs(e.clientY - start.y) > CLICK_SLOP) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest(`.margin-plus, ${MARGIN_PARTS}, button, a, input, textarea, select, [contenteditable]`)) return;
      const { layout: l, columnRight: right, pointAt: at, onAdd: add } = latest.current;
      const box = scroller.getBoundingClientRect();
      const x = e.clientX - box.left + scroller.scrollLeft;
      const y = e.clientY - box.top + scroller.scrollTop;
      const page = plusPage(l, x, y, right);
      // Only past the page's edge: a click on the page itself is the text's (selection, links).
      if (!page || x <= page.left + page.width) return;
      const location = at(e.clientY, page.page);
      if (!location || !spotOf(location)) return;
      show(null);
      add(location);
    };
    scroller.addEventListener('mousemove', onMove);
    scroller.addEventListener('mouseleave', onLeave);
    scroller.addEventListener('mousedown', onDown);
    scroller.addEventListener('click', onClick);
    return () => {
      scroller.removeEventListener('mousemove', onMove);
      scroller.removeEventListener('mouseleave', onLeave);
      scroller.removeEventListener('mousedown', onDown);
      scroller.removeEventListener('click', onClick);
    };
  }, [scroller]);

  if (!spot) return null;
  const guideWidth = Math.max(0, columnRight - spot.pageRight);
  const showLabel = columnRight - (spot.x + PLUS_SIZE) >= PLUS_LABEL_ROOM;
  return (
    <>
      {guideWidth > 0 && (
        <div
          className="margin-guide"
          aria-hidden="true"
          style={{ transform: `translate(${spot.pageRight}px, ${spot.y + PLUS_SIZE / 2}px)`, width: guideWidth }}
        />
      )}
      {showLabel && (
        <span className="margin-plus-label" aria-hidden="true" style={{ transform: `translate(${spot.x + PLUS_SIZE + 6}px, ${spot.y}px)` }}>
          Add thought
        </span>
      )}
      <button
        type="button"
        className="margin-plus"
        tabIndex={-1}
        aria-label="Add a thought at this line"
        title="Add a thought at this line"
        style={{ transform: `translate(${spot.x}px, ${spot.y}px)` }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setSpot(null);
          onAdd(spot.location);
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </>
  );
}
