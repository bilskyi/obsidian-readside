import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { debounce } from '../../lib/debounce';
import { register as registerFlush } from '../notebook/editorRegistry';
import { backend } from '../../lib/backend';
import { isPagedFormat, pageLocation, parseLocation, spotOf, startLocation } from '../../lib/location';
import type { AnnotationPatchInput, Book, Format, Location, OutlineEntry } from '../../lib/types';
import { createRenderer } from '../../renderers/createRenderer';
import { parseZoom, serializeZoom } from '../../renderers/pdf/zoom';
import type {
  AnchorPoint,
  GoToOptions,
  PageLayout,
  PaintableAnnotation,
  RendererAdapter,
  SearchBatch,
  SearchHit,
  SelectionInfo,
  Unsubscribe,
  Zoom,
  ZoomState,
} from '../../renderers/types';
import { describeOpenError, type OpenError } from './openError';

export interface ReaderRendererHandlers {
  onSelection: (sel: SelectionInfo | null) => void;
  onHighlightClick: (hit: { id: string; rect: DOMRect }) => void;
  /** Persists the result of re-anchoring a highlight whose stored offsets no longer match its quote. */
  onReanchor: (id: string, patch: AnnotationPatchInput) => Promise<unknown>;
  onError: (message: string) => void;
  /** An internal link in the book was clicked (EPUB): the reader jumps there through its own path. */
  onInternalLink?: (to: Location) => void;
}

export interface ReaderRenderer {
  /** Waits until the book is open, then scrolls there. A no-op if opening failed or the reader closed. */
  goTo: (location: Location, opts?: GoToOptions) => Promise<void>;
  paint: (annotations: PaintableAnnotation[]) => void;
  /** Page-level location of what is on screen; null for formats without a renderer yet. */
  currentLocation: Location | null;
  /** 0 until the book is open. */
  pageCount: number;
  /** null until the book is open. */
  zoom: ZoomState | null;
  /** null until loaded; [] for a PDF without a table of contents (or whose outline couldn't be read). */
  outline: OutlineEntry[] | null;
  /**
   * True when the outline couldn't be read: `outline` is [] for display, but it is not the book's real
   * table of contents, so nothing permanent (an automatic label's section) may be derived from it.
   */
  outlineFailed: boolean;
  setZoom: (zoom: Zoom, opts?: { anchor?: { clientX: number; clientY: number } }) => void;
  /** A point location at the reading line, once the book is open and that page has rendered; null if it never opens. */
  readingLinePoint: () => Promise<Location | null>;
  /** Waits until the book is open. '' for a page without text; rejects when the text couldn't be read (or the book never opens). */
  getPageText: (page: number) => Promise<string>;
  /** The renderer's text for a range (RendererAdapter.quoteAt); null before open or when it has none. */
  quoteAt: (location: Location) => Promise<string | null>;
  search: (query: string, opts: { signal?: AbortSignal; fromPage?: number }) => AsyncIterable<SearchBatch>;
  showSearchHits: (hits: readonly SearchHit[], current: SearchHit | null) => void;
  clearSearch: () => void;
  /** Point location at the line nearest `clientY` on a rendered `page`; null before open or when that page isn't rendered. */
  pointAt: (clientY: number, page: number) => Location | null;
  /** The page text selected right now (read live, not the last emitted selection); null before open or without one. */
  currentSelection: () => SelectionInfo | null;
  /**
   * Page boxes (for Plan 4B's margin): the current layout at once if the book is open, then every change.
   * The renderer reads page boxes only while someone listens, so subscribe only while they're needed.
   */
  onPageLayout: (cb: (layout: PageLayout) => void) => Unsubscribe;
  /** The renderer's margin layer (portal target for the margin column); null until a PDF renderer exists. */
  marginHost: HTMLElement | null;
  /** Room for the margin column; remembered and given to every renderer this hook creates. */
  setMarginWidth: (px: number) => void;
  /** Each location's spot in scroller content coordinates; all null until the book is open. */
  anchorPoints: (locations: readonly Location[]) => (AnchorPoint | null)[];
  /** The highlight shown fully filled (popover open or margin note focused); remembered for a later renderer. */
  setActiveHighlight: (id: string | null) => void;
  /** Page 1's width at scale 1 once the book is open (the margin's 'off' rule); null before. */
  pageWidth: number | null;
  /**
   * EPUB: the fraction of the book read, from the same place the position save uses (sections before the
   * reading line's plus the part of its section above it); null before the first save of this book (PDF:
   * always null, its progress is page / pageCount).
   */
  epubFraction: number | null;
  /** 'opening' while the bytes are read and the pages set up; 'failed' when the book couldn't be opened. */
  status: OpenStatus;
  /** Why the book couldn't be opened, in plain words (with the raw message); null unless status is 'failed'. */
  openError: OpenError | null;
}

export type OpenStatus = 'opening' | 'open' | 'failed';

type BookRef = Pick<Book, 'id' | 'format' | 'lastLocation' | 'zoom'>;

const ZOOM_SAVE_MS = 500;
/** EPUB: the reading line's place is saved this long after scrolling stops (a quit never unmounts the reader). */
export const EPUB_SCROLL_SAVE_MS = 1500;

async function* noResults(): AsyncGenerator<SearchBatch> {}

/** Paged formats this reader has a renderer for (createRenderer). */
const RENDERED_FORMATS: ReadonlySet<Format> = new Set<Format>(['pdf', 'epub']);

/** True for a paged format the reader can open: it gets the page column, margin, contents, search and focus. */
export const rendersPaged = (f: Format): f is 'pdf' | 'epub' => isPagedFormat(f) && RENDERED_FORMATS.has(f);

/** EPUB progress: sections before this one plus the fraction `y` of this one read, over the section count. */
export function epubProgress(section: number, y: number, count: number): number {
  return Math.min(1, Math.max(0, (section - 1 + Math.min(1, Math.max(0, y))) / count));
}

export function initialLocation(book: Pick<Book, 'format' | 'lastLocation'>): Location | null {
  const saved = parseLocation(book.lastLocation);
  if (saved) return pageLocation(saved);
  return rendersPaged(book.format) ? startLocation(book.format) : null;
}

/** Owns one renderer per book: open/close, subscriptions, re-anchoring, and last-location/progress/zoom saves. */
export function useReaderRenderer(
  book: BookRef,
  hostRef: RefObject<HTMLDivElement | null>,
  handlers: ReaderRendererHandlers,
): ReaderRenderer {
  const rendererRef = useRef<RendererAdapter | null>(null);
  const readyRef = useRef<Promise<RendererAdapter | null>>(Promise.resolve(null));
  /** The renderer once its book is open; null before (and after close). */
  const openRef = useRef<RendererAdapter | null>(null);
  const handlersRef = useRef(handlers);
  const lastLocationRef = useRef(book.lastLocation);
  const zoomRef = useRef(book.zoom);
  useLayoutEffect(() => {
    handlersRef.current = handlers;
    lastLocationRef.current = book.lastLocation;
    zoomRef.current = book.zoom;
  });
  const [currentLocation, setCurrentLocation] = useState<Location | null>(() => initialLocation(book));
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoomState] = useState<ZoomState | null>(null);
  const [outline, setOutline] = useState<OutlineEntry[] | null>(null);
  const [outlineFailed, setOutlineFailed] = useState(false);
  const [pageWidth, setPageWidth] = useState<number | null>(null);
  const [marginHost, setMarginHost] = useState<HTMLElement | null>(null);
  const [epubFraction, setEpubFraction] = useState<number | null>(null);
  const [status, setStatus] = useState<OpenStatus>('opening');
  const [openError, setOpenError] = useState<OpenError | null>(null);
  /** The latest margin width, so a renderer created later (another book) starts with it. */
  const marginWidthRef = useRef(0);
  const activeHighlightRef = useRef<string | null>(null);
  // Page-layout listeners. One renderer subscription forwards to all of them, and only while there is at
  // least one listener and an open renderer (the renderer skips its layout reads with no listener).
  const layoutListeners = useRef(new Set<(layout: PageLayout) => void>());
  const layoutSub = useRef<Unsubscribe | null>(null);
  const lastLayout = useRef<PageLayout | null>(null);
  const attachLayout = useCallback((r: RendererAdapter) => {
    if (layoutSub.current || layoutListeners.current.size === 0) return;
    layoutSub.current = r.onPageLayout((layout) => {
      lastLayout.current = layout;
      layoutListeners.current.forEach((cb) => {
        try {
          cb(layout);
        } catch (err) {
          console.error('Margin: page-layout listener threw', err);
        }
      });
    });
  }, []);
  const detachLayout = useCallback(() => {
    layoutSub.current?.();
    layoutSub.current = null;
    lastLayout.current = null;
  }, []);

  // Open the renderer once per book.
  useEffect(() => {
    if (!rendersPaged(book.format) || !hostRef.current) return;
    const r = createRenderer(book.format, hostRef.current);
    if (!r) return;
    setStatus('opening');
    setOpenError(null);
    setEpubFraction(null);
    rendererRef.current = r;
    r.setMarginWidth(marginWidthRef.current);
    setMarginHost(r.marginLayer());
    r.setActiveHighlight(activeHighlightRef.current);
    let alive = true;
    /** The page count once open, kept for the close-time progress save (pageCount() is 0 after close). */
    let sectionCount = 0;
    const start = parseLocation(lastLocationRef.current);
    const saveProgress = (p: number) => void backend().setBookProgress(book.id, p).catch(() => {});
    /**
     * EPUB: the reading line's own point (section, line offset, height), so reopening returns to that line
     * inside a long section, and progress = sections before it plus the fraction of it above the reading
     * line (spec B6). Read from the renderer now (synchronously inside it, so also just before a close);
     * `fallback` is kept when there is no reading line in `section` (not open, the line moved on).
     */
    const saveEpubPlace = (fallback: Location | null, section: number | null): Promise<void> => {
      const count = sectionCount || r.pageCount();
      const keep = (loc: Location | null): Promise<void> => {
        if (!loc) return Promise.resolve();
        const saved = backend()
          .setLastLocation(book.id, loc)
          .then(
            () => {},
            () => {},
          );
        const spot = spotOf(loc);
        if (spot && count > 0) {
          const fraction = epubProgress(spot.page, spot.y ?? 0, count);
          saveProgress(fraction);
          if (alive) setEpubFraction(fraction);
        }
        return saved;
      };
      return r.readingLinePoint().then(
        (here) => {
          const at = here && here.kind === 'epub' ? spotOf(here) : null;
          return keep(at && (section === null || at.page === section) ? here : fallback);
        },
        () => keep(fallback),
      );
    };
    // EPUB reports a location only when the section changes, and a quit (⌘Q, closing the window) never
    // unmounts the reader: the reading line's place is also saved once scrolling has stopped for a while.
    const scrollSave = debounce(() => void saveEpubPlace(null, null), EPUB_SCROLL_SAVE_MS);
    const scroller = book.format === 'epub' ? hostRef.current : null;
    // Capture: the renderer's scroller is inside the host, and scroll does not bubble.
    const onScroll = () => {
      if (openRef.current === r) scrollSave();
    };
    scroller?.addEventListener('scroll', onScroll, true);
    // A quit or window close (desktop: useFlushOnClose) writes the reading line's place at once.
    const unregisterFlush =
      book.format === 'epub' ? registerFlush(() => (openRef.current === r ? saveEpubPlace(null, null) : undefined)) : () => {};
    /** True while a location save waits for its debounce. */
    let savePending = false;
    const saveLocation = debounce((loc: Location) => {
      savePending = false;
      const spot = spotOf(loc);
      // A location that carries its own height is already a precise place.
      if (loc.kind === 'epub' && spot && spot.y === undefined) {
        void saveEpubPlace(loc, spot.page);
        return;
      }
      void backend().setLastLocation(book.id, loc).catch(() => {});
      const count = r.pageCount();
      if (!spot || count <= 0) return;
      if (loc.kind !== 'epub') return saveProgress(spot.page / count);
      const fraction = epubProgress(spot.page, spot.y ?? 0, count);
      saveProgress(fraction);
      if (alive) setEpubFraction(fraction);
    }, 1000);
    const queueLocationSave = (loc: Location) => {
      savePending = true;
      saveLocation(loc);
    };
    // The saved zoom is laid out by open() itself; only a different mode is written back.
    const initialZoom = parseZoom(zoomRef.current);
    let savedZoom = serializeZoom(initialZoom);
    const saveZoom = debounce((z: string) => {
      void backend().setBookZoom(book.id, z).catch(() => {});
    }, ZOOM_SAVE_MS);
    r.setZoom(initialZoom);
    const subs = [
      // Re-anchor highlights whose stored offsets no longer match their quote.
      r.onAnchorMismatch(async (a) => {
        try {
          const loc = await r.findQuote(a.quote, a.location);
          if (!alive) return;
          await handlersRef.current.onReanchor(a.id, loc ? { location: loc, unanchored: false } : { unanchored: true });
        } catch (e) {
          if (alive) handlersRef.current.onError(String(e));
        }
      }),
      r.onSelection((sel) => handlersRef.current.onSelection(sel)),
      r.onHighlightClick((hit) => handlersRef.current.onHighlightClick(hit)),
      // Only EPUB has internal links. With this subscriber the renderer reports the target and never
      // jumps itself, so a link goes through the reader's own jump path.
      r.onInternalLink?.((to) => handlersRef.current.onInternalLink?.(to)) ?? (() => {}),
      r.onLocationChange((loc) => {
        setCurrentLocation(loc);
        queueLocationSave(loc);
      }),
      r.onZoomChange((z) => {
        setZoomState(z);
        const stored = serializeZoom(z.zoom);
        if (stored !== savedZoom) {
          savedZoom = stored;
          saveZoom(stored);
        }
      }),
    ];
    readyRef.current = backend()
      .readBookBytes(book.id)
      .then(async (bytes) => {
        if (!alive) return null;
        await r.open(bytes, start, {
          // Page 1's width decides the margin mode and so the reserve. Rendered synchronously (the mode's
          // layout effects pass the reserve to setMarginWidth) so open's first fit already uses it: no
          // second fit, no visible re-zoom.
          onPageSize: (size) => {
            if (alive) flushSync(() => setPageWidth(size.width));
          },
        });
        if (!alive) return null;
        openRef.current = r;
        sectionCount = r.pageCount();
        attachLayout(r);
        setPageCount(r.pageCount());
        setPageWidth(r.pageSize()?.width ?? null);
        setZoomState(r.getZoom());
        setStatus('open');
        // A failure shows as no outline but is flagged; resolving [] after close is not a failure.
        r.getOutline().then(
          (o) => alive && setOutline(o),
          () => {
            if (!alive) return;
            setOutline([]);
            setOutlineFailed(true);
          },
        );
        return r;
      })
      .catch((e) => {
        // Shown in the page area (ReaderView), in plain words, with the raw message behind "Details".
        if (alive) {
          setOpenError(describeOpenError(e));
          setStatus('failed');
        }
        return null;
      });
    return () => {
      alive = false;
      subs.forEach((u) => u());
      scroller?.removeEventListener('scroll', onScroll, true);
      scrollSave.cancel();
      unregisterFlush();
      detachLayout();
      // EPUB reports a location only when the section changes, so reading on inside one section never
      // queues a save: closing records the reading line's place (keep-max progress is the backend's).
      const closingInside = book.format === 'epub' && !savePending && sectionCount > 0;
      saveLocation.flush();
      if (closingInside) saveEpubPlace(null, null);
      saveZoom.flush();
      r.close();
      rendererRef.current = null;
      setMarginHost(null);
      setPageWidth(null);
      openRef.current = null;
      readyRef.current = Promise.resolve(null);
    };
    // hostRef is a stable ref object; the renderer is rebuilt only per book.
  }, [book.id, book.format]);

  const goTo = useCallback(async (location: Location, opts?: GoToOptions) => {
    const r = await readyRef.current;
    if (opts?.superseded?.()) return;
    if (r && rendererRef.current === r) await r.goTo(location, opts);
  }, []);

  const paint = useCallback((annotations: PaintableAnnotation[]) => {
    rendererRef.current?.paintHighlights(annotations);
  }, []);

  const setZoom = useCallback((z: Zoom, opts?: { anchor?: { clientX: number; clientY: number } }) => {
    rendererRef.current?.setZoom(z, opts);
  }, []);

  const readingLinePoint = useCallback(async () => {
    const r = await readyRef.current;
    return r && rendererRef.current === r ? r.readingLinePoint() : null;
  }, []);

  const getPageText = useCallback(async (page: number) => {
    const r = await readyRef.current;
    if (!r || rendererRef.current !== r) throw new Error('Margin: the book is not open');
    return r.getPageText(page);
  }, []);

  const quoteAt = useCallback(async (location: Location) => {
    const r = await readyRef.current;
    // A renderer without it (a test double) has no quote to offer: the caller falls back.
    return r && rendererRef.current === r && typeof r.quoteAt === 'function' ? r.quoteAt(location) : null;
  }, []);

  // Nothing to search before the book is open: an empty run, never a renderer call.
  const search = useCallback((query: string, opts: { signal?: AbortSignal; fromPage?: number }) => {
    const r = openRef.current;
    return r && rendererRef.current === r ? r.search(query, opts) : noResults();
  }, []);

  const showSearchHits = useCallback((hits: readonly SearchHit[], current: SearchHit | null) => {
    rendererRef.current?.showSearchHits(hits, current);
  }, []);

  const clearSearch = useCallback(() => {
    rendererRef.current?.clearSearch();
  }, []);

  const pointAt = useCallback((clientY: number, page: number) => {
    const r = openRef.current;
    return r && rendererRef.current === r ? r.pointAt(clientY, page) : null;
  }, []);

  const currentSelection = useCallback(() => {
    const r = openRef.current;
    return r && rendererRef.current === r ? r.currentSelection() : null;
  }, []);

  const onPageLayout = useCallback(
    (cb: (layout: PageLayout) => void): Unsubscribe => {
      layoutListeners.current.add(cb);
      const r = openRef.current;
      if (lastLayout.current) cb(lastLayout.current);
      else if (r && rendererRef.current === r) attachLayout(r); // the renderer sends its current layout at once
      return () => {
        if (!layoutListeners.current.delete(cb)) return;
        if (layoutListeners.current.size === 0) detachLayout();
      };
    },
    [attachLayout, detachLayout],
  );

  const setMarginWidth = useCallback((px: number) => {
    marginWidthRef.current = px;
    rendererRef.current?.setMarginWidth(px);
  }, []);

  const anchorPoints = useCallback((locations: readonly Location[]) => {
    const r = openRef.current;
    return r && rendererRef.current === r ? r.anchorPoints(locations) : locations.map(() => null);
  }, []);

  const setActiveHighlight = useCallback((id: string | null) => {
    activeHighlightRef.current = id;
    rendererRef.current?.setActiveHighlight(id);
  }, []);

  return {
    goTo,
    paint,
    currentLocation,
    pageCount,
    zoom,
    outline,
    outlineFailed,
    setZoom,
    readingLinePoint,
    getPageText,
    quoteAt,
    search,
    showSearchHits,
    clearSearch,
    pointAt,
    currentSelection,
    onPageLayout,
    marginHost,
    setMarginWidth,
    anchorPoints,
    setActiveHighlight,
    pageWidth,
    epubFraction,
    status,
    openError,
  };
}
