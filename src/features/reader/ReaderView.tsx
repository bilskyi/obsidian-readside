import { backend } from '../../lib/backend';
import { buildMarginUrl, parseMarginUrl } from '../../lib/deeplink';
import { isEditable, shortcutKey, type ReaderCommand } from '../../lib/keys';
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { pageLocation, parseLocation, spotOf, startLocation, withSpot } from '../../lib/location';
import { plainQuote, quoteWithLink } from '../../lib/quote';
import { bookDisplayTitle } from '../../lib/titles';
import type { Annotation, Book, Color, Location, Thought } from '../../lib/types';
import { stepZoom } from '../../renderers/pdf/zoom';
import type { SelectionInfo } from '../../renderers/types';
import { linkingNotes, type Backlink } from '../marginalia/backlinks';
import { MarginColumn, type MarginActions } from '../marginalia/MarginColumn';
import { marginReserve, type MarginMode } from '../marginalia/marginLayout';
import { marginEntries } from '../marginalia/marginModel';
import { useHeld, useMarginMode } from '../marginalia/useMarginMode';
import { createEditorOwners, EditorOwnersContext } from '../notebook/editorOwners';
import { LinkSuggestContext, type LinkSuggestSource } from '../notebook/linkSuggest';
import { NotebookPanel } from '../notebook/NotebookPanel';
import { ThoughtSessionContext } from '../notebook/thoughtSession';
import { unlinkPatch } from '../notebook/notebookModel';
import { ResizeHandle } from '../notebook/ResizeHandle';
import { MIN_WIDTH as NOTEBOOK_MIN, useNotebookLayout } from '../notebook/useNotebookLayout';
import { fitPanels, type FitPanelsInput, type FitPanelsResult } from '../panels/fitPanels';
import { ContentsPanel } from './contents/ContentsPanel';
import { FocusPill } from './focus/FocusPill';
import { useFocusMode } from './focus/useFocusMode';
import { useThoughtPages } from './contents/useThoughtPages';
import { CONTENTS_MAX, CONTENTS_MIN, useContentsLayout } from './contents/useContentsLayout';
import { useThoughts } from '../notebook/useThoughts';
import { SelectionPopover } from './SelectionPopover';
import { TranslationCard } from '../translate/TranslationCard';
import { contextAround } from '../translate/useTranslation';
import { HOVER_BACKOFF_MAX_MS, HOVER_BACKOFF_MS, HOVER_ENGINE_TIP, useAltHoverWord, type HoverResult } from '../translate/useAltHoverWord';
import type { WordHit } from '../translate/wordAt';
import { WordTooltip } from '../translate/WordTooltip';
import type { TranslateHost, WordOutcome } from '../../translate/types';
import { PageMenu } from './PageMenu';
import type { PageMenuItem } from './pageMenuItems';
import { useNewThoughts, type DraftOrigin, type RemovedDraft } from './useNewThoughts';
import { SearchBar } from './search/SearchBar';
import { useAutoLabels } from './useAutoLabels';
import { applyHighlight } from './highlightRules';
import { useFreshIds } from './useFreshIds';
import { isPresent, toPaintable, useAnnotations } from './useAnnotations';
import { ReaderToolbar, type BackButton } from './toolbar/ReaderToolbar';
import { retireHint } from '../marginalia/MarginHint';
import {
  OPENING_DELAY_MS,
  ReaderOpenFailed,
  ReaderOpening,
  StatusRegion,
  openedAnnouncement,
  openingAnnouncement,
  useShownAfter,
} from './ReaderState';
import { rendersPaged, useReaderRenderer } from './useReaderRenderer';
import { useReaderShortcuts } from './useReaderShortcuts';

/** Language detection (franc) for ⌥-hover, loaded on first use: desktop, with no translate host, never loads it. */
let detectModule: Promise<typeof import('../../translate/detect')> | null = null;
const loadDetect = () => (detectModule ??= import('../../translate/detect'));

type PopoverState =
  | { mode: 'new'; rect: DOMRect; selection: SelectionInfo }
  | { mode: 'existing'; rect: DOMRect; annotationId: string };

/** The translation card: what it translates, and what "Save as thought" hangs the thought on. */
interface CardState {
  rect: DOMRect;
  text: string;
  context: string | undefined;
  /** A live selection (Save as thought makes its highlight first), or … */
  selection: SelectionInfo | null;
  /** … the highlight whose popover it came from. */
  annotationId: string | null;
}
/** How much page text around the selection helps detect its language (spec §A4). */
const CONTEXT_CHARS = 400;

/** A deep-link navigation request; a new `id` re-runs it even for the same place. */
export interface NavRequest {
  id: number;
  location: Location;
}

const NOTICE_MS = 1600;
/** An EPUB line at 100 % (18 px × 1.6, epub.css): what a screen scroll keeps in view. */
const EPUB_LINE_PX = 29;
/** A margin focus request for a thought that never gets a margin note is dropped after this long. */
export const MARGIN_FOCUS_MS = 3000;

const SAVE_FAILED = "Couldn't save your thought. Margin will retry.";
const UNLINK_UNAVAILABLE = "Couldn't unlink this thought: its highlight isn't loaded.";
const LINK_UNAVAILABLE = "Couldn't copy the link: its highlight isn't loaded.";

/** Where a margin:// link points, for a host that writes its own link: a highlight link resolves to the highlight. */
function hostLinkTarget(url: string, annotations: Annotation[]): { location: Location; quote: string | null } | null {
  const parsed = parseMarginUrl(url);
  if (!parsed.ok) return null;
  const target = parsed.link.target;
  if ('location' in target) return { location: target.location, quote: null };
  const a = annotations.find((x) => x.id === target.annotationId);
  const location = a ? parseLocation(a.location) : null;
  return a && location ? { location, quote: a.quote } : null;
}
const isNotFound = (e: unknown) => String(e).startsWith('not found');
/** Equal keys = the same rendered panel widths. */
const fitKey = (f: FitPanelsResult) => `${f.contents ?? '-'}:${f.notebook ?? '-'}`;

/** Runs a reader command for the host (Obsidian's command palette); `checking` only asks whether it would run. */
/**
 * Runs (or with `checking`, only asks for) a reader command. `event`: the key that asked for it, when a
 * host's key scope runs it (EPUB PageUp/PageDown then scroll a screen, as the reader's own keys do).
 */
export type ReaderCommandRunner = (cmd: ReaderCommand, checking?: boolean, event?: KeyboardEvent) => boolean;

export interface ReaderViewProps {
  book: Book;
  /** Shows "‹ Library" when given (desktop); Obsidian's goes to its shelf. */
  onBack?: () => void;
  /** The back button's label, tooltip and icon (Obsidian: "Shelf"); default "‹ Library". */
  backButton?: BackButton;
  nav?: NavRequest | null;
  /** Replaces the margin:// clipboard link: the host writes its own. `quote` is the highlight's text for a highlight link. */
  onCopyLink?: (location: Location, quote: string | null) => Promise<void> | void;
  /** Where reader shortcuts listen: the window (desktop, default) or the host's element. */
  hostKeys?: 'window' | HTMLElement;
  /** Filled with a runner for the host's own commands while mounted. */
  commands?: { current: ReaderCommandRunner | null };
  /** Shows the book title in the toolbar (default). The Obsidian view hides it: its own header shows the title. */
  showTitle?: boolean;
  /** Offered when the book can't be opened: the host opens the file another way (Obsidian: its own PDF viewer). */
  onOpenElsewhere?: () => void;
  /** The button's label for onOpenElsewhere. */
  openElsewhereLabel?: string;
  /** Kept at the page-level location on screen while mounted (the host's "Copy link to this page"); null before the book opens. */
  locationRef?: { current: Location | null };
  /**
   * How long the book must be opening before the opening state shows (default OPENING_DELAY_MS). 0: at once,
   * for a host whose own opening state was already on screen, so the hand-over doesn't blink.
   */
  openingDelayMs?: number;
  /**
   * The host keeps the opening status region itself (one region across its own loading state and the reader):
   * the reader reports what it would say there instead of rendering its own region.
   */
  announce?: (text: string) => void;
  /** `[[` link suggestions in thought editors (Obsidian: the vault's notes). None: `[[` is plain text. */
  linkSuggest?: LinkSuggestSource;
  /** Notes linking into this book (Obsidian: vault notes), shown as margin markers and counted in the notebook. */
  backlinks?: readonly Backlink[];
  /** Opens a linking note (`newTab`: ⌘ or Ctrl was held). Markers show only with this. */
  onOpenBacklink?: (link: Backlink, newTab: boolean) => void;
  /** The pointer is over a linking note in a marker's list (Obsidian: its page preview). */
  onHoverBacklink?: (link: Backlink, event: MouseEvent, targetEl: HTMLElement) => void;
  /** Told how many pages the open book has, once it knows (Obsidian: the shelf's "p. N of M"). */
  onPageCount?: (pageCount: number) => void;
  /**
   * Shows the page's right-click menu in the host's own menu (Obsidian: its Menu), calling `onClose` when it
   * goes. None: the reader shows its own small menu (PageMenu).
   */
  onPageMenu?: (event: MouseEvent, items: PageMenuItem[], onClose: () => void) => void;
  /** Replaces the clipboard text of "Copy quote with link": the host writes its own (Obsidian: its link). */
  onCopyQuote?: (location: Location, quote: string) => Promise<void> | void;
  /** Offline translation (Obsidian). None (desktop for now): no Translate in the popover. */
  translate?: TranslateHost;
}

export function ReaderView({
  book,
  onBack,
  backButton,
  nav = null,
  onCopyLink,
  hostKeys = 'window',
  commands,
  showTitle = true,
  onOpenElsewhere,
  openElsewhereLabel = 'Open elsewhere',
  locationRef,
  openingDelayMs = OPENING_DELAY_MS,
  announce,
  linkSuggest,
  backlinks,
  onOpenBacklink,
  onHoverBacklink,
  onPageCount,
  onPageMenu,
  onCopyQuote,
  translate,
}: ReaderViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  /** The same element as state, for hooks that must see it mount (⌥-hover's listeners). */
  const [hostEl, setHostEl] = useState<HTMLDivElement | null>(null);
  const setHost = useCallback((el: HTMLDivElement | null) => {
    hostRef.current = el;
    setHostEl(el);
  }, []);
  const [readerEl, setReaderEl] = useState<HTMLDivElement | null>(null);
  const { items, error, create, update, remove, collapsed, ready: annotationsReady } = useAnnotations(book.id);
  const {
    items: thoughts,
    error: thoughtsError,
    create: createThoughtRaw,
    update: updateThought,
    remove: removeThought,
    reload: reloadThoughts,
    setAutoLabels: setThoughtAutoLabels,
  } = useThoughts(book.id);
  // The first thought ever made retires the first-run hint for good (on this device), whichever way it was made.
  const createThought = useCallback(
    async (input: Parameters<typeof createThoughtRaw>[0]) => {
      const t = await createThoughtRaw(input);
      retireHint();
      return t;
    },
    [createThoughtRaw],
  );
  const {
    open: notebookOpen,
    setOpen: setNotebookOpen,
    toggle: toggleNotebook,
    width: notebookWidth,
    setWidth: setNotebookWidth,
  } = useNotebookLayout();
  const {
    open: contentsOpen,
    setOpen: setContentsOpen,
    toggle: toggleContents,
    width: contentsWidth,
    setWidth: setContentsWidth,
  } = useContentsLayout();
  const [focusThoughtId, setFocusThoughtId] = useState<string | null>(null);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [card, setCard] = useState<CardState | null>(null);
  /** Bumped by every card opened or closed, so a card whose page text arrives late doesn't open over a newer one. */
  const cardTicket = useRef(0);
  const closeCardRef = useRef(() => {
    cardTicket.current++;
    setCard(null);
  });
  /** The page's right-click menu (this reader's or the host's) is open. */
  const pageMenuOpen = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [dismissedErrors, setDismissedErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  /** Bumped by ⌘F so an open bar refocuses its field. */
  const [searchFocus, setSearchFocus] = useState(0);

  const {
    goTo,
    paint,
    currentLocation,
    pageCount,
    zoom,
    setZoom,
    search,
    showSearchHits,
    clearSearch,
    outline,
    outlineFailed,
    getPageText,
    quoteAt,
    readingLinePoint,
    marginHost,
    setMarginWidth,
    anchorPoints,
    onPageLayout,
    pointAt,
    currentSelection,
    setActiveHighlight,
    pageWidth,
    epubFraction,
    status: openStatus,
    openError,
  } = useReaderRenderer(book, hostRef, {
    onSelection: (sel) => {
      // A page menu is open: the selection popover must not come up over it.
      if (pageMenuOpen.current) return;
      // A new selection takes over from an open translation card.
      if (sel) closeCardRef.current();
      setPopover((p) => (sel ? { mode: 'new', rect: sel.rect, selection: sel } : p?.mode === 'new' ? null : p));
    },
    onHighlightClick: ({ id, rect }) => {
      closeCardRef.current();
      setPopover({ mode: 'existing', rect, annotationId: id });
    },
    onReanchor: update,
    onError: setProblem,
    onInternalLink: (to) => internalLink.current(to),
  });
  /** An internal link (EPUB) jumps like any other navigation; set once jumpTo exists. */
  const internalLink = useRef<(to: Location) => void>(() => {});

  // ---- side panels: the reading column keeps its minimum width (fitPanels) ----
  const bodyRef = useRef<HTMLDivElement>(null);
  /** A paged book the reader can render: it has pages (sections) and an outline to list. */
  const paged = rendersPaged(book.format);
  /** What a page is here: a PDF page or an EPUB section (`§ N`). Only read for a paged book. */
  const placeFormat: 'pdf' | 'epub' = book.format === 'epub' ? 'epub' : 'pdf';
  const isEpub = paged && placeFormat === 'epub';
  /** The top of page (section) `page`, as this book's kind of location. */
  const pageStart = (page: number): Location => withSpot(startLocation(placeFormat), { page, start: 0, end: 0 });
  const hasContents = paged;
  // ---- focus mode: the page alone, thoughts as dots, one floating pill (only a PDF has pages to focus on) ----
  const { focus: focusWanted, setFocus } = useFocusMode();
  // A book that failed to open has no page to focus on: the toolbar (Library, Open elsewhere…) comes back,
  // while the remembered wish stays for the next book.
  const focusAvailable = paged && openStatus !== 'failed';
  const focus = focusWanted && focusAvailable;
  // Focus mode hides the panels without touching their stored state, so leaving it restores them exactly.
  const showContents = contentsOpen && hasContents && !focus;
  const showNotebook = notebookOpen && !focus;
  /** Anything that must show the notebook (a thought it alone can take) leaves focus mode first. */
  const revealNotebook = useCallback(() => {
    setFocus(false);
    setNotebookOpen(true);
  }, [setFocus, setNotebookOpen]);
  const panelSizes: FitPanelsInput = {
    contents: showContents ? { width: contentsWidth, min: CONTENTS_MIN } : undefined,
    notebook: showNotebook ? { width: notebookWidth, min: NOTEBOOK_MIN } : undefined,
  };
  /**
   * The width the panels and the reading column share; 0 until measured. It is the latest measurement,
   * but a resize re-renders the reader only when it changes what fitPanels gives (fitKey), not per frame.
   */
  const bodyWidth = useRef(0);
  const [, rerenderForFit] = useReducer((n: number) => n + 1, 0);
  const panelSizesRef = useRef(panelSizes);
  /** fitKey of the widths last rendered (set below, after `fitted`). */
  const renderedFit = useRef<string | null>(null);
  useLayoutEffect(() => {
    panelSizesRef.current = panelSizes;
  });
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => {
      bodyWidth.current = body.getBoundingClientRect().width;
      if (fitKey(fitPanels(bodyWidth.current, panelSizesRef.current)) !== renderedFit.current) rerenderForFit();
    };
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(body);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  // ---- margin column (spec §5.2): notes (or, when narrow, tabs) beside their lines, inside the page scroller ----
  const columnRef = useRef<HTMLDivElement>(null);
  // Focus mode's dots need far less room than tabs: a pane too narrow for tabs may still have dots.
  const measuredMode = useMarginMode(columnRef, paged, pageWidth, { dots: focus });
  /**
   * The thought whose margin note (or card) has focus: marked in the notebook, its highlight filled. Only
   * the id is kept; its highlight is derived each render, so an unlink or a move shows at once.
   */
  const [marginFocus, setMarginFocus] = useState<string | null>(null);
  // While a margin note has focus the mode (and its reserve) stays put: ⌘\, ⌘⇧C or a resize while typing
  // must never unmount the editor. The newly measured mode applies once focus leaves.
  // Focus mode turns a showing margin into dots; the hold applies to that too (a note being written in when
  // focus mode starts stays a note until focus leaves it, and a card being written in outlives focus mode).
  const wantedMode: MarginMode = focus && measuredMode !== 'off' ? 'dots' : measuredMode;
  const marginMode = useHeld(wantedMode, marginFocus !== null);
  /** Focus mode: the thought whose card a dot shows (its highlight takes the full fill, like a focused note's). */
  const [shownDot, setShownDot] = useState<string | null>(null);
  /** The margin shows, as notes or as tabs: only 'off' leaves the notebook as the thoughts' one surface. */
  const showMargin = marginMode !== 'off';
  const reserve = marginReserve(marginMode);
  // Before paint, so the pages never show a frame laid out for the other reserve.
  useLayoutEffect(() => setMarginWidth(reserve), [reserve, setMarginWidth]);
  /** showMargin for code that reads it after an await (a new thought opens where it shows by then). */
  const showMarginRef = useRef(showMargin);
  useLayoutEffect(() => {
    showMarginRef.current = showMargin;
  });
  /** One editor per thought across the notebook and the margin (editorOwners.ts). */
  const [owners] = useState(createEditorOwners);
  /** A thought the margin should focus once its note is on screen. */
  const [marginFocusId, setMarginFocusId] = useState<string | null>(null);
  const onMarginFocusHandled = useCallback(() => setMarginFocusId(null), []);
  /** Thoughts and highlights created moments ago: they arrive with motion (notes drop in, highlights ink in). */
  const [fresh, markFresh] = useFreshIds();
  /**
   * The page takes the keyboard: after a typed page or a zoom choice (so PgUp/PgDn keep working), and when
   * a thought editor is done (Esc, ⌘Enter).
   */
  const focusPage = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const target = host.querySelector<HTMLElement>('.pdf-scroller') ?? host;
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }, []);
  // Thoughts made in this session: the "Esc when done" hint, and an empty one cleans itself up (with Undo).
  const {
    track: trackThought,
    releaseHighlights,
    session: thoughtSession,
    removed: removedDraft,
    dismissRemoved,
    holdRemoved,
  } = useNewThoughts({
    thoughts,
    annotations: items,
    removeThought,
    removeAnnotation: remove,
    onError: setProblem,
    finish: focusPage,
    root: readerEl,
    popoverAnnotationId: popover?.mode === 'existing' ? popover.annotationId : null,
  });
  // The margin went away (its mode turned 'off': a window or panels too narrow even for tabs) before the
  // requested note showed: the notebook takes the request, so the thought still gets the caret. Nothing is
  // left pending for the margin to grab later. A dip into tabs keeps the request: its card opens instead.
  useEffect(() => {
    if (marginFocusId === null || showMargin) return;
    revealNotebook();
    setFocusThoughtId(marginFocusId);
    setMarginFocusId(null);
  }, [marginFocusId, showMargin, revealNotebook]);
  // A request waits for its note only while the thought has a place in the margin (its note then mounts
  // as soon as the pages report a layout). A thought that never gets one (a general thought, an
  // unanchored highlight, a highlight that never arrived) must not leave the request to fire much later
  // and steal the caret, so it expires — like MarginNote's WANT_FOCUS_MS.
  const requestInMargin = useMemo(
    () => marginFocusId !== null && marginEntries(thoughts, items).some((e) => e.thought.id === marginFocusId),
    [marginFocusId, thoughts, items],
  );
  useEffect(() => {
    if (marginFocusId === null || requestInMargin) return;
    const id = marginFocusId;
    const t = setTimeout(() => setMarginFocusId((cur) => (cur === id ? null : cur)), MARGIN_FOCUS_MS);
    return () => clearTimeout(t);
  }, [marginFocusId, requestInMargin]);

  /**
   * The newest reader jump (a page key, the page field, a notebook entry, a search hit, a contents
   * entry, a deep link). Held keys step from `target` until the reader reports that page, or reports
   * anything after the newest jump has settled (its scroll event comes a frame after the jump resolves).
   * A late report of an earlier page while jumps are in flight never pulls the target back.
   * `seq` marks older jumps superseded, so an older jump still waiting for its page never scrolls last.
   */
  const pageJump = useRef<{ target: number | null; seq: number; settled: boolean }>({
    target: null,
    seq: 0,
    settled: false,
  });
  /** pageJump.target as state, for the toolbar arrows' disabled state. */
  const [jumpTarget, setJumpTarget] = useState<number | null>(null);
  /** Every navigation goes through here, so a newer one always supersedes an older one still waiting. */
  const jumpTo = useCallback(
    async (location: Location, opts: { flash?: boolean } = {}) => {
      const jump = pageJump.current;
      const seq = ++jump.seq;
      jump.target = spotOf(location)?.page ?? null;
      jump.settled = false;
      setJumpTarget(jump.target);
      const superseded = () => jump.seq !== seq;
      try {
        await goTo(location, opts.flash ? { flash: true, superseded } : { superseded });
      } finally {
        if (!superseded()) jump.settled = true;
      }
    },
    [goTo],
  );

  /** The latest reported location, for code that reads it after an await. */
  const currentLocationRef = useRef(currentLocation);
  useLayoutEffect(() => {
    currentLocationRef.current = currentLocation;
  });
  // Only once the book is open: before that, currentLocation is where the reader means to start, not a page on screen.
  const shownLocation = openStatus === 'open' ? currentLocation : null;
  useLayoutEffect(() => {
    if (!locationRef) return;
    locationRef.current = shownLocation;
  }, [locationRef, shownLocation]);
  useLayoutEffect(() => {
    if (!locationRef) return;
    return () => {
      locationRef.current = null;
    };
  }, [locationRef]);

  // Deep-link navigation (spec §5). The target arrives as a prop, so a reader remounted for another
  // book (App keys it by book id) applies it after its own open; a goTo issued into a previous
  // instance would be dropped. Under StrictMode the first run is dropped the same way, so it happens once.
  const navRef = useRef(nav);
  useLayoutEffect(() => {
    navRef.current = nav;
  });
  const navId = nav?.id;
  useEffect(() => {
    const n = navRef.current;
    if (n) jumpTo(n.location, { flash: true }).catch((e) => setProblem(String(e)));
  }, [navId, jumpTo]);

  // Opening the book collapsed stacked duplicates and moved their thoughts: show the thoughts where they are now.
  useEffect(() => {
    if (collapsed) reloadThoughts().catch((e) => setProblem(String(e)));
  }, [collapsed, reloadThoughts]);

  // Drop popover state for an annotation that no longer exists.
  useEffect(() => {
    if (popover?.mode === 'existing' && !items.some((a) => a.id === popover.annotationId)) setPopover(null);
  }, [items, popover]);

  // Repaint whenever annotations change; a highlight made moments ago is painted fresh, so it inks in.
  // Keyed by which highlights are fresh, not by the shared set: a thought turning fresh (or expiring)
  // must not rebuild the rects, which would restart a highlight's ink-in.
  const freshHighlightKey = useMemo(() => items.filter((a) => fresh.has(a.id)).map((a) => a.id).join(','), [items, fresh]);
  useEffect(() => {
    const ids = new Set(freshHighlightKey ? freshHighlightKey.split(',') : []);
    paint(items.map(toPaintable).filter(isPresent).map((a) => (ids.has(a.id) ? { ...a, fresh: true } : a)));
  }, [items, paint, freshHighlightKey]);

  // The highlight whose popover is open, else the one whose margin note has focus, shows its full fill (§5.3).
  const activeThought = marginFocus ?? shownDot;
  const focusedAnchorId = activeThought === null ? null : (thoughts.find((t) => t.id === activeThought)?.anchorId ?? null);
  const focusedAnchor = focusedAnchorId !== null && items.some((a) => a.id === focusedAnchorId) ? focusedAnchorId : null;
  const activeHighlight = popover?.mode === 'existing' ? popover.annotationId : focusedAnchor;
  useEffect(() => setActiveHighlight(activeHighlight), [activeHighlight, setActiveHighlight]);

  // Close the popover when the reader scrolls (the scroller lives inside the host,
  // so listen in the capture phase).
  const popoverOpen = popover !== null;
  const popoverMode = popover?.mode;
  useEffect(() => {
    const host = hostRef.current;
    if (!popoverOpen || !host) return;
    const onScroll = () => setPopover(null);
    host.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => host.removeEventListener('scroll', onScroll, { capture: true });
  }, [popoverOpen]);

  // A popover closes on a mousedown outside it. For a new-selection popover, presses inside
  // the reader host belong to the selection itself (it closes when the selection collapses);
  // presses anywhere else, such as notebook controls, leave the selection stale.
  useEffect(() => {
    if (!popoverOpen) return;
    const existing = popoverMode === 'existing';
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && t.closest('.popover')) return;
      if (!existing && t instanceof Node && hostRef.current?.contains(t)) return;
      setPopover(null);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [popoverOpen, popoverMode]);

  // The translation card closes like the popover: when the reader scrolls (its anchor moved) and on a press
  // outside it. A download it was showing carries on in the background (useTranslation hands it to the host).
  const cardOpen = card !== null;
  useEffect(() => {
    const host = hostRef.current;
    if (!cardOpen || !host) return;
    const close = () => closeCardRef.current();
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest('.translation-card')) return;
      close();
    };
    host.addEventListener('scroll', close, { capture: true, passive: true });
    document.addEventListener('mousedown', onDown, true);
    return () => {
      host.removeEventListener('scroll', close, { capture: true });
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [cardOpen]);

  // Transient confirmation such as "Link copied".
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  const selected = popover?.mode === 'existing' ? items.find((a) => a.id === popover.annotationId) : undefined;

  const closePopover = () => {
    setPopover(null);
    // Only clear a selection made in the page. A blanket removeAllRanges would also wipe the caret of a
    // thought editor focused in the same turn: in the notebook, or in the margin, which lives inside the
    // reader host (in the page scroller's .pdf-margin layer).
    const sel = window.getSelection();
    const node = sel?.anchorNode ?? null;
    const el = node instanceof Element ? node : (node?.parentElement ?? null);
    if (sel && el && hostRef.current?.contains(el) && !el.closest('.pdf-margin')) sel.removeAllRanges();
  };

  // One popover action at a time: pressing 1 then 2 quickly must not create two highlights.
  const busyRef = useRef(false);
  /** Runs `fn` unless another action is still running; says whether it started. */
  const run = (fn: () => Promise<unknown>): boolean => {
    if (busyRef.current) return false;
    busyRef.current = true;
    fn()
      .then(closePopover)
      .catch((e) => setProblem(String(e)))
      .finally(() => {
        busyRef.current = false;
      });
    return true;
  };

  /**
   * Every selection becomes a highlight here (highlightRules): over an existing highlight it recolours or
   * merges, so highlights never stack and one Delete removes what the reader sees. A new or reshaped
   * highlight inks in; a recoloured one doesn't.
   */
  const highlight = async (sel: { location: Location; quote: string }, opts: { color?: Color; note?: string } = {}) => {
    // Planned against the loaded list (with stacked duplicates collapsed), never an empty one still loading.
    const current = annotationsReady ? await annotationsReady() : items;
    const out = await applyHighlight(current, book.id, { location: sel.location, quote: sel.quote, ...opts }, {
      create,
      update,
      remove,
      updateThought,
      thoughts,
      quoteAt,
      patchesQuote: backend().patchesQuote === true,
    });
    if (out.kind !== 'updated') markFresh(out.annotation.id);
    if (out.reshaped) releaseHighlights(out.reshaped, out.annotation.id);
    return out;
  };

  const onColor = (color: Color) =>
    run(async () => {
      if (popover?.mode === 'new') {
        await highlight(popover.selection, { color });
      } else if (popover?.mode === 'existing') {
        await update(popover.annotationId, { color });
      }
    });

  const onNote = (note: string) =>
    run(async () => {
      if (popover?.mode === 'new') {
        await highlight(popover.selection, { note });
      } else if (popover?.mode === 'existing') {
        await update(popover.annotationId, { note });
      }
    });

  const onCopy = () =>
    run(async () => {
      const text = popover?.mode === 'new' ? popover.selection.quote : (selected?.quote ?? '');
      await navigator.clipboard.writeText(isEpub ? plainQuote(text) : text);
    });

  const onDelete = () =>
    run(async () => {
      if (popover?.mode !== 'existing') return;
      await remove(popover.annotationId);
      // Its thoughts received the highlight's location in the same transaction.
      await reloadThoughts();
    });

  // ---- new thoughts ----
  /**
   * Focuses a new thought where it shows: its margin note when the margin is on and the thought has a
   * place in the PDF (spec §5.2), otherwise the notebook (opened if closed). `place` is passed in because
   * a highlight created a moment ago isn't in `items` yet.
   */
  const openThought = (t: Thought, place: Location | null) => {
    markFresh(t.id);
    if (showMarginRef.current && place && spotOf(place)) {
      setMarginFocusId(t.id);
      return;
    }
    revealNotebook();
    setFocusThoughtId(t.id);
  };
  /** A thought just made here: noted for this session (`origin`: it may clean itself up while empty), then focused. */
  const openNewThought = (t: Thought, place: Location | null, origin: DraftOrigin | null) => {
    trackThought(t.id, origin);
    openThought(t, place);
  };
  /** A loaded, anchored highlight's place; null otherwise. */
  const highlightPlace = (id: string) => {
    const a = items.find((x) => x.id === id);
    return a && !a.unanchored ? parseLocation(a.location) : null;
  };
  // A live selection becomes a yellow highlight first (or, over a highlight, that highlight or the merged
  // one); the thought hangs off it. With a `body` (a saved translation) the thought starts with text: it
  // is no empty draft, so it never cleans itself up.
  const thoughtFromSelection = async (
    sel: SelectionInfo,
    rect: DOMRect,
    opts: { body?: string; onHighlight?: (annotationId: string) => void } = {},
  ) => {
    const { annotation: a, kind } = await highlight(sel);
    // The highlight exists now. If the thought fails, the popover (or the caller's own UI) is on that
    // highlight, so a retry adds only the thought instead of a second highlight.
    if (opts.onHighlight) opts.onHighlight(a.id);
    else setPopover({ mode: 'existing', rect, annotationId: a.id });
    // A blank body is no body: the thought is an empty draft like any other, and cleans itself up.
    const body = opts.body?.trim() ? opts.body : undefined;
    const t = await createThought(body === undefined ? { anchorId: a.id } : { anchorId: a.id, body });
    // A highlight made only for this thought: while both stay untouched, an empty thought takes it along.
    // One that was already there (or merged from ones that were) was made on purpose and stays.
    const place = parseLocation(a.location) ?? sel.location;
    openNewThought(
      t,
      place,
      body === undefined && kind === 'created'
        ? { kind: 'selection', annotationId: a.id, location: sel.location, quote: sel.quote }
        : null,
    );
  };
  const onThought = () =>
    run(async () => {
      if (popover?.mode === 'new') await thoughtFromSelection(popover.selection, popover.rect);
      else if (popover?.mode === 'existing') {
        const id = popover.annotationId;
        // A highlight that was already there was made on purpose: its thought never removes itself.
        openNewThought(await createThought({ anchorId: id }), highlightPlace(id), null);
      }
    });
  // ---- translation (a host only: Obsidian) ----
  /** Translate (L): the card replaces the popover, over the same place. */
  const openTranslation = () => {
    if (!popover) return;
    const fromSelection = popover.mode === 'new' ? popover.selection : null;
    const annotationId = popover.mode === 'existing' ? popover.annotationId : null;
    const text = fromSelection ? fromSelection.quote : (selected?.quote ?? '');
    if (!text.trim()) return;
    const location = fromSelection ? fromSelection.location : annotationId ? highlightPlace(annotationId) : null;
    const page = (location && spotOf(location)?.page) ?? null;
    const rect = popover.rect;
    setPopover(null);
    const ticket = ++cardTicket.current;
    // The page text around the selection helps detect a short selection's language.
    const pageText = page !== null ? getPageText(page).catch(() => '') : Promise.resolve('');
    void pageText.then((t) => {
      if (cardTicket.current !== ticket) return;
      setCard({ rect, text, context: t ? contextAround(t, text, CONTEXT_CHARS) : undefined, selection: fromSelection, annotationId });
    });
  };
  // ---- ⌥-hover word lookup (a host with translateWord, and its setting on) ----
  const translateRef = useRef(translate);
  translateRef.current = translate;
  const getPageTextRef = useRef(getPageText);
  getPageTextRef.current = getPageText;
  /** Each page's detected language, read once per page of this book. */
  const pageLangs = useRef<{ bookId: string; langs: Map<number, Promise<string | null>> }>({ bookId: book.id, langs: new Map() });
  /** ⌥-hover after a failed lookup: no engine call before `until`; the tip is shown once per reader. */
  const hoverFail = useRef({ until: 0, delay: 0, tipped: false });
  const hoverLookup = useCallback(async (word: string, hit: WordHit, signal: AbortSignal): Promise<HoverResult | null> => {
    const host = translateRef.current;
    if (!host?.translateWord) return null;
    // Page text only (not the margin, a note or the toolbar): a node inside a rendered page.
    const pageEl = hit.node.parentElement?.closest<HTMLElement>('[data-page]');
    const page = Number(pageEl?.dataset.page);
    if (!pageEl || !Number.isInteger(page) || page < 1) return null;
    if (pageLangs.current.bookId !== book.id) pageLangs.current = { bookId: book.id, langs: new Map() };
    const langs = pageLangs.current.langs;
    let lang = langs.get(page);
    if (!lang) {
      lang = getPageTextRef
        .current(page)
        .then(async (t) => (await loadDetect()).detectLanguage(t))
        .catch(() => null);
      langs.set(page, lang);
    }
    const from = await lang;
    const to = host.target();
    if (!from || from === to || signal.aborted) return null;
    // A failed engine is not asked again on every word: one tip, then quiet until the backoff passes.
    const fail = hoverFail.current;
    if (Date.now() < fail.until) return null;
    let out: WordOutcome;
    try {
      out = await host.translateWord(word, from, to, signal);
    } catch (e) {
      if (signal.aborted || (e as { name?: unknown } | null)?.name === 'AbortError') return null;
      fail.delay = Math.min(fail.delay ? fail.delay * 2 : HOVER_BACKOFF_MS, HOVER_BACKOFF_MAX_MS);
      fail.until = Date.now() + fail.delay;
      if (fail.tipped) return null;
      fail.tipped = true;
      return { hint: HOVER_ENGINE_TIP };
    }
    fail.delay = 0;
    fail.until = 0;
    if (signal.aborted) return null;
    if (out.kind === 'done') return out.text.trim() ? { text: out.text, from, to } : null;
    // Hover never downloads. Not installed: every rested word says where the download is (a hint
    // shown once would leave ⌥-hover looking broken). Downloading now, or no such pair: nothing.
    if (out.kind !== 'notInstalled') return null;
    const name = (c: string) => host.languages().find((l) => l.code === c)?.name ?? c;
    return { hint: `Select text and press L to set up ${name(from)} → ${name(to)}` };
  }, [book.id]);
  const hover = useAltHoverWord(hostEl, {
    enabled: () => !!translateRef.current?.translateWord && translateRef.current.hoverEnabled?.() !== false,
    lookup: hoverLookup,
  });

  /**
   * Esc, ×, Not now: the card goes and the page takes the keyboard again, but only when the card had it
   * (or nobody did). Esc pressed while focus is elsewhere (the toolbar, the margin) leaves it there.
   */
  const closeCard = () => {
    const doc = hostRef.current?.ownerDocument ?? document;
    const active = doc.activeElement;
    const cardHadFocus = !active || active === doc.body || !!active.closest('.translation-card');
    closeCardRef.current();
    if (cardHadFocus) focusPage();
  };
  /** Save as thought: a highlight on the selection (or the clicked one) with an anchored thought whose body is the translation. */
  const saveTranslation = (translation: string) => {
    const c = card;
    if (!c) return;
    run(async () => {
      if (c.selection) {
        // Once the highlight exists the card is on it: a retry after a failed thought adds only the thought.
        const onHighlight = (id: string) => setCard((now) => (now ? { ...now, selection: null, annotationId: id } : now));
        await thoughtFromSelection(c.selection, c.rect, { body: translation, onHighlight });
      }
      else if (c.annotationId) {
        const id = c.annotationId;
        openNewThought(await createThought({ anchorId: id, body: translation }), highlightPlace(id), null);
      }
      // The new thought has focus now.
      closeCardRef.current();
    });
  };

  // ⌘⇧M / "New Thought": the current selection if any, otherwise a pin at the reading line (the
  // current page only if the reading line has no rendered page). Also from inside a thought editor:
  // focus moves to the new thought, and the old editor's blur flushes its text. Its label is added
  // by useAutoLabels.
  const newThought = () => {
    // Until the book is open there is no page to put the thought on.
    if (popover?.mode !== 'new' && pageCount < 1) return;
    run(async () => {
      if (popover?.mode === 'new') await thoughtFromSelection(popover.selection, popover.rect);
      else await pinAtReadingLine();
    });
  };
  const pinAtReadingLine = async () => {
    // Waits for the reading-line page to render, so the pin gets a real line offset. The fallback
    // reads the location after the wait (the reader may have scrolled meanwhile).
    const point = await readingLinePoint();
    const here = currentLocationRef.current;
    const at = point ?? (here ? pageLocation(here) : null);
    openNewThought(await createThought({ location: at }), at, { kind: 'pin', location: at });
  };
  /** The margin's "Add thought at reading line" (keyboard): a pin at the reading line, never the selection. */
  const addAtReadingLine = () => {
    if (pageCount < 1) return;
    run(pinAtReadingLine);
  };
  /** The margin "+", a click in the empty margin, the page menu: a pin at that line, focused in its new margin note. */
  const addPin = (location: Location) => {
    if (pageCount < 1) return;
    run(async () => openNewThought(await createThought({ location }), location, { kind: 'pin', location }));
  };
  /**
   * Undo for "Empty thought removed": the thought (and the highlight it took along) back where it was, in
   * its old place in the notebook's order. The toast goes only once the undo has started: while another
   * action runs it stays, so the undo is not lost.
   */
  const restoreDraft = (r: RemovedDraft) => {
    const started = run(async () => {
      const o = r.origin;
      /** The thought's old `position` (a new thought is put last). Failing that keeps it, out of order. */
      const backInPlace = async (t: Thought) => {
        if (t.position === r.position) return;
        await updateThought(t.id, { position: r.position }).catch((e) => setProblem(String(e)));
      };
      if (o.kind === 'pin') {
        const t = await createThought({ location: o.location });
        await backInPlace(t);
        openNewThought(t, o.location, o);
        return;
      }
      let anchorId = o.annotationId;
      let made = true;
      if (r.highlightRemoved) {
        const { annotation: a, kind } = await highlight(o);
        anchorId = a.id;
        made = kind === 'created';
      }
      const t = await createThought({ anchorId });
      await backInPlace(t);
      // Restored onto a highlight made since (the text is highlighted again): that one stays when this empties.
      openNewThought(t, o.location, made ? { ...o, annotationId: anchorId } : null);
    });
    if (started) dismissRemoved();
  };
  // ⌘Z on the page while the toast shows: Undo. Never in a text field (editors keep their own undo).
  const undoKey = useRef<(e: KeyboardEvent) => void>(() => {});
  useLayoutEffect(() => {
    undoKey.current = (e) => {
      if (!removedDraft || e.defaultPrevented || e.repeat || e.isComposing) return;
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || shortcutKey(e).toLowerCase() !== 'z') return;
      if (isEditable(e.target)) return;
      e.preventDefault();
      restoreDraft(removedDraft);
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => undoKey.current(e);
    const el: Window | HTMLElement = hostKeys === 'window' ? window : hostKeys;
    el.addEventListener('keydown', onKey as EventListener);
    return () => el.removeEventListener('keydown', onKey as EventListener);
  }, [hostKeys]);

  // ---- the page's right-click menu ----
  const [pageMenu, setPageMenu] = useState<{ x: number; y: number; items: PageMenuItem[] } | null>(null);
  const highlightSelection = (sel: SelectionInfo, color: Color) => run(() => highlight(sel, { color }));
  const copyPlain = (sel: SelectionInfo) =>
    attempt(async () => {
      // An EPUB's source indentation and block breaks are layout, not text: one space between words. A PDF
      // quote is copied as it is.
      await navigator.clipboard.writeText(isEpub ? plainQuote(sel.quote) : sel.quote);
      setNotice('Copied');
    });
  const copyQuote = (sel: SelectionInfo) =>
    attempt(async () => {
      const quote = isEpub ? plainQuote(sel.quote) : sel.quote;
      if (onCopyQuote) await onCopyQuote(sel.location, quote);
      else await navigator.clipboard.writeText(quoteWithLink(quote, buildMarginUrl(book.id, { location: sel.location })));
      setNotice('Quote copied');
    });
  /**
   * What a right-click offers: the selection's actions while text is selected, otherwise the clicked line's.
   * The selection is read live: a right-click selects the word under it (macOS) before `contextmenu`, and
   * the selection the popover last showed may be an older one elsewhere.
   */
  const pageMenuItems = (target: Element, clientY: number): PageMenuItem[] | null => {
    const sel = currentSelection();
    if (sel) {
      const { rect } = sel;
      return [
        { id: 'highlight', label: 'Highlight', icon: 'highlighter', onSelect: () => highlightSelection(sel, 'yellow'), onColor: (c) => highlightSelection(sel, c) },
        { id: 'thought-on-selection', label: 'Add thought on selection', icon: 'message-square-plus', onSelect: () => run(() => thoughtFromSelection(sel, rect)) },
        { id: 'copy', label: 'Copy', icon: 'copy', onSelect: () => copyPlain(sel) },
        { id: 'copy-quote', label: 'Copy quote with link', icon: 'quote', onSelect: () => copyQuote(sel) },
      ];
    }
    const pageEl = target.closest<HTMLElement>('.pdf-page');
    const page = Number(pageEl?.dataset.page);
    if (!pageEl || !Number.isInteger(page) || page < 1) return null;
    // An unrendered page has no lines yet: its top.
    const location = pointAt(clientY, page) ?? pageStart(page);
    return [
      { id: 'add-thought-here', label: 'Add thought here', icon: 'message-square-plus', onSelect: () => addPin(location) },
      { id: 'copy-spot-link', label: 'Copy link to this spot', icon: 'link', onSelect: () => copyLink(buildMarginUrl(book.id, { location })) },
    ];
  };
  const onPageContextMenu = useRef<(e: MouseEvent) => void>(() => {});
  useLayoutEffect(() => {
    onPageContextMenu.current = (e) => {
      if (e.defaultPrevented || pageCount < 1) return;
      const t = e.target instanceof Element ? e.target : null;
      // Text fields keep the native menu; the margin's notes are not the page.
      if (!t || isEditable(t) || t.closest('.pdf-margin')) return;
      const menuItems = pageMenuItems(t, e.clientY);
      if (!menuItems) return;
      e.preventDefault();
      // The menu takes over from the selection popover (the selection itself stays, for the menu's actions),
      // which stays away while the menu is open.
      if (popover?.mode === 'new') setPopover(null);
      pageMenuOpen.current = true;
      if (onPageMenu) onPageMenu(e, menuItems, () => (pageMenuOpen.current = false));
      else setPageMenu({ x: e.clientX, y: e.clientY, items: menuItems });
    };
  });
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const on = (e: MouseEvent) => onPageContextMenu.current(e);
    host.addEventListener('contextmenu', on);
    return () => host.removeEventListener('contextmenu', on);
  }, []);

  // ---- toolbar: pages and zoom ----
  const onPageCountRef = useRef(onPageCount);
  onPageCountRef.current = onPageCount;
  useEffect(() => {
    if (pageCount > 0) onPageCountRef.current?.(pageCount);
  }, [pageCount]);
  const currentPage = (currentLocation && spotOf(currentLocation)?.page) ?? null;
  /**
   * EPUB reading progress for the bars: the saved place's fraction while it is inside the section on
   * screen, else the sections before this one. PDF: undefined (the bars use page / pageCount).
   */
  const progress =
    isEpub && pageCount > 0 && currentPage !== null
      ? epubFraction !== null && epubFraction >= (currentPage - 1) / pageCount && epubFraction <= currentPage / pageCount
        ? epubFraction
        : (currentPage - 1) / pageCount
      : undefined;
  useEffect(() => {
    const jump = pageJump.current;
    if (jump.target !== null && (jump.settled || currentPage === jump.target)) {
      jump.target = null;
      setJumpTarget(null);
    }
  }, [currentLocation, currentPage]);
  const goToPage = (page: number) => {
    if (pageCount < 1) return;
    const p = Math.min(pageCount, Math.max(1, Math.round(page)));
    attempt(() => jumpTo(pageStart(p)));
  };
  const stepPage = (dir: 1 | -1) => {
    const from = pageJump.current.target ?? currentPage;
    if (from !== null) goToPage(from + dir);
  };
  /**
   * EPUB PageUp/PageDown: a screen less one line, as the browser scrolls. With the scroller focused the
   * browser does it itself (leaveToBrowser); otherwise (focus on the page's text, the body, the host root)
   * the scroller is scrolled by that much here.
   */
  const scrollScreen = (dir: 1 | -1) => {
    const scroller = hostRef.current?.querySelector<HTMLElement>('.pdf-scroller');
    if (!scroller) return;
    const line = Math.round(EPUB_LINE_PX * ((zoom?.percent ?? 100) / 100));
    scroller.scrollBy({ top: dir * Math.max(line, scroller.clientHeight - line) });
  };
  const leaveToBrowser = (e: KeyboardEvent, cmd: ReaderCommand) =>
    isEpub &&
    (cmd === 'nextPage' || cmd === 'prevPage') &&
    (e.key === 'PageDown' || e.key === 'PageUp') &&
    e.target instanceof Element &&
    e.target.closest('.pdf-scroller') !== null;
  const zoomBy = (dir: 1 | -1) => {
    if (zoom) setZoom(stepZoom(zoom.percent, dir));
  };

  // ---- contents ----
  /** Stable across body keystrokes, so the contents counts aren't recomputed per key. */
  const thoughtPages = useThoughtPages(thoughts, items);
  const jumpToPage = (page: number) => attempt(() => jumpTo(pageStart(page), { flash: true }));
  /** A contents entry that names its own spot (an EPUB fragment): there, not the section top. */
  const jumpToEntry = (at: Location) => attempt(() => jumpTo(at, { flash: true }));

  // ---- automatic labels: new thoughts and the post-migration backfill (spec §3.2) ----
  useAutoLabels(thoughts, items, {
    // A failed outline read would store labels without their section for good: wait for the next open.
    ready: pageCount > 0 && outline !== null && !outlineFailed,
    outline: outline ?? [],
    getPageText,
    setAutoLabels: setThoughtAutoLabels,
  });

  // ---- search ----
  /** Only a rendered paged book has a reading column to search (and to hold the bar). */
  const canSearch = paged;
  /** The thought editor ⌘F opened the bar from, to hand focus back to on close; null: the page. */
  const searchOpener = useRef<HTMLElement | null>(null);
  const openSearch = () => {
    if (!searchOpen) {
      const from = document.activeElement;
      searchOpener.current = from instanceof HTMLElement && from.closest('.thought-editor') ? from : null;
    }
    setSearchOpen(true);
    setSearchFocus((n) => n + 1);
  };
  /**
   * Focus in the bar (Escape, Close) goes back to the thought editor it was opened from, or to the page.
   * Focus elsewhere (the toolbar's Search toggle) stays where it is.
   */
  const closeSearch = () => {
    const active = document.activeElement;
    const focusInBar = !active || active === document.body || active.closest('.search-bar') !== null;
    setSearchOpen(false);
    if (!focusInBar) return;
    const opener = searchOpener.current;
    searchOpener.current = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    else focusPage();
  };
  const toggleSearch = () => {
    if (searchOpen) closeSearch();
    else {
      searchOpener.current = null;
      setSearchOpen(true);
    }
  };
  // Focus mode: on and off from ⌘., the command, the toolbar button and the pill. An open search bar
  // closes on the way in (⌘F still brings it back).
  const toggleFocus = () => {
    if (!focus && searchOpen) closeSearch();
    setFocus(!focus);
  };
  /** ⌘\ and ⌘⇧C in focus mode: leave it, with that panel open. */
  const onToggleNotebook = () => (focus ? revealNotebook() : toggleNotebook());
  const onToggleContents = () => {
    if (!focus) return toggleContents();
    setFocus(false);
    setContentsOpen(true);
  };
  // The toolbar or a panel had focus and went away (or the pill did): the page takes the keyboard, so the
  // keys (Esc, page keys) keep working in a host that listens on its own element.
  // Only on a change (not on mount, nor StrictMode's second mount run).
  const lastFocus = useRef(focus);
  useEffect(() => {
    if (lastFocus.current === focus) return;
    lastFocus.current = focus;
    const active = document.activeElement;
    if (!active || active === document.body) focusPage();
    // focusPage reads only refs.
  }, [focus]);
  /** Esc in focus mode, when nothing nearer used it: an open search bar closes first, then focus mode ends. */
  const escapeFocus = useRef<() => boolean>(() => false);
  useLayoutEffect(() => {
    escapeFocus.current = () => {
      // The selection popover closes on this Esc (its own window listener).
      if (!focus || popover || card) return false;
      if (searchOpen) closeSearch();
      else setFocus(false);
      return true;
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (escapeFocus.current()) e.preventDefault();
    };
    const el: Window | HTMLElement = hostKeys === 'window' ? window : hostKeys;
    el.addEventListener('keydown', onKey as EventListener);
    return () => el.removeEventListener('keydown', onKey as EventListener);
  }, [hostKeys]);
  const searchDeps = {
    search,
    showSearchHits,
    clearSearch,
    goTo: (location: Location) => jumpTo(location),
    fromPage: () => currentPage ?? 1,
    format: placeFormat,
  };

  // Reader-wide shortcuts (spec §5.1). Bare keys never fire in a text field; ⌘ chords also work in
  // the reader's own fields (thought editors, search, page number).
  const shortcutHandlers: Partial<Record<ReaderCommand, (e?: KeyboardEvent) => void>> = {
    toggleNotebook: onToggleNotebook,
    newThought,
    // EPUB: PageUp/PageDown scroll a screen (spec B6); ⌥←/⌥→ and the host's commands step a section.
    nextPage: (e) => (isEpub && e?.key === 'PageDown' ? scrollScreen(1) : stepPage(1)),
    prevPage: (e) => (isEpub && e?.key === 'PageUp' ? scrollScreen(-1) : stepPage(-1)),
    zoomIn: () => zoomBy(1),
    zoomOut: () => zoomBy(-1),
    zoomFit: () => setZoom('fit-width'),
    find: canSearch ? openSearch : undefined,
    toggleContents: hasContents ? onToggleContents : undefined,
    toggleFocus: focusAvailable ? toggleFocus : undefined,
    // Not a key of its own (readerCommand never returns it): the Obsidian view's scope runs it for an Esc
    // pressed with focus outside the reader. Offered only when that Esc would leave focus mode itself.
    leaveFocus: focus && !popover && !searchOpen ? () => setFocus(false) : undefined,
  };
  useReaderShortcuts(shortcutHandlers, hostKeys, leaveToBrowser);
  // The host's commands run the same handlers as the keys.
  const shortcutsRef = useRef(shortcutHandlers);
  useLayoutEffect(() => {
    shortcutsRef.current = shortcutHandlers;
  });
  useLayoutEffect(() => {
    if (!commands) return;
    commands.current = (cmd, checking = false, event) => {
      const run = shortcutsRef.current[cmd];
      if (!run) return false;
      if (!checking) run(event);
      return true;
    };
    return () => {
      commands.current = null;
    };
  }, [commands]);

  // ---- notebook actions (failures go to the error toast) ----
  const attempt = (fn: () => Promise<unknown>) => {
    fn().catch((e) => setProblem(String(e)));
  };
  const navigate = (location: Location) => attempt(() => jumpTo(location, { flash: true }));
  useLayoutEffect(() => {
    internalLink.current = navigate;
  });
  const thoughtsRef = useRef(thoughts);
  useLayoutEffect(() => {
    thoughtsRef.current = thoughts;
  });
  /** Thoughts whose save failure was already reported; cleared by their next successful save. */
  const failureShown = useRef(new Set<string>());
  // The editor treats a rejection as unsaved and retries, so failures are rethrown.
  const saveThought = useCallback(
    (id: string, body: string) =>
      updateThought(id, { body }).then(
        () => {
          failureShown.current.delete(id);
        },
        (e) => {
          // A save that lands after its thought was deleted has nothing left to save.
          if (isNotFound(e) && !thoughtsRef.current.some((t) => t.id === id)) return;
          // One toast per failing thought, not one per retry.
          if (!failureShown.current.has(id)) {
            failureShown.current.add(id);
            setProblem(SAVE_FAILED);
          }
          throw e;
        },
      ),
    [updateThought],
  );
  const onFocusHandled = useCallback(() => setFocusThoughtId(null), []);
  const copyLink = (url: string) => {
    if (!onCopyLink) {
      attempt(async () => {
        await navigator.clipboard.writeText(url);
        setNotice('Link copied');
      });
      return;
    }
    const target = hostLinkTarget(url, items);
    if (!target) {
      setProblem(LINK_UNAVAILABLE);
      return;
    }
    attempt(async () => {
      await onCopyLink(target.location, target.quote);
      setNotice('Link copied');
    });
  };
  const unlinkThought = (t: Thought, anchor: Annotation | null) => {
    const patch = unlinkPatch(t, anchor);
    if (!patch) setProblem(UNLINK_UNAVAILABLE);
    else attempt(() => updateThought(t.id, patch));
  };
  /** A custom name replaces the automatic label; null (a cleared name) brings the automatic one back. */
  const renameThought = (id: string, label: string | null) => attempt(() => updateThought(id, { labelCustom: label }));
  const deleteThought = (t: Thought) =>
    attempt(async () => {
      if (t.body.trim() && !(await backend().confirm('Delete this thought? This can’t be undone.', { title: 'Delete Thought', kind: 'warning' }))) {
        return;
      }
      await removeThought(t.id);
    });
  const deleteAnnotation = (a: Annotation) => {
    if (busyRef.current) return;
    busyRef.current = true;
    remove(a.id)
      .then(() => reloadThoughts())
      .catch((e) => setProblem(String(e)))
      .finally(() => {
        busyRef.current = false;
      });
  };
  /** A thought chosen in the notebook: scroll to its place and, with the margin on, focus its margin note. */
  const openFromNotebook = (t: Thought, location: Location) => {
    navigate(location);
    if (showMargin && spotOf(location)) setMarginFocusId(t.id);
  };
  /** The latest handlers, so the margin's actions stay one object and its notes skip unrelated renders. */
  const marginHandlers = useRef({ saveThought, renameThought, copyLink, unlinkThought, deleteThought, addPin, addAtReadingLine });
  useLayoutEffect(() => {
    marginHandlers.current = { saveThought, renameThought, copyLink, unlinkThought, deleteThought, addPin, addAtReadingLine };
  });
  const marginActions = useMemo<MarginActions>(
    () => ({
      onSaveThought: (id, body) => marginHandlers.current.saveThought(id, body),
      onRenameThought: (id, label) => marginHandlers.current.renameThought(id, label),
      onCopyLink: (url) => marginHandlers.current.copyLink(url),
      onUnlinkThought: (t, anchor) => marginHandlers.current.unlinkThought(t, anchor),
      onDeleteThought: (t) => marginHandlers.current.deleteThought(t),
      onFocusEntry: (entry, id) => setMarginFocus((cur) => (entry ? entry.thought.id : cur === id ? null : cur)),
      onShowEntry: setShownDot,
      // Through the ref like the rest: addPin reads pageCount and the popover of the latest render.
      onAddPin: (location) => marginHandlers.current.addPin(location),
      onAddAtReadingLine: () => marginHandlers.current.addAtReadingLine(),
    }),
    [],
  );

  // Rendered panel widths: the stored preferences, narrowed (notebook first) so the reading column
  // keeps its minimum. The preferences themselves are untouched; a wider window gives the width back.
  // The latest measured width (a ref: a resize that leaves the fit alone doesn't re-render).
  const fitted = fitPanels(bodyWidth.current, panelSizes);
  useLayoutEffect(() => {
    renderedFit.current = fitKey(fitted);
  });
  const shownContentsWidth = fitted.contents ?? contentsWidth;
  const shownNotebookWidth = fitted.notebook ?? notebookWidth;
  const displayTitle = bookDisplayTitle(book);
  const showOpening = useShownAfter(paged && openStatus === 'opening', openingDelayMs);
  // "<title> opened" only after "Opening…" was said: a fast open says nothing.
  const [openingSaid, setOpeningSaid] = useState(false);
  useEffect(() => {
    if (showOpening) setOpeningSaid(true);
  }, [showOpening]);
  const statusText = showOpening
    ? openingAnnouncement(displayTitle)
    : openingSaid && openStatus === 'open'
      ? openedAnnouncement(displayTitle)
      : '';
  useEffect(() => {
    announce?.(statusText);
  }, [announce, statusText]);

  // Show each load error in turn: dismissing one reveals the next.
  const loadError = [error, thoughtsError].find((e): e is string => !!e && !dismissedErrors.includes(e)) ?? null;
  const message = problem ?? loadError;
  const dismiss = () => {
    if (problem) setProblem(null);
    else if (loadError) setDismissedErrors((d) => [...d, loadError]);
  };

  return (
    <div className="reader" ref={setReaderEl} data-focus={focus ? '' : undefined}>
      {!focus && (
        <ReaderToolbar
          title={displayTitle}
          showTitle={showTitle}
          page={currentPage}
          pageCount={pageCount}
          zoom={zoom}
          notebookOpen={notebookOpen}
          canAddThought={paged && pageCount > 0}
          onBack={onBack}
          backButton={backButton}
          onGoToPage={goToPage}
          onStepPage={stepPage}
          pageTarget={jumpTarget}
          onZoom={setZoom}
          onReturnToPage={focusPage}
          onAddThought={newThought}
          onToggleNotebook={onToggleNotebook}
          searchOpen={searchOpen}
          onToggleSearch={canSearch ? toggleSearch : undefined}
          contentsOpen={contentsOpen}
          onToggleContents={hasContents ? onToggleContents : undefined}
          onToggleFocus={focusAvailable ? toggleFocus : undefined}
          unit={isEpub ? 'section' : 'page'}
          progress={progress}
        />
      )}
      <EditorOwnersContext.Provider value={owners}>
        <ThoughtSessionContext.Provider value={thoughtSession}>
          <LinkSuggestContext.Provider value={linkSuggest ?? null}>
            <div className="reader-body" ref={bodyRef}>
              {showContents && (
                <>
                  <ContentsPanel
                    outline={outline}
                    outlineFailed={outlineFailed}
                    pageCount={pageCount}
                    currentPage={currentPage}
                    thoughtPages={thoughtPages}
                    width={shownContentsWidth}
                    onNavigate={jumpToPage}
                    onNavigateTo={jumpToEntry}
                    format={placeFormat}
                  />
                  <ResizeHandle
                    panel="left"
                    label="Resize contents"
                    min={CONTENTS_MIN}
                    max={CONTENTS_MAX}
                    width={shownContentsWidth}
                    onResize={setContentsWidth}
                  />
                </>
              )}
              {/* A paged book (PDF, EPUB) the reader has a renderer for. */}
              {paged ? (
                // The column holds the bar, so it never covers the notebook or contents panels.
                <div className="reader-column" ref={columnRef}>
                  <div className="reader-host" ref={setHost} />
                  {/* Always mounted, so the text is announced when it changes; the host may keep it instead. */}
                  {!announce && <StatusRegion text={statusText} />}
                  {showOpening && <ReaderOpening title={displayTitle} />}
                  {openStatus === 'failed' && openError && (
                    <ReaderOpenFailed
                      title={displayTitle}
                      error={openError}
                      openElsewhere={onOpenElsewhere ? { label: openElsewhereLabel, onOpen: onOpenElsewhere } : undefined}
                    />
                  )}
                  {searchOpen && (
                    <SearchBar
                      deps={searchDeps}
                      pageCount={pageCount}
                      format={placeFormat}
                      focusSignal={searchFocus}
                      onClose={closeSearch}
                    />
                  )}
                  {/* At once, before the pages exist: a remembered focus mode always has its way out (×). */}
                  {focus && (
                    <FocusPill
                      page={pageCount > 0 ? currentPage : null}
                      pageCount={pageCount}
                      pageTarget={jumpTarget}
                      zoom={zoom}
                      canAddThought={pageCount > 0}
                      onGoToPage={goToPage}
                      onStepPage={stepPage}
                      onZoom={setZoom}
                      onReturnToPage={focusPage}
                      onAddThought={newThought}
                      onExit={toggleFocus}
                      pointerArea={readerEl}
                      keyArea={hostKeys}
                      unit={isEpub ? 'section' : 'page'}
                      progress={progress}
                    />
                  )}
                  {marginMode !== 'off' && marginHost && (
                    <MarginColumn
                      host={marginHost}
                      mode={marginMode}
                      thoughts={thoughts}
                      annotations={items}
                      currentPage={currentPage}
                      onPageLayout={onPageLayout}
                      anchorPoints={anchorPoints}
                      pointAt={pointAt}
                      focusThoughtId={marginFocusId}
                      onFocusHandled={onMarginFocusHandled}
                      fresh={fresh}
                      actions={marginActions}
                      backlinks={backlinks}
                      onOpenBacklink={onOpenBacklink}
                      onHoverBacklink={onHoverBacklink}
                    />
                  )}
                </div>
              ) : (
                <p className="notice">{book.format.toUpperCase()} support arrives in Milestone 2.</p>
              )}
              {showNotebook && (
                <>
                  <ResizeHandle width={shownNotebookWidth} onResize={setNotebookWidth} />
                  <NotebookPanel
                    annotations={items}
                    thoughts={thoughts}
                    currentLocation={currentLocation}
                    focusThoughtId={focusThoughtId}
                    onFocusHandled={onFocusHandled}
                    onNavigate={navigate}
                    onSaveThought={saveThought}
                    onCopyLink={copyLink}
                    onUnlinkThought={unlinkThought}
                    onDeleteThought={deleteThought}
                    onDeleteAnnotation={deleteAnnotation}
                    onRenameThought={renameThought}
                    width={shownNotebookWidth}
                    onOpenThought={openFromNotebook}
                    activeThoughtId={marginFocus}
                    linkedFrom={backlinks ? linkingNotes(backlinks) : 0}
                    fresh={fresh}
                  />
                </>
              )}
            </div>
          </LinkSuggestContext.Provider>
        </ThoughtSessionContext.Provider>
      </EditorOwnersContext.Provider>
      <div className="toasts">
        {message && (
          <p role="alert" className="toast error" title="Click to dismiss" onClick={dismiss}>
            {message}
          </p>
        )}
        {/* Always mounted, so screen readers announce the text when it appears. */}
        <div role="status">
          {notice && <p className="toast info">{notice}</p>}
          {removedDraft && (
            // Its timer waits while the pointer or the keyboard is on it.
            <p
              className="toast info toast-undo"
              onMouseEnter={() => holdRemoved('hover', true)}
              onMouseLeave={() => holdRemoved('hover', false)}
              onFocus={() => holdRemoved('focus', true)}
              onBlur={() => holdRemoved('focus', false)}
            >
              Empty thought removed
              <span aria-hidden="true">·</span>
              <button
                type="button"
                className="toast-undo-btn"
                aria-keyshortcuts="Meta+Z"
                onClick={() => restoreDraft(removedDraft)}
              >
                Undo
                <span className="key-hint" aria-hidden="true">
                  (⌘Z)
                </span>
              </button>
            </p>
          )}
        </div>
      </div>
      {popover && (popover.mode === 'new' || selected) && (
        <SelectionPopover
          key={popover.mode === 'new' ? 'new' : popover.annotationId}
          rect={popover.rect}
          mode={popover.mode === 'new' ? { kind: 'new' } : { kind: 'existing', annotation: selected! }}
          onColor={onColor}
          onNote={onNote}
          onThought={onThought}
          onTranslate={translate ? openTranslation : undefined}
          onCopy={onCopy}
          onDelete={onDelete}
          onClose={closePopover}
        />
      )}
      {card && translate && (
        <TranslationCard
          rect={card.rect}
          host={translate}
          text={card.text}
          context={card.context}
          onSaveThought={saveTranslation}
          onClose={closeCard}
        />
      )}
      {hover.tip && <WordTooltip tip={hover.tip} />}
      {pageMenu && (
        <PageMenu
          x={pageMenu.x}
          y={pageMenu.y}
          items={pageMenu.items}
          onClose={({ restoreFocus }) => {
            pageMenuOpen.current = false;
            setPageMenu(null);
            if (restoreFocus) focusPage();
          }}
        />
      )}
    </div>
  );
}
