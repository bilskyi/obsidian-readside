import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { serializeLocation } from '../../lib/location';
import { clampSpan } from '../../lib/floating';
import type { Annotation, Location, Thought } from '../../lib/types';
import type { AnchorPoint, PageLayout, Unsubscribe } from '../../renderers/types';
import { backlinkMarkers, type Backlink } from './backlinks';
import { BACKLINK_HEIGHT, MarginBacklink } from './MarginBacklink';
import { DOT_WIDTH, layoutMargin, MARGIN_WIDTH, TAB_WIDTH } from './marginLayout';
import { columnLeft, contentHeight, lastPageBottom, marginEntries, pagesToMount, type MarginEntry } from './marginModel';
import { MarginDot } from './MarginDot';
import { MarginHint, useHintDismissed } from './MarginHint';
import { MarginNote, type MarginNoteActions, type MarginNoteProps } from './MarginNote';
import { MarginPlus } from './MarginPlus';
import { MarginTab } from './MarginTab';
import { MarginThreads, type ThreadSpec } from './MarginThreads';
import './marginalia.css';

/** A note's height before it has measured itself. */
export const DEFAULT_NOTE_HEIGHT = 64;
/** After a zoom or re-fit the notes jump with the pages, for this long, instead of gliding after them. */
export const INSTANT_MS = 200;
/** A thread leaves its note level with the label's first line, and meets its spot mid-line. */
const THREAD_FROM_Y = 14;
const THREAD_TO_Y = 7;
/** Narrow windows (spec §5.2): one-line tabs, and the open tab's note as a floating card over the page. */
export const TAB_HEIGHT = 24;
const TAB_GAP = 4;
export const CARD_WIDTH = 280;
/** The card floats this far left of its tab, and never closer than this to the scroller's left edge. */
const CARD_GAP = 8;
/** Focus mode: dots stack this close (they still never overlap). */
const DOT_GAP = 2;
/**
 * Focus mode: a card shown by hovering its dot stays this long after the pointer leaves the dot and the
 * card, so the pointer can cross the gap between them (and a brief slip off the card doesn't close it).
 */
export const DOT_CLOSE_MS = 200;

/** The scroller's visible span across its content (scrollLeft to scrollLeft + clientWidth). */
export interface ViewSpan {
  left: number;
  right: number;
}

/**
 * A floating box `width` wide that wants to start at `x`, kept CARD_GAP inside what the scroller shows
 * (a zoomed book is scrolled sideways: the content's own left edge may be off screen). An unmeasured
 * view (0 wide) only keeps it off the left edge.
 */
export function inView(x: number, width: number, view: ViewSpan): number {
  if (!(view.right > view.left)) return Math.max(view.left + CARD_GAP, x);
  return clampSpan(x, width, view.left, view.right, CARD_GAP);
}

/**
 * Where a tab's card floats (spec §5.2): over the page, left of the tab, ending CARD_GAP before the tab's
 * left edge (it never covers its own tab), but never past what the scroller shows on the left. It starts
 * level with the tab and rises just enough to end no lower than the last page (the scroller stays as tall
 * as the pages), though never so far that it ends above the tab's top.
 */
function cardTransform(tabLeft: number, tabTop: number, cardHeight: number, bookBottom: number, view: ViewSpan): string {
  const x = inView(tabLeft - CARD_GAP - CARD_WIDTH, CARD_WIDTH, view);
  const y = levelY(tabTop, cardHeight, bookBottom);
  return `translate(${x}px, ${y}px)`;
}
/** Level with `top`, risen just enough to end no lower than the last page, never ending above `top`. */
const levelY = (top: number, cardHeight: number, bookBottom: number) =>
  Math.max(top - cardHeight, Math.min(top, bookBottom - cardHeight));

/** Focus mode: a line's height on the page, roughly (body text at ~14 pt), for a card placed below it. */
export const DOT_LINE_PT = 14;

export interface DotCardGeometry {
  /** The dot's left edge (the column's left). */
  dotLeft: number;
  /** Top of the thought's line (its anchor), not the dot's stacked top. */
  anchorTop: number;
  /** The line's height (≈ DOT_LINE_PT × the page scale). */
  lineHeight: number;
  cardHeight: number;
  /** The scroller's visible top and right edge (and left: 0 when omitted), in its content coordinates. */
  viewTop: number;
  viewRight: number;
  viewLeft?: number;
  bookBottom: number;
}

/**
 * Where a dot's card floats (focus mode). The card must leave its own line readable:
 * - With desk room right of the dot (a fixed zoom or fit-page in a wide pane), on the desk right of the
 *   dot, level with the line (ending no lower than the last page).
 * - Otherwise over the page, left of the dot (never past the scroller's left edge), ending CARD_GAP above
 *   the line; when that would start above the visible top, CARD_GAP below the line instead.
 */
export function dotCardTransform(g: DotCardGeometry): string {
  const dotRight = g.dotLeft + DOT_WIDTH;
  if (g.viewRight - dotRight >= CARD_WIDTH + 2 * CARD_GAP) {
    return `translate(${dotRight + CARD_GAP}px, ${levelY(g.anchorTop, g.cardHeight, g.bookBottom)}px)`;
  }
  const x = inView(g.dotLeft - CARD_GAP - CARD_WIDTH, CARD_WIDTH, { left: g.viewLeft ?? 0, right: g.viewRight });
  const above = g.anchorTop - CARD_GAP - g.cardHeight;
  const y = above >= g.viewTop ? above : g.anchorTop + g.lineHeight + CARD_GAP;
  return `translate(${x}px, ${y}px)`;
}

/**
 * A note re-renders only when its own props change (not when another note moves or measures itself).
 * Its position arrives as a new style object every render, so the style compares shallowly, key by key.
 * Keep it that way: a later task that adds another style key (opacity, z-index, a CSS variable…) must
 * still re-render the note when that key changes, so never narrow this back to comparing `transform` only.
 */
function sameStyle(a: CSSProperties | undefined, b: CSSProperties | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(b) as (keyof CSSProperties)[];
  return keys.length === Object.keys(a).length && keys.every((k) => a[k] === b[k]);
}
const Note = memo(MarginNote, (a: MarginNoteProps, b: MarginNoteProps) => {
  const keys = Object.keys(b) as (keyof MarginNoteProps)[];
  if (keys.length !== Object.keys(a).length) return false;
  return keys.every((k) => (k === 'style' ? sameStyle(a.style, b.style) : a[k] === b[k]));
});

export interface MarginActions extends MarginNoteActions {
  /**
   * Focus entered a note (its entry) or left it (null); `id` is that note's thought either way, so the
   * reader clears only its own focus (a late leave from one note never clears the next note's focus).
   */
  onFocusEntry: (entry: MarginEntry | null, id: string) => void;
  /** The margin "+": a new pin at this point. */
  onAddPin: (location: Location) => void;
  /** Focus mode: the thought whose card a dot is showing (hovered, focused or clicked), or null. */
  onShowEntry?: (id: string | null) => void;
  /** The column's keyboard way in: "Add thought at reading line" adds a pin at the reading line. */
  onAddAtReadingLine?: () => void;
}

export interface MarginColumnProps {
  /** The renderer's margin layer inside the page scroller: positions are scroller content coordinates. */
  host: HTMLElement;
  /**
   * 'full': notes beside their lines; 'tabs': one-line tabs that open a floating card (narrow windows);
   * 'dots' (focus mode): 8 px dots that show their note as a floating card while hovered or focused.
   */
  mode: 'full' | 'tabs' | 'dots';
  thoughts: Thought[];
  annotations: Annotation[];
  currentPage: number | null;
  onPageLayout: (cb: (layout: PageLayout) => void) => Unsubscribe;
  anchorPoints: (locations: readonly Location[]) => (AnchorPoint | null)[];
  /** Point at the nearest line on a rendered page; null when that page isn't rendered. */
  pointAt: (clientY: number, page: number) => Location | null;
  /** A thought to focus once its note is on screen (a new thought, or one opened from the notebook). */
  focusThoughtId: string | null;
  onFocusHandled: () => void;
  /** Thoughts created moments ago: their notes arrive with motion. */
  fresh: ReadonlySet<string>;
  actions: MarginActions;
  /** Notes linking into the book (the Obsidian host): quiet markers at their places. None on desktop. */
  backlinks?: readonly Backlink[];
  /** A linking note was chosen in a marker's list. */
  onOpenBacklink?: (link: Backlink, newTab: boolean) => void;
  /** The pointer is over a linking note in a marker's list (the host may preview it). */
  onHoverBacklink?: (link: Backlink, event: MouseEvent, targetEl: HTMLElement) => void;
}

const NO_BACKLINKS: readonly Backlink[] = [];
/** A marker's layout id: never a thought id (those are UUIDs). */
const markerBoxId = (key: string) => `backlink:${key}`;

/**
 * The margin column (spec §5.2), rendered into the renderer's margin layer inside the page scroller: a
 * note (or, in narrow windows, a one-line tab that opens its note as a floating card) beside each
 * thought's line, stacked by layoutMargin. Only the notes of rendered pages and pages near the reader are
 * mounted (their editors with them); a note that unmounts flushes its text like any ThoughtEditor. The
 * focused note's page (and an open card's) always stays mounted, so typing is never interrupted.
 */
export function MarginColumn({
  host,
  mode,
  thoughts,
  annotations,
  currentPage,
  onPageLayout,
  anchorPoints,
  pointAt,
  focusThoughtId,
  onFocusHandled,
  fresh,
  actions,
  backlinks = NO_BACKLINKS,
  onOpenBacklink,
  onHoverBacklink,
}: MarginColumnProps) {
  const tabs = mode === 'tabs';
  const dots = mode === 'dots';
  /** Tabs and dots both show at most one note, as a card floating over the page. */
  const floating = tabs || dots;
  const [layout, setLayout] = useState<PageLayout | null>(null);
  useEffect(() => onPageLayout(setLayout), [onPageLayout]);

  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const onHeight = useCallback((id: string, height: number) => {
    setHeights((m) => (m.get(id) === height ? m : new Map(m).set(id, height)));
  }, []);

  // An entry keeps its identity while its thought and highlight do, so a body save (a new object for
  // that one thought) re-renders only that note: Note's memo compares `entry` by identity.
  const entryCache = useRef(new Map<string, MarginEntry>());
  const entries = useMemo(() => {
    const prev = entryCache.current;
    const next = new Map<string, MarginEntry>();
    const out = marginEntries(thoughts, annotations).map((e) => {
      const old = prev.get(e.thought.id);
      const kept = old && old.thought === e.thought && old.anchor === e.anchor ? old : e;
      next.set(e.thought.id, kept);
      return kept;
    });
    entryCache.current = next;
    return out;
  }, [thoughts, annotations]);
  const entriesRef = useRef(entries);
  const actionsRef = useRef(actions);
  useLayoutEffect(() => {
    entriesRef.current = entries;
    actionsRef.current = actions;
  });

  const [focusedId, setFocusedId] = useState<string | null>(null);
  /** Focus mode's card logic, filled below (it needs the card state declared after this). */
  const dotCardFocus = useRef<(id: string, focused: boolean) => void>(() => {});
  const onFocusChange = useCallback((id: string, focused: boolean) => {
    setFocusedId((cur) => (focused ? id : cur === id ? null : cur));
    actionsRef.current.onFocusEntry(focused ? (entriesRef.current.find((e) => e.thought.id === id) ?? null) : null, id);
    dotCardFocus.current(id, focused);
  }, []);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const onHoverChange = useCallback((id: string, hovering: boolean) => {
    setHoverId((cur) => (hovering ? id : cur === id ? null : cur));
  }, []);
  // The open card's hover is kept apart from its tab's: a card closes (Escape, a press outside, its tab,
  // wide again, its thought deleted) without a mouseleave, and its hover must go with it, while the tab's
  // own hover (the pointer is still on the tab that closed it) stays.
  const [cardHoverId, setCardHoverId] = useState<string | null>(null);
  const onCardHoverChange = useCallback((id: string, hovering: boolean) => {
    setCardHoverId((cur) => (hovering ? id : cur === id ? null : cur));
  }, []);
  /** The open card's measured height (it ends no lower than the last page). */
  const [cardHeight, setCardHeight] = useState<{ id: string; height: number } | null>(null);
  const onCardHeight = useCallback((id: string, height: number) => {
    setCardHeight((cur) => (cur?.id === id && cur.height === height ? cur : { id, height }));
  }, []);

  // ---- narrow windows: tabs, and at most one open card ----
  const [openId, setOpenId] = useState<string | null>(null);
  const openIdRef = useRef(openId);
  useLayoutEffect(() => {
    openIdRef.current = openId;
  });
  /** The card was opened by clicking its tab: focus goes into it. */
  const [openedByClick, setOpenedByClick] = useState(false);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const requested = focusThoughtId !== null && entries.some((e) => e.thought.id === focusThoughtId);
  // A focus request (a new thought, one opened from the notebook) opens that thought's card.
  useEffect(() => {
    if (floating && requested) {
      setOpenId(focusThoughtId);
      setOpenedByClick(false);
    }
  }, [floating, requested, focusThoughtId]);
  // Wide again, or its thought is gone: no card.
  useEffect(() => {
    if (!floating || (openId !== null && !entries.some((e) => e.thought.id === openId))) setOpenId(null);
  }, [floating, openId, entries]);
  // However the card closed, its hover goes with it (it never saw its mouseleave).
  const cardHoverGone = cardHoverId !== null && cardHoverId !== openId;
  useEffect(() => {
    if (cardHoverGone) setCardHoverId(null);
  }, [cardHoverGone]);
  /** The dot or card the pointer is over (focus mode). */
  const dotHover = useRef<string | null>(null);
  // A press outside the card and its tab closes it (the card's editor flushes as it unmounts).
  useEffect(() => {
    if (openId === null) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target instanceof Node ? e.target : null;
      // The card's `[[` suggestions may float outside it (their tooltip parent is the app): a choice there
      // belongs to the card.
      if (t instanceof Element && t.closest('.margin-card, .cm-link-suggest')) return;
      if (t && tabRefs.current.get(openId)?.contains(t)) return;
      if (dotHover.current === openId) dotHover.current = null;
      setOpenId(null);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [openId]);
  /**
   * Escape in the card (not used by its name field, ⋯ menu or editor): close it and hand focus back to its
   * tab. Focus leaving the card releases the reader's hold on the margin mode; when a wider mode was
   * waiting, the tabs give way to notes and the tab goes with them, so focus moves on to the thought's
   * note (its label) once it is there, instead of falling to the page body.
   */
  const refocusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** closeCard is handing focus back to a dot: that focus must not open the card it just closed. */
  const refocusing = useRef(false);
  const closeCard = useCallback(() => {
    const id = openIdRef.current;
    setOpenId(null);
    if (id === null) return;
    setCardHoverId((cur) => (cur === id ? null : cur));
    // Focus mode: the card unmounts under the pointer without a mouseleave; its hover goes with it, or
    // the dot would keep every later card of that thought open.
    if (dotHover.current === id) dotHover.current = null;
    const tab = tabRefs.current.get(id);
    refocusing.current = true;
    try {
      tab?.focus();
    } finally {
      refocusing.current = false;
    }
    clearTimeout(refocusTimer.current);
    refocusTimer.current = setTimeout(() => {
      if (tab?.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const note = Array.from(host.querySelectorAll<HTMLElement>('.margin-note')).find((el) => el.dataset.thoughtId === id);
      note?.querySelector<HTMLElement>('.margin-note-label')?.focus();
    }, 0);
  }, [host]);
  useEffect(() => () => clearTimeout(refocusTimer.current), []);

  // ---- focus mode: a dot's card shows while its dot or the card is hovered or has focus ----
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** A clicked dot: its card's editor takes the caret. Cleared once the card has focus. */
  const [dotFocusReq, setDotFocusReq] = useState<string | null>(null);
  /** Focus is inside thought `id`'s card (or in its `[[` suggestions, which float outside it). */
  const cardHasFocus = (id: string) => {
    const active = document.activeElement;
    if (!(active instanceof Element) || active === document.body) return false;
    if (active.closest('.cm-link-suggest')) return true;
    return active.closest<HTMLElement>('.margin-card')?.dataset.thoughtId === id;
  };
  const keepCard = (id: string) =>
    dotHover.current === id || cardHasFocus(id) || !!tabRefs.current.get(id)?.contains(document.activeElement);
  const keepCardRef = useRef(keepCard);
  const cardHasFocusRef = useRef(cardHasFocus);
  useLayoutEffect(() => {
    keepCardRef.current = keepCard;
    cardHasFocusRef.current = cardHasFocus;
  });
  /** After DOT_CLOSE_MS, the open card closes unless its dot or the card is hovered or has focus. */
  const scheduleClose = useCallback(() => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      const id = openIdRef.current;
      if (id !== null && !keepCardRef.current(id)) setOpenId(null);
    }, DOT_CLOSE_MS);
  }, []);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const onDotHover = useCallback(
    (id: string, hovering: boolean) => {
      if (!hovering) {
        if (dotHover.current === id) dotHover.current = null;
        scheduleClose();
        return;
      }
      dotHover.current = id;
      clearTimeout(closeTimer.current);
      // A card being written in stays open; hovering another dot doesn't take it away.
      setOpenId((cur) => (cur !== null && cur !== id && cardHasFocusRef.current(cur) ? cur : id));
    },
    [scheduleClose],
  );
  const onDotFocus = useCallback(
    (id: string, focused: boolean) => {
      if (!focused) {
        scheduleClose();
        return;
      }
      if (refocusing.current) return;
      clearTimeout(closeTimer.current);
      setOpenId(id);
    },
    [scheduleClose],
  );
  useLayoutEffect(() => {
    dotCardFocus.current = (id, focused) => {
      if (!dots) return;
      if (focused) setDotFocusReq((cur) => (cur === id ? null : cur));
      else scheduleClose();
    };
  });
  // A click's request belongs to its card: another card (or none) drops it.
  useEffect(() => {
    if (dotFocusReq !== null && dotFocusReq !== openId) setDotFocusReq(null);
  }, [dotFocusReq, openId]);
  // The reader fills the shown card's highlight (focus mode draws no threads).
  const shownCard = dots ? openId : null;
  useEffect(() => {
    actionsRef.current.onShowEntry?.(shownCard);
  }, [shownCard]);
  useEffect(() => () => actionsRef.current.onShowEntry?.(null), []);

  // ---- backlink markers: stacked with the notes, one list open at a time ----
  // Focus mode keeps the margin quiet: no markers (the notebook still counts the linking notes).
  const markers = useMemo(() => (onOpenBacklink && !dots ? backlinkMarkers(backlinks) : []), [backlinks, onOpenBacklink, dots]);
  const [openMarker, setOpenMarker] = useState<string | null>(null);
  const closeMarker = useCallback(() => setOpenMarker(null), []);
  const openMarkerGone = openMarker !== null && !markers.some((m) => m.key === openMarker);
  useEffect(() => {
    if (openMarkerGone) setOpenMarker(null);
  }, [openMarkerGone]);

  // Virtualised by page: rendered pages and pages near the reader, plus the focused, requested and open ones.
  const pageOf = (id: string | null) => (id === null ? null : (entries.find((e) => e.thought.id === id)?.page ?? null));
  const markerPage = markers.find((m) => m.key === openMarker)?.page ?? null;
  const pages = pagesToMount(layout, currentPage, [pageOf(focusedId), pageOf(focusThoughtId), pageOf(openId), markerPage]);
  const visible = entries.filter((e) => pages.has(e.page));
  const visibleMarkers = markers.filter((m) => pages.has(m.page));
  const markersKey = visibleMarkers.map((m) => m.key).join('|');
  const markerAnchors = useMemo(
    () => (layout && visibleMarkers.length ? anchorPoints(visibleMarkers.map((m) => m.location)) : []),
    // `visibleMarkers` is captured through markersKey.
    [layout, markersKey, anchorPoints],
  );
  // Anchors are read from the rendered pages: again when the pages move or the notes (or their places)
  // change, not on every keystroke in a note.
  const visibleKey = visible.map((e) => `${e.thought.id}@${serializeLocation(e.location)}`).join('|');
  const anchors = useMemo(
    () => (layout ? anchorPoints(visible.map((e) => e.location)) : []),
    // `visible` is captured through visibleKey.
    [layout, visibleKey, anchorPoints],
  );
  const tops = layoutMargin(
    visible.flatMap((e, i) => {
      const a = anchors[i];
      const height = tabs ? TAB_HEIGHT : dots ? DOT_WIDTH : (heights.get(e.thought.id) ?? DEFAULT_NOTE_HEIGHT);
      return a ? [{ id: e.thought.id, anchor: a.top, height }] : [];
    }).concat(
      // Markers take their room in the same stack, so a note never covers one (and none covers a note).
      visibleMarkers.flatMap((m, i) => {
        const a = markerAnchors[i];
        return a ? [{ id: markerBoxId(m.key), anchor: a.top, height: BACKLINK_HEIGHT }] : [];
      }),
    ),
    // Tabs and dots stay at their lines: a focused card floats over the page instead of re-stacking the column.
    floating ? null : focusedId,
    tabs ? TAB_GAP : dots ? DOT_GAP : undefined,
    0,
    // Notes never end below the last page: the scroller (and "N / N" at the bottom) stays as tall as the pages.
    layout ? lastPageBottom(layout) : Infinity,
  );

  // The requested note is on screen (narrow: its card is open): its editor focused itself in its own
  // effect, which ran first.
  const requestShown = focusThoughtId !== null && tops.has(focusThoughtId) && (!floating || openId === focusThoughtId);
  useEffect(() => {
    if (requestShown) onFocusHandled();
  }, [requestShown, onFocusHandled]);

  // A hovered note that unmounts (scrolled out of range) never sees its mouseleave: its hover counts only
  // while it is mounted, and is forgotten once it is gone, so it doesn't come back hot when it remounts.
  const hoverMounted = hoverId !== null && tops.has(hoverId);
  const hoverGone = hoverId !== null && !hoverMounted;
  const cardHovered = cardHoverId !== null && cardHoverId === openId && tops.has(cardHoverId) ? cardHoverId : null;
  const hoveredId = hoverMounted ? hoverId : cardHovered;
  useEffect(() => {
    if (hoverGone) setHoverId(null);
  }, [hoverGone]);

  // A new scale (zoom, re-fit) moved every page at once: the notes jump with them.
  const [instant, setInstant] = useState(false);
  const lastScale = useRef<number | null>(null);
  const instantTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLayoutEffect(() => {
    if (!layout) return;
    const prev = lastScale.current;
    lastScale.current = layout.scale;
    if (prev === null || prev === layout.scale) return;
    setInstant(true);
    clearTimeout(instantTimer.current);
    instantTimer.current = setTimeout(() => setInstant(false), INSTANT_MS);
  }, [layout]);
  useEffect(() => () => clearTimeout(instantTimer.current), []);
  const [hintDismissed, dismissHint] = useHintDismissed();
  /** "Add thought at reading line" has keyboard focus: it shows near the top of what is on screen (content y). */
  const [addHereTop, setAddHereTop] = useState<number | null>(null);

  if (!layout) return null;
  const left = columnLeft(layout);
  const width = tabs ? TAB_WIDTH : dots ? DOT_WIDTH : MARGIN_WIDTH;
  const height = contentHeight(layout);
  const bookBottom = lastPageBottom(layout);
  // First run: a book with no thoughts at all, the full margin showing. At the top of the page being read,
  // so it is in view wherever the book opens.
  const hintPage = layout.pages.find((p) => p.page === currentPage) ?? layout.pages[0];
  // A backlink marker on that page sits where the hint would: the marker wins.
  const showHint = mode === 'full' && thoughts.length === 0 && !hintDismissed && !visibleMarkers.some((m) => m.page === hintPage?.page);
  // Focus mode: the shown card's pin, at its spot (read when the card opens or measures itself).
  const scroller = host.parentElement;
  /** What the scroller shows across its content: floating cards and lists stay inside it. */
  const view: ViewSpan = { left: scroller?.scrollLeft ?? 0, right: (scroller?.scrollLeft ?? 0) + (scroller?.clientWidth ?? 0) };
  const shownAt = shownCard === null ? -1 : visible.findIndex((e) => e.thought.id === shownCard);
  const shownPinAnchor = shownAt >= 0 && !visible[shownAt].anchor ? anchors[shownAt] : null;
  const shownPin = shownPinAnchor ? { id: shownCard as string, x: shownPinAnchor.x, y: shownPinAnchor.top + THREAD_TO_Y } : null;
  const threads: ThreadSpec[] = visible.flatMap((e, i) => {
    const a = anchors[i];
    const id = e.thought.id;
    const top = tops.get(id);
    if (!a || top === undefined) return [];
    return [
      {
        id,
        color: e.color,
        from: { x: left, y: top + (tabs ? TAB_HEIGHT / 2 : THREAD_FROM_Y) },
        to: { x: a.x, y: a.top + THREAD_TO_Y },
        hot: id === hoveredId || id === focusedId,
        fresh: fresh.has(id),
        estimated: !a.measured,
      },
    ];
  });
  return createPortal(
    <div
      className="margin-col"
      role="region"
      aria-label="Margin notes"
      data-instant={instant ? '' : undefined}
      data-mode={mode}
      style={{ '--margin-w': `${width}px`, '--tab-h': `${TAB_HEIGHT}px`, '--card-w': `${CARD_WIDTH}px` } as CSSProperties}
    >
      {!dots && <div className="margin-band" style={{ transform: `translateX(${left - 8}px)`, height }} />}
      {actions.onAddAtReadingLine && (
        // First in the column, so Tab reaches it before the notes. Out of sight until it has focus; the
        // pointer has the "+" and the empty column instead.
        <button
          type="button"
          className="margin-add-here"
          data-shown={addHereTop !== null ? '' : undefined}
          style={{ transform: `translate(${left + width}px, ${addHereTop ?? 0}px)` }}
          onFocus={() => setAddHereTop((scroller?.scrollTop ?? 0) + 8)}
          onBlur={() => setAddHereTop(null)}
          aria-label="Add a thought at the reading line"
          onClick={() => actions.onAddAtReadingLine?.()}
        >
          Add thought at reading line
        </button>
      )}
      {/* Focus mode draws no threads: the dot sits at its line, and the shown card's highlight takes its full fill. */}
      {!dots && <MarginThreads threads={threads} width={left + 8} />}
      {showHint && <MarginHint style={{ transform: `translate(${left}px, ${(hintPage?.top ?? 0) + 4}px)` }} onDismiss={dismissHint} />}
      {dots && shownPin && (
        // A pin has no highlight to fill: its spot is marked while its card shows.
        <svg
          className="margin-threads margin-dot-spot"
          width={8}
          height={8}
          style={{ transform: `translate(${shownPin.x - 4}px, ${shownPin.y - 4}px)` }}
          aria-hidden="true"
          focusable="false"
        >
          <g className="margin-thread thread-pin" data-thought-id={shownPin.id}>
            <circle className="margin-pin" cx={4} cy={4} r={3.5} />
          </g>
        </svg>
      )}
      {visible.map((e, i) => {
        const id = e.thought.id;
        const top = tops.get(id);
        if (top === undefined) return null;
        const style = { transform: `translate(${left}px, ${top}px)` };
        if (dots) {
          const anchorTop = anchors[i]?.top ?? top;
          return (
            // The card comes right after its dot in the DOM, so Tab goes from the dot into its card.
            <Fragment key={id}>
              <MarginDot
                entry={e}
                open={openId === id}
                fresh={fresh.has(id)}
                style={style}
                dotRef={(el) => {
                  if (el) tabRefs.current.set(id, el);
                  else tabRefs.current.delete(id);
                }}
                onActivate={() => {
                  clearTimeout(closeTimer.current);
                  setOpenId(id);
                  setDotFocusReq(id);
                }}
                onHoverChange={onDotHover}
                onFocusChange={onDotFocus}
              />
              {openId === id && (
                <Note
                  className="margin-card"
                  entry={e}
                  actions={actions}
                  autoFocus={id === focusThoughtId || id === dotFocusReq}
                  pulse={fresh.has(id)}
                  onHeight={onCardHeight}
                  onFocusChange={onFocusChange}
                  onHoverChange={onDotHover}
                  onEscape={closeCard}
                  style={{
                    transform: dotCardTransform({
                      dotLeft: left,
                      anchorTop,
                      lineHeight: DOT_LINE_PT * layout.scale,
                      cardHeight: cardHeight?.id === id ? cardHeight.height : 0,
                      viewTop: scroller?.scrollTop ?? 0,
                      viewRight: view.right,
                      viewLeft: view.left,
                      bookBottom,
                    }),
                  }}
                />
              )}
            </Fragment>
          );
        }
        return tabs ? (
          // The card comes right after its tab in the DOM, so it is next in the Tab order.
          <Fragment key={id}>
            <MarginTab
              entry={e}
              open={openId === id}
              fresh={fresh.has(id)}
              style={style}
              tabRef={(el) => {
                if (el) tabRefs.current.set(id, el);
                else tabRefs.current.delete(id);
              }}
              onToggle={() => {
                setOpenedByClick(true);
                setOpenId((cur) => (cur === id ? null : id));
              }}
              onHoverChange={onHoverChange}
            />
            {openId === id && (
              <Note
                className="margin-card"
                entry={e}
                actions={actions}
                autoFocus={id === focusThoughtId || openedByClick}
                pulse={fresh.has(id)}
                onHeight={onCardHeight}
                onFocusChange={onFocusChange}
                onHoverChange={onCardHoverChange}
                onEscape={closeCard}
                style={{ transform: cardTransform(left, top, cardHeight?.id === id ? cardHeight.height : 0, bookBottom, view) }}
              />
            )}
          </Fragment>
        ) : (
          <Note
            key={id}
            entry={e}
            actions={actions}
            autoFocus={id === focusThoughtId}
            fresh={fresh.has(id)}
            pulse={fresh.has(id)}
            onHeight={onHeight}
            onFocusChange={onFocusChange}
            onHoverChange={onHoverChange}
            style={style}
          />
        );
      })}
      {onOpenBacklink &&
        visibleMarkers.map((m) => {
          const top = tops.get(markerBoxId(m.key));
          if (top === undefined) return null;
          // Under the chip in the full margin; over the page, left of the chip, in narrow windows. Never
          // wider than the margin, and flipped over the chip when it would run past the content.
          const popWidth = Math.min(CARD_WIDTH, MARGIN_WIDTH);
          const popX = inView(tabs ? left - CARD_GAP - popWidth : left, popWidth, view);
          return (
            <MarginBacklink
              key={m.key}
              marker={m}
              open={openMarker === m.key}
              style={{ transform: `translate(${left}px, ${top}px)` }}
              pop={{
                x: popX,
                below: tabs ? top : top + BACKLINK_HEIGHT + 4,
                above: tabs ? top + BACKLINK_HEIGHT : top - 4,
                limit: height,
                width: popWidth,
              }}
              onToggle={() => setOpenMarker((cur) => (cur === m.key ? null : m.key))}
              onClose={closeMarker}
              onOpen={onOpenBacklink}
              onHover={onHoverBacklink}
            />
          );
        })}
      <MarginPlus
        scroller={host.parentElement}
        layout={layout}
        columnRight={left + width}
        pointAt={pointAt}
        onAdd={actions.onAddPin}
      />
    </div>,
    host,
  );
}
