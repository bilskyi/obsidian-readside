import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import { pdfjs, pdfjsDocOptions } from './pdfjsProvider';
import { isPdfPoint, pdfLocation, pdfPoint, serializeLocation, spotOf } from '../../lib/location';
import type { Location, OutlineEntry, PdfLocationValue } from '../../lib/types';
import { Emitter } from '../emitter';
import type {
  AnchorPoint,
  GoToOptions,
  OpenOptions,
  PageLayout,
  PaintableAnnotation,
  RendererAdapter,
  SearchBatch,
  SearchHit,
  SelectionInfo,
  Unsubscribe,
  Zoom,
  ZoomState,
} from '../types';
import { findQuoteInPage, pageOrder, quoteMatches } from './findQuote';
import { highlightClass, hitIndex, pencilDefs } from './highlightStyle';
import { anchorFor, firstLineEnd, type AnchorFraction, type AnchorMeasure } from './anchors';
import {
  captureAt,
  captureX,
  clamp,
  decideRefit,
  fitArea,
  KEEP_RENDERED_RADIUS,
  pageLane,
  pageLeft,
  POINT_BAND_PX,
  readingPageIndex,
  RESIZE_SETTLE_MS,
  restoreAt,
  restoreX,
  SCROLL_PAGE_MS,
  type WidthChange,
} from './layout';
import { lineAtOffset, measureLines, nearestLine, type LineBox } from './lines';
import { normalizeOutline } from './pdfOutline';
import { searchPages, wrapOrder } from './search';
import { indexText, joinTextItems, offsetsToRange, rangeToPageOffsets } from './textOffsets';
import {
  clampZoom,
  GESTURE_STALE_MS,
  percentOf,
  PINCH_APPLY_MS,
  pinchZoom,
  scaleFor,
  wheelDeltaPx,
  ZOOM_MAX,
  ZOOM_MIN,
} from './zoom';

type Viewport = ReturnType<PDFPageProxy['getViewport']>;

interface PageState {
  page: number;
  el: HTMLDivElement;
  hlLayer: HTMLDivElement;
  searchLayer: HTMLDivElement;
  textLayer: HTMLDivElement;
  viewport: Viewport;
  rendering: Promise<void> | null;
  task: RenderTask | null;
  textTask: TextLayer | null;
  canvas: HTMLCanvasElement | null;
  /** Bumped by releasePage so an in-flight doRender for the released generation bails out. */
  gen: number;
  ready: boolean;
  /** Text lines relative to the page top, measured once per render (pageLines); null until needed. */
  lines: LineBox[] | null;
  /** The painted highlight rects, page-relative, for hover/click hit tests without reading every rect's box. */
  hlBoxes: { id: string; left: number; top: number; right: number; bottom: number }[];
  /** pdf.js couldn't read this page (a broken page tree entry): shown as a note, never rendered. */
  unreadable?: boolean;
}

const CLOSED = Symbol('closed');

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

const sameHit = (a: SearchHit, b: SearchHit | null) =>
  !!b && a.page === b.page && a.start === b.start && a.end === b.end;

export class PdfRenderer implements RendererAdapter {
  private doc: PDFDocumentProxy | null = null;
  private pages: PageState[] = [];
  private scroller: HTMLDivElement;
  private observer: IntersectionObserver | null = null;
  private annotations: PaintableAnnotation[] = [];
  private textCache = new Map<number, string>();
  private textFetches = new Map<number, Promise<string | typeof CLOSED>>();
  /** Pages the observer currently reports as intersecting (viewport + rootMargin). */
  private intersecting = new Set<number>();
  /**
   * Pages a waitRendered call is waiting for, with how many calls wait for each (goTo and
   * readingLinePoint may overlap). A page with a count > 0 is kept by refit and the release sweep.
   */
  private pins = new Map<number, number>();
  private checked = new Set<string>();
  private cleanup: (() => void)[] = [];
  private currentPage = 1;
  private loading: PDFDocumentLoadingTask | null = null;
  private closed = false;
  private opened = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  /** Page 1's size at scale 1, the fit reference. baseWidth is set once open() has laid out the pages. */
  private baseWidth = 0;
  private baseHeight = 0;
  private scale = 1;
  private zoom: Zoom = 'fit-width';
  /** scroller.clientWidth / clientHeight the current scale was fitted to. */
  private fitWidth = 0;
  private fitHeight = 0;
  /** The last width change refit applied, for the scrollbar-toggle reversal guard. */
  private lastChange: WidthChange | null = null;
  /** getOutline() result, shared by every caller; reset if it fails so a later call retries. */
  private outline: Promise<OutlineEntry[]> | null = null;
  private layoutQueued = false;
  private searchHits = new Map<number, SearchHit[]>();
  private currentHit: SearchHit | null = null;
  /** Drops a pinch waiting to be applied (set by bindEvents). */
  private cancelPinch: () => void = () => {};
  /** Room (px) kept free right of the pages for the margin column (setMarginWidth). */
  private marginWidth = 0;
  /** The margin column's layer: a child of the scroller, so it shares the pages' coordinates and scroll. */
  private marginEl: HTMLDivElement;
  /** Takes no room and catches nothing: its width is the scroll width pageLane asks for (placePages). */
  private extentEl: HTMLDivElement;
  /** The highlight under the pointer, and the one whose popover or margin note has focus (spec §5.3). */
  private hoverId: string | null = null;
  private activeId: string | null = null;
  /** Each location's last measured place (page fractions), keyed by its serialized form: used while its page re-renders. */
  private anchorCache = new Map<string, AnchorFraction>();

  private selectionEm = new Emitter<SelectionInfo | null>();
  private locationEm = new Emitter<Location>();
  private clickEm = new Emitter<{ id: string; rect: DOMRect }>();
  private mismatchEm = new Emitter<PaintableAnnotation>();
  private layoutEm = new Emitter<PageLayout>();
  private zoomEm = new Emitter<ZoomState>();

  constructor(host: HTMLElement) {
    this.scroller = document.createElement('div');
    this.scroller.className = 'pdf-scroller';
    this.marginEl = document.createElement('div');
    this.marginEl.className = 'pdf-margin';
    this.scroller.appendChild(this.marginEl);
    this.extentEl = document.createElement('div');
    this.extentEl.className = 'pdf-extent';
    this.extentEl.setAttribute('aria-hidden', 'true');
    this.scroller.appendChild(this.extentEl);
    // The pencil grain for highlight underlines, referenced from CSS as url(#margin-pencil).
    this.scroller.appendChild(pencilDefs());
    host.appendChild(this.scroller);
  }

  /** Note: pdf.js transfers (detaches) the passed ArrayBuffer to its worker; do not reuse it. */
  async open(data: ArrayBuffer, at?: Location | null, opts: OpenOptions = {}): Promise<void> {
    if (this.opened) throw new Error('PdfRenderer already opened');
    this.opened = true;
    const loading = pdfjs().getDocument({ ...pdfjsDocOptions(), data: new Uint8Array(data) });
    this.loading = loading;
    const doc = await this.guard(loading.promise);
    this.loading = null;
    if (doc === CLOSED) return;
    if (this.closed) {
      doc.destroy().catch(() => {});
      return;
    }
    this.doc = doc;
    const first = await this.guard(doc.getPage(1));
    if (first === CLOSED || this.closed) return;
    const base = first.getViewport({ scale: 1 });
    // Before the first fit: a margin width set from this size (setMarginWidth) is in the fit below.
    try {
      opts.onPageSize?.({ width: base.width, height: base.height });
    } catch (err) {
      console.error('PdfRenderer: onPageSize threw', err);
    }
    const scale = this.targetScale(base.width, base.height);
    let last: Viewport = first.getViewport({ scale });
    for (let n = 1; n <= doc.numPages; n++) {
      let p: PDFPageProxy | typeof CLOSED | null;
      try {
        p = n === 1 ? first : await this.guard(doc.getPage(n));
      } catch (err) {
        // One broken page (a bad page-tree entry) must not keep the whole book closed: it gets the
        // previous page's size and a note instead of content.
        console.warn(`PdfRenderer: page ${n} can't be read`, err);
        p = null;
      }
      if (p === CLOSED || this.closed) return;
      const viewport = p ? p.getViewport({ scale }) : last;
      const ps = this.createPage(n, viewport);
      if (!p) this.markUnreadable(ps);
      this.pages.push(ps);
      last = viewport;
    }
    if (this.closed) return;
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const n = Number((e.target as HTMLElement).dataset.page);
          if (e.isIntersecting) {
            this.intersecting.add(n);
            void this.renderPage(n);
          } else {
            this.intersecting.delete(n);
          }
        }
        this.releaseFarPages();
      },
      { root: this.scroller, rootMargin: '1000px 0px' },
    );
    this.pages.forEach((p) => this.observer!.observe(p.el));
    this.baseWidth = base.width;
    this.baseHeight = base.height;
    this.scale = scale;
    this.placePages();
    // Read after the pages are in: a vertical scrollbar they bring in must not look like a resize to
    // the ResizeObserver's first callback (pages keep >= 33px of the 48px gutter, so no overflow).
    this.fitWidth = this.scroller.clientWidth;
    this.fitHeight = this.scroller.clientHeight;
    // A margin width that changed while the pages loaded: fit again now (fit modes only).
    if (typeof this.zoom !== 'number') {
      const target = this.targetScale();
      if (target !== this.scale) this.relayout(target);
    }
    this.bindEvents();
    this.observeResize();
    this.queueLayout();
    this.emitZoom();
    if (at && at.kind === 'pdf') await this.goTo(at);
  }

  async goTo(location: Location, opts: GoToOptions = {}): Promise<void> {
    if (location.kind !== 'pdf') return;
    const ps = this.pages[location.value.page - 1];
    if (!ps) return;
    await this.waitRendered(ps);
    if (this.closed || opts.superseded?.()) return;
    const v = location.value;
    // Rects and the page box are read together, before scrolling moves both.
    const pageRect = ps.el.getBoundingClientRect();
    const rects = ps.ready && v.end > v.start ? this.rectsFor(ps, v) : [];
    const band = rects.length === 0 && isPdfPoint(location) ? this.pointBand(ps, v, pageRect) : null;
    const marks = band ? [band] : rects;
    const within = marks.length ? marks[0].top - pageRect.top - this.scroller.clientHeight / 3 : 0;
    this.scroller.scrollTop = ps.el.offsetTop + Math.max(0, within);
    if (!opts.flash) return;
    if (marks.length) {
      const flashes = marks.map((r) => this.placeRect('hl-flash', r, pageRect));
      flashes.forEach((f) => ps.hlLayer.appendChild(f));
      this.later(() => flashes.forEach((f) => f.remove()), 1300);
    } else {
      this.flashPage(ps);
    }
  }

  onSelection(cb: (sel: SelectionInfo | null) => void): Unsubscribe {
    return this.selectionEm.on(cb);
  }
  onLocationChange(cb: (loc: Location) => void): Unsubscribe {
    return this.locationEm.on(cb);
  }
  onHighlightClick(cb: (hit: { id: string; rect: DOMRect }) => void): Unsubscribe {
    return this.clickEm.on(cb);
  }
  onAnchorMismatch(cb: (a: PaintableAnnotation) => void): Unsubscribe {
    return this.mismatchEm.on(cb);
  }

  /**
   * Page boxes are read only while someone listens (queueLayout skips the per-page offset reads with no
   * listener), so a new subscriber gets the current layout right away, once the book is open.
   */
  onPageLayout(cb: (layout: PageLayout) => void): Unsubscribe {
    const off = this.layoutEm.on(cb);
    if (this.baseWidth && !this.closed) {
      try {
        cb(this.readLayout());
      } catch (err) {
        console.error('PdfRenderer: page-layout listener threw', err);
      }
    }
    return off;
  }

  onZoomChange(cb: (zoom: ZoomState) => void): Unsubscribe {
    return this.zoomEm.on(cb);
  }

  marginLayer(): HTMLElement {
    return this.marginEl;
  }

  setMarginWidth(px: number): void {
    const width = Number.isFinite(px) ? Math.max(0, Math.round(px)) : 0;
    if (this.closed || width === this.marginWidth) return;
    this.marginWidth = width;
    // Before open, open() fits with it. After: the scroller's own size didn't change, so the
    // ResizeObserver won't re-fit; a fit mode re-fits here, a fixed percentage keeps its scale.
    if (!this.baseWidth) return;
    // Hidden (0 wide or high): no fit now. fitWidth 0 makes the ResizeObserver re-fit once it shows.
    if (this.scroller.clientWidth <= 0 || this.scroller.clientHeight <= 0) {
      this.fitWidth = 0;
      return;
    }
    this.fitWidth = this.scroller.clientWidth;
    this.fitHeight = this.scroller.clientHeight;
    if (typeof this.zoom !== 'number') {
      this.relayout(this.targetScale());
      this.emitZoom();
    }
    // The lane makes room for the column on its right (pageLane), whatever the zoom; a fit relayout has
    // placed them already, a fixed percentage is placed here.
    this.placePages();
    this.queueLayout(); // the pages moved sideways either way
  }

  anchorPoints(locations: readonly Location[]): (AnchorPoint | null)[] {
    if (this.closed || !this.baseWidth) return locations.map(() => null);
    // One page box per page, however many thoughts sit on it (lines are cached on the page).
    const pageRects = new Map<number, DOMRect>();
    return locations.map((loc) => {
      if (loc.kind !== 'pdf') return null;
      const ps = this.pages[loc.value.page - 1];
      if (!ps) return null;
      const box = { top: ps.el.offsetTop, left: ps.el.offsetLeft, width: ps.el.offsetWidth, height: ps.el.offsetHeight };
      const key = serializeLocation(loc);
      const measure = ps.ready ? this.measureAnchor(ps, loc.value, pageRects) : null;
      const a = anchorFor(box, loc.value, measure, this.anchorCache.get(key) ?? null);
      // Remember where it was measured, so a zoom's re-render doesn't send its note to the page top.
      if (a.measured && box.width > 0 && box.height > 0) {
        this.anchorCache.set(key, { fy: (a.top - box.top) / box.height, fx: (a.x - box.left) / box.width });
      }
      return a;
    });
  }

  setActiveHighlight(id: string | null): void {
    if (this.closed || id === this.activeId) return;
    this.activeId = id;
    this.refreshHighlightState();
  }

  pageSize(): { width: number; height: number } | null {
    return this.baseWidth ? { width: this.baseWidth, height: this.baseHeight } : null;
  }

  getZoom(): ZoomState {
    // Before open a fixed percentage is already its own answer; a fit mode's isn't known yet.
    const percent = !this.baseWidth && typeof this.zoom === 'number' ? this.zoom : percentOf(this.scale);
    return { zoom: this.zoom, percent };
  }

  setZoom(zoom: Zoom, opts: { anchor?: { clientX: number; clientY: number } } = {}): void {
    if (this.closed || (typeof zoom === 'number' && !Number.isFinite(zoom))) return;
    // An explicit choice (⌘0, ⌘+/⌘−, the menu) wins over a pinch still waiting to be applied.
    this.cancelPinch();
    this.applyZoom(zoom, opts.anchor);
  }

  /** setZoom without cancelling a pending pinch: the pinch applier's path. */
  private applyZoom(zoom: Zoom, anchor?: { clientX: number; clientY: number }): void {
    if (this.closed || (typeof zoom === 'number' && !Number.isFinite(zoom))) return;
    this.zoom = typeof zoom === 'number' ? clampZoom(zoom) : zoom;
    if (!this.baseWidth) {
      // open() lays out at this zoom and emits then. A fit mode's percentage isn't known before that,
      // so only a fixed one (whose percentage is itself) is reported now.
      if (typeof this.zoom === 'number') this.emitZoom();
      return;
    }
    this.fitWidth = this.scroller.clientWidth;
    this.fitHeight = this.scroller.clientHeight;
    this.relayout(this.targetScale(), anchor);
    this.emitZoom();
  }

  pageCount(): number {
    return this.baseWidth ? this.pages.length : 0;
  }

  getOutline(): Promise<OutlineEntry[]> {
    const doc = this.doc;
    if (!doc || this.closed) return Promise.resolve([]);
    if (!this.outline) {
      const p = (async (): Promise<OutlineEntry[]> => {
        try {
          const raw = await this.guard(doc.getOutline());
          if (raw === CLOSED || this.closed) return [];
          const tree = await normalizeOutline(doc, raw);
          // Closed mid-resolution: every lookup failed with the worker, so the tree is all null pages.
          return this.closed ? [] : tree;
        } catch (err) {
          // Closing is not a failure: the reader is gone and nothing waits on a real outline.
          if (this.closed) return [];
          throw err;
        }
      })();
      this.outline = p;
      p.catch((err) => {
        console.warn('PdfRenderer: could not read the outline', err);
        if (this.outline === p) this.outline = null;
      });
    }
    return this.outline;
  }

  async quoteAt(location: Location): Promise<string | null> {
    const spot = location.kind === 'pdf' ? spotOf(location) : null;
    if (!spot || spot.start >= spot.end) return null;
    const text = await this.getPageText(spot.page);
    return spot.end <= text.length ? text.slice(spot.start, spot.end) : null;
  }

  async getPageText(page: number): Promise<string> {
    const doc = this.doc;
    if (!doc || this.closed) throw new Error('PdfRenderer: closed');
    if (page < 1 || page > doc.numPages) throw new Error(`PdfRenderer: no page ${page}`);
    const t = await this.pageText(doc, page);
    if (t === CLOSED) throw new Error('PdfRenderer: closed');
    return t;
  }

  pointAt(clientY: number, page: number): Location | null {
    const ps = this.pages[page - 1];
    // Not rendered: the lines (and whether the page has text at all) are unknown. Never guess.
    if (!ps || this.closed || !ps.ready) return null;
    const box = ps.el.getBoundingClientRect();
    if (box.height <= 0) return null;
    const line = nearestLine(this.pageLines(ps, box), clientY - box.top);
    // No line on a rendered page = no text layer (a scanned page): the point keeps only its height.
    const y = round4(clamp((line ? line.top : clientY - box.top) / box.height, 0, 1));
    return pdfPoint(page, line ? line.start : 0, y);
  }

  async readingLinePoint(): Promise<Location | null> {
    if (!this.baseWidth || this.closed) return null;
    let ps = this.probePage();
    // The reader may scroll (or a zoom re-lay out) while the page renders: re-probe, and wait for the
    // new page once more. Still moving after that: no point rather than one on the wrong page.
    for (let attempt = 0; attempt < 2 && ps; attempt++) {
      await this.waitRendered(ps);
      if (this.closed) return null;
      const now = this.probePage();
      if (now === ps) {
        if (!ps.ready) return null;
        const box = ps.el.getBoundingClientRect();
        const lineY = this.scroller.getBoundingClientRect().top + this.scroller.clientHeight / 3;
        return this.pointAt(clamp(lineY, box.top, box.bottom), ps.page);
      }
      ps = now;
    }
    return null;
  }

  paintHighlights(annotations: PaintableAnnotation[]): void {
    this.annotations = annotations;
    for (const ps of this.pages) {
      if (!ps.ready) continue;
      this.paintPage(ps);
      this.checkAnchors(ps);
    }
  }

  async findQuote(quote: string, near?: Location | null): Promise<Location | null> {
    const doc = this.doc;
    if (!doc || this.closed) return null;
    if (!quote.trim()) return null;
    // Nearest-to-hint first, fetching text lazily; stop at the first hit.
    for (const n of pageOrder(doc.numPages, near?.kind === 'pdf' ? near.value.page : undefined)) {
      let text: string | typeof CLOSED;
      try {
        text = await this.pageText(doc, n);
      } catch (err) {
        if (this.closed) return null;
        console.warn(`PdfRenderer: could not read text of page ${n}`, err);
        continue;
      }
      if (text === CLOSED || this.closed) return null;
      const v = findQuoteInPage(text, quote);
      if (v) return pdfLocation({ page: n, ...v });
    }
    return null;
  }

  search(query: string, opts: { signal?: AbortSignal; fromPage?: number } = {}): AsyncIterable<SearchBatch> {
    const doc = this.doc;
    if (!doc || this.closed) return searchPages([], async () => null, query);
    // Through pageText: rendered pages come from textCache, the rest share one fetch per page.
    const getText = async (n: number) => {
      const t = await this.pageText(doc, n);
      return t === CLOSED || this.closed ? null : t;
    };
    return searchPages(wrapOrder(doc.numPages, opts.fromPage ?? this.currentPage), getText, query, opts.signal);
  }

  showSearchHits(hits: readonly SearchHit[], current: SearchHit | null): void {
    const byPage = new Map<number, SearchHit[]>();
    for (const h of hits) {
      const list = byPage.get(h.page);
      if (list) list.push(h);
      else byPage.set(h.page, [h]);
    }
    this.searchHits = byPage;
    this.currentHit = current;
    for (const ps of this.pages) if (ps.ready) this.paintSearch(ps);
  }

  clearSearch(): void {
    this.showSearchHits([], null);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.observer?.disconnect();
    this.cleanup.forEach((f) => f());
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    for (const ps of this.pages) {
      try {
        ps.task?.cancel();
      } catch {
        // already finished
      }
      ps.task = null;
      ps.textTask?.cancel();
      ps.textTask = null;
    }
    this.selectionEm.clear();
    this.locationEm.clear();
    this.clickEm.clear();
    this.mismatchEm.clear();
    this.layoutEm.clear();
    this.zoomEm.clear();
    this.outline = null;
    this.anchorCache.clear();
    const doc = this.doc;
    this.doc = null;
    doc?.destroy().catch(() => {});
    // Document still loading: destroy the loading task so the worker is released.
    this.loading?.destroy().catch(() => {});
    this.loading = null;
    this.scroller.remove();
  }

  // ---- internals ----

  /** Awaits p; if it rejects after close() (e.g. "Worker was destroyed") resolves CLOSED instead. */
  private async guard<T>(p: Promise<T>): Promise<T | typeof CLOSED> {
    try {
      return await p;
    } catch (err) {
      if (this.closed) return CLOSED;
      throw err;
    }
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private markUnreadable(ps: PageState): void {
    ps.unreadable = true;
    ps.el.classList.add('is-unreadable');
    const note = document.createElement('div');
    note.className = 'pdf-page-note';
    note.textContent = `Page ${ps.page} couldn’t be read.`;
    ps.el.append(note);
  }

  private createPage(page: number, viewport: Viewport): PageState {
    const el = document.createElement('div');
    el.className = 'pdf-page';
    el.dataset.page = String(page);
    this.sizePage(el, viewport);
    const hlLayer = document.createElement('div');
    hlLayer.className = 'hl-layer';
    const searchLayer = document.createElement('div');
    searchLayer.className = 'search-layer';
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    el.append(hlLayer, searchLayer, textLayer);
    // Pages go before the margin layer: screen readers reach the page text first, then the notes
    // The layer is absolutely placed at the scroller's top left, and its z-index 3 is above the page
    // layers' 1–2 (pages make no stacking context), so the order changes nothing on screen.
    this.scroller.insertBefore(el, this.marginEl);
    return {
      page,
      el,
      hlLayer,
      searchLayer,
      textLayer,
      viewport,
      rendering: null,
      task: null,
      textTask: null,
      canvas: null,
      gen: 0,
      ready: false,
      lines: null,
      hlBoxes: [],
    };
  }

  /** Sizes a page box and sets the CSS variables pdf.js's text layer reads for this viewport (the fixed ones are on `.pdf-page` in pdf.css). */
  private sizePage(el: HTMLDivElement, viewport: Viewport): void {
    el.style.width = `${viewport.width}px`;
    el.style.height = `${viewport.height}px`;
    el.style.setProperty('--scale-factor', String(viewport.scale));
    el.style.setProperty('--total-scale-factor', String(viewport.scale));
  }

  /**
   * Re-fits on scroller width changes (notebook open/close/resize), debounced. Installed at the end of
   * open(), so it never sees a half-built page list; torn down by close() via cleanup.
   */
  private observeResize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let burstStart = 0;
    const ro = new ResizeObserver(() => {
      // The pages follow the width at once (a cheap write per page), and so does the margin column (the
      // layout is re-emitted when they moved); the re-fit waits for the burst to settle.
      if (!this.closed && this.placePages()) this.queueLayout();
      if (timer !== undefined) clearTimeout(timer);
      else burstStart = performance.now();
      timer = setTimeout(() => {
        timer = undefined;
        this.refit(burstStart);
      }, RESIZE_SETTLE_MS);
    });
    ro.observe(this.scroller);
    this.cleanup.push(() => {
      ro.disconnect();
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  /**
   * Scroller resized (notebook/contents opened or dragged, window resized): re-fit a fit-mode zoom.
   * A fixed percentage keeps its scale; the scroller just shows more or less of the pages.
   */
  private refit(resizedAt: number): void {
    if (this.closed || !this.baseWidth) return;
    // Hidden, jitter, a scrollbar-toggle reversal, a fixed % or an unchanged scale: see decideRefit.
    const d = decideRefit({
      width: this.scroller.clientWidth,
      height: this.scroller.clientHeight,
      fitWidth: this.fitWidth,
      fitHeight: this.fitHeight,
      zoom: this.zoom,
      scale: this.scale,
      target: this.targetScale(),
      lastChange: this.lastChange,
      resizedAt,
      now: performance.now(),
      windowMs: RESIZE_SETTLE_MS,
    });
    if (d.action === 'keep') return;
    this.fitWidth = d.fitWidth;
    this.fitHeight = d.fitHeight;
    this.lastChange = d.lastChange;
    if (d.action === 'layout') {
      this.placePages();
      this.queueLayout(); // centred pages moved sideways
      return;
    }
    this.relayout(d.scale);
    this.emitZoom();
  }

  /** The scale the current zoom mode asks for in the current scroller. */
  private targetScale(pageWidth = this.baseWidth, pageHeight = this.baseHeight): number {
    return scaleFor(
      this.zoom,
      fitArea(this.scroller.clientWidth, this.scroller.clientHeight, this.marginWidth),
      { width: pageWidth, height: pageHeight },
    );
  }

  /**
   * Re-lays out every page at `scale`, keeping the reading line (or `anchor`, e.g. the pinch point) on
   * the same spot of the same page. Rendered content is released (gen bump makes in-flight renders
   * bail) and the visible pages render again; textCache and stored offsets are scale-independent and
   * stay. Used by both the resize re-fit and zoom.
   */
  private relayout(scale: number, anchor?: { clientX: number; clientY: number }): void {
    if (scale === this.scale) return;
    const sc = this.scroller.getBoundingClientRect();
    const anchorY = anchor ? anchor.clientY - sc.top : this.scroller.clientHeight / 3;
    const anchorX = anchor ? anchor.clientX - sc.left : this.scroller.clientWidth / 2;
    this.scale = scale;
    // The text layers are about to be cleared, taking any selection with them: close its popover.
    this.selectionEm.emit(null);
    const pos = captureAt(this.pageBoxes(), this.scroller.scrollTop, anchorY);
    // Horizontally, the anchor is held across the page under it (not the scroll width), so a centred
    // page zoomed into an overflowing one keeps the point under the pointer.
    const anchorPage = this.pages[Math.min(pos.index, this.pages.length - 1)];
    const span = () => ({ left: anchorPage.el.offsetLeft, width: anchorPage.el.offsetWidth });
    const fx = anchorPage ? captureX(span(), this.scroller.scrollLeft, anchorX) : 0.5;
    for (const ps of this.pages) {
      this.releasePage(ps);
      ps.viewport = ps.viewport.clone({ scale });
      this.sizePage(ps.el, ps.viewport);
    }
    // Placed before the scroll is restored: the anchor page's new left edge is part of where it lands.
    this.placePages();
    this.scroller.scrollTop = restoreAt(pos, this.pageBoxes(), anchorY);
    this.scroller.scrollLeft = anchorPage ? restoreX(fx, span(), anchorX) : 0;
    // The observer only reports changes, so pages that stay intersecting need an explicit render.
    const current = this.probePage()?.page ?? this.currentPage;
    const want = new Set([current - 1, current, current + 1, ...this.intersecting]);
    for (const n of this.pins.keys()) want.add(n);
    for (const n of want) void this.renderPage(n);
    this.queueLayout();
  }

  /**
   * Places the pages across the scroller (pageLane): page 1's width at the current scale is the lane,
   * each page is centred on it, and the extent strut sets the scroll width, so a lane wider than the
   * scroller scrolls to both sides. Runs whenever the scale, the scroller's width or the margin reserve
   * changes; writes only what changed, and says whether anything did (a page or the scroll width).
   * Hidden (0 wide): nothing, the ResizeObserver places them on show.
   */
  private placePages(): boolean {
    const first = this.pages[0];
    const width = this.scroller.clientWidth;
    if (!first || width <= 0) return false;
    const laneWidth = first.viewport.width;
    const lane = pageLane(width, laneWidth, this.marginWidth);
    let changed = false;
    for (const ps of this.pages) {
      const left = `${pageLeft(lane.left, laneWidth, ps.viewport.width)}px`;
      if (ps.el.style.marginLeft !== left) {
        ps.el.style.marginLeft = left;
        changed = true;
      }
    }
    const extent = `${lane.extent}px`;
    if (this.extentEl.style.width !== extent) {
      this.extentEl.style.width = extent;
      changed = true;
    }
    return changed;
  }

  private emitZoom(): void {
    this.zoomEm.emit(this.getZoom());
  }

  private pageBoxes() {
    return this.pages.map((p) => ({ top: p.el.offsetTop, height: p.el.offsetHeight }));
  }

  /** Never rejects: failures are logged and leave the page unrendered (retried on next intersection). */
  private renderPage(n: number): Promise<void> {
    const ps = this.pages[n - 1];
    if (!ps || !this.doc || this.closed) return Promise.resolve();
    if (!ps.rendering) ps.rendering = this.doRender(ps, this.doc);
    return ps.rendering;
  }

  private async doRender(ps: PageState, doc: PDFDocumentProxy): Promise<void> {
    const gen = ps.gen;
    // Closed, or released by releasePage (which already reset this page's state): touch nothing.
    const stale = () => this.closed || ps.gen !== gen;
    if (ps.unreadable) return;
    try {
      const page = await doc.getPage(ps.page);
      if (stale()) return;
      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(ps.viewport.width * dpr);
      canvas.height = Math.floor(ps.viewport.height * dpr);
      canvas.style.width = `${ps.viewport.width}px`;
      canvas.style.height = `${ps.viewport.height}px`;
      ps.canvas = canvas;
      // null when WebKit refuses a new canvas backing store (memory cap): a render failure.
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context unavailable');
      ps.el.prepend(canvas);
      const task = page.render({
        canvas,
        canvasContext: ctx,
        viewport: ps.viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      ps.task = task;
      await task.promise;
      if (stale()) return;
      ps.task = null;
      const textLayer = new (pdfjs().TextLayer)({
        textContentSource: page.streamTextContent(),
        container: ps.textLayer,
        viewport: ps.viewport,
      });
      ps.textTask = textLayer;
      await textLayer.render();
      if (stale()) return;
      ps.textTask = null;
    } catch (err) {
      if (stale()) return;
      ps.task = null;
      ps.textTask = null;
      this.dropCanvas(ps);
      ps.textLayer.replaceChildren();
      ps.rendering = null;
      ps.ready = false;
      if (!(err instanceof pdfjs().RenderingCancelledException)) {
        console.warn(`PdfRenderer: failed to render page ${ps.page}`, err);
      }
      return;
    }
    ps.lines = null;
    ps.ready = true;
    try {
      this.textCache.set(ps.page, indexText(ps.textLayer).text);
      this.paintPage(ps);
      this.paintSearch(ps);
      this.checkAnchors(ps);
    } catch (err) {
      // Page rendered fine; a throwing consumer must not unrender it or reject renderPage.
      console.warn(`PdfRenderer: post-render step failed on page ${ps.page}`, err);
    }
    this.queueLayout();
  }

  /**
   * Releases pages outside the observer margin and more than KEEP_RENDERED_RADIUS from the current page.
   * Runs on observer events and on current-page changes: a page that left the margin while still near
   * gets no further observer event, so the sweep on scroll is what eventually frees it.
   */
  private releaseFarPages(): void {
    const current = this.probePage()?.page ?? this.currentPage;
    for (const ps of this.pages) {
      if (this.pins.has(ps.page) || this.intersecting.has(ps.page)) continue;
      if (Math.abs(ps.page - current) <= KEEP_RENDERED_RADIUS) continue;
      this.releasePage(ps);
    }
  }

  /** Releases a rendered (or rendering) page's canvas and layers; it renders again on re-entry. textCache stays. */
  private releasePage(ps: PageState): void {
    if (!ps.rendering && !ps.ready && !ps.canvas) return;
    ps.gen++;
    try {
      ps.task?.cancel();
    } catch {
      // already finished
    }
    ps.task = null;
    ps.textTask?.cancel();
    ps.textTask = null;
    this.dropCanvas(ps);
    ps.textLayer.replaceChildren();
    const hadHover = this.hoverId !== null && ps.hlBoxes.some((b) => b.id === this.hoverId);
    ps.hlLayer.replaceChildren();
    ps.searchLayer.replaceChildren();
    delete ps.searchLayer.dataset.key;
    ps.lines = null;
    ps.hlBoxes = [];
    // The hovered highlight lived on this page: nothing paints it now, so nothing can un-hover it.
    if (this.hoverId !== null && hadHover) this.setHover(null);
    ps.ready = false;
    ps.rendering = null;
    this.queueLayout();
  }

  private dropCanvas(ps: PageState): void {
    const c = ps.canvas;
    if (!c) return;
    // Zero the backing store so WebKit frees it now rather than at GC.
    c.width = 0;
    c.height = 0;
    c.remove();
    ps.canvas = null;
  }

  /**
   * Page text as the text layer would index it. Concurrent calls share one fetch; a fetch that ends
   * CLOSED or with an error is not kept, so a later call retries.
   */
  private pageText(doc: PDFDocumentProxy, n: number): Promise<string | typeof CLOSED> {
    const cached = this.textCache.get(n);
    if (cached !== undefined) return Promise.resolve(cached);
    let p = this.textFetches.get(n);
    if (!p) {
      const req = this.fetchPageText(doc, n);
      const drop = () => {
        if (this.textFetches.get(n) === req) this.textFetches.delete(n);
      };
      req.then((t) => t === CLOSED && drop(), drop);
      this.textFetches.set(n, req);
      p = req;
    }
    return p;
  }

  private async fetchPageText(doc: PDFDocumentProxy, n: number): Promise<string | typeof CLOSED> {
    const page = await this.guard(doc.getPage(n));
    if (page === CLOSED || this.closed) return CLOSED;
    const content = await this.guard(page.getTextContent());
    if (content === CLOSED || this.closed) return CLOSED;
    const text = joinTextItems(content.items);
    this.textCache.set(n, text);
    return text;
  }

  private rectsFor(ps: PageState, v: PdfLocationValue): DOMRect[] {
    const range = offsetsToRange(ps.textLayer, v.start, v.end);
    if (!range) return [];
    return Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  }

  /** Page-relative measurements of a location on a rendered page, sharing page boxes per call. */
  private measureAnchor(ps: PageState, v: PdfLocationValue, pageRects: Map<number, DOMRect>): AnchorMeasure {
    let page = pageRects.get(ps.page);
    if (!page) {
      page = ps.el.getBoundingClientRect();
      pageRects.set(ps.page, page);
    }
    if (v.end > v.start) {
      const end = firstLineEnd(this.rectsFor(ps, v));
      return { highlight: end && { top: end.top - page.top, right: end.right - page.left }, lineTop: null };
    }
    // A page-level location (offset 0, no y) has no line of its own.
    if (v.start === 0 && v.y === undefined) return { highlight: null, lineTop: null };
    const lines = this.pageLines(ps, page);
    const line = lineAtOffset(lines, v.start) ?? lines[0] ?? null;
    return { highlight: null, lineTop: line ? line.top : null };
  }

  /**
   * The page's text lines relative to its top: measured once per render (every span's box is read) and
   * reused by pointAt (the margin "+" calls it on mousemove), anchorPoints and point flashes.
   */
  private pageLines(ps: PageState, box: DOMRect = ps.el.getBoundingClientRect()): LineBox[] {
    if (!ps.lines) {
      ps.lines = measureLines(ps.textLayer).map((l) => ({ start: l.start, top: l.top - box.top, bottom: l.bottom - box.top }));
    }
    return ps.lines;
  }

  private placeRect(className: string, r: DOMRect, pageRect: DOMRect): HTMLDivElement {
    const d = document.createElement('div');
    d.className = className;
    d.style.left = `${r.left - pageRect.left}px`;
    d.style.top = `${r.top - pageRect.top}px`;
    d.style.width = `${r.width}px`;
    d.style.height = `${r.height}px`;
    return d;
  }

  /**
   * Renders `ps` and waits for it, pinned against the far-page release sweep (the target is usually
   * off-screen until we scroll). A re-fit mid-await releases and re-renders the page (new
   * ps.rendering): wait for that one too. Shared by goTo and readingLinePoint.
   */
  private async waitRendered(ps: PageState): Promise<void> {
    this.pins.set(ps.page, (this.pins.get(ps.page) ?? 0) + 1);
    try {
      let r: Promise<void>;
      do {
        r = this.renderPage(ps.page);
        await r;
      } while (!this.closed && !ps.ready && ps.rendering !== null && ps.rendering !== r);
    } finally {
      const left = (this.pins.get(ps.page) ?? 1) - 1;
      if (left > 0) this.pins.set(ps.page, left);
      else this.pins.delete(ps.page);
    }
  }

  /** A full-width band at a point location's line, or at its `y` on a page without text. */
  private pointBand(ps: PageState, v: PdfLocationValue, page: DOMRect): DOMRect | null {
    const lines = ps.ready ? this.pageLines(ps, page) : [];
    const line = lineAtOffset(lines, v.start) ?? lines[0] ?? null;
    if (line) return new DOMRect(page.left, page.top + line.top, page.width, line.bottom - line.top);
    if (v.y === undefined) return null;
    return new DOMRect(page.left, page.top + v.y * page.height, page.width, POINT_BAND_PX);
  }

  /** A soft glow around the whole page: the flash for page-level jumps (contents, page thoughts). */
  private flashPage(ps: PageState): void {
    ps.el.classList.remove('is-flashing');
    void ps.el.offsetWidth; // restart the animation
    ps.el.classList.add('is-flashing');
    this.later(() => ps.el.classList.remove('is-flashing'), 1300);
  }

  /**
   * Emits the page boxes once per microtask, however many changes queued it. With no listener it does
   * nothing (the offset reads force layout); onPageLayout hands a new listener the current boxes.
   */
  private queueLayout(): void {
    if (this.layoutQueued || this.closed || this.layoutEm.size === 0) return;
    this.layoutQueued = true;
    queueMicrotask(() => {
      this.layoutQueued = false;
      if (this.closed || this.layoutEm.size === 0) return;
      this.layoutEm.emit(this.readLayout());
    });
  }

  private readLayout(): PageLayout {
    return {
      scale: this.scale,
      fitRight: this.scroller.clientWidth - this.marginWidth,
      pages: this.pages.map((p) => ({
        page: p.page,
        top: p.el.offsetTop,
        left: p.el.offsetLeft,
        width: p.el.offsetWidth,
        height: p.el.offsetHeight,
        ready: p.ready,
      })),
    };
  }

  private paintPage(ps: PageState): void {
    ps.hlLayer.querySelectorAll('.hl').forEach((n) => n.remove());
    const hoverWasHere = this.hoverId !== null && ps.hlBoxes.some((b) => b.id === this.hoverId);
    ps.hlBoxes = [];
    const pageRect = ps.el.getBoundingClientRect();
    for (const a of this.annotations) {
      if (a.unanchored || a.location.kind !== 'pdf' || a.location.value.page !== ps.page) continue;
      const state = { hover: a.id === this.hoverId, active: a.id === this.activeId, fresh: !!a.fresh };
      this.rectsFor(ps, a.location.value).forEach((r, i) => {
        const d = this.placeRect(highlightClass(a.color, state), r, pageRect);
        d.dataset.id = a.id;
        // A new highlight inks in line by line.
        if (a.fresh) d.style.setProperty('--i', String(i));
        ps.hlLayer.appendChild(d);
        ps.hlBoxes.push({
          id: a.id,
          left: r.left - pageRect.left,
          top: r.top - pageRect.top,
          right: r.right - pageRect.left,
          bottom: r.bottom - pageRect.top,
        });
      });
    }
    // The hovered highlight is gone from this page (deleted, or its page changed): drop the hover.
    if (this.hoverId !== null && !ps.hlBoxes.some((b) => b.id === this.hoverId) && hoverWasHere) this.setHover(null);
  }

  /**
   * The highlight rect under (x, y) on the page holding `target`; null off a highlight or on an unrendered
   * page. Runs on every mousemove: one page box read, the rects come from hlBoxes.
   */
  private highlightAt(target: EventTarget | null, x: number, y: number): { id: string; rect: DOMRect } | null {
    const pageEl = target instanceof Element ? target.closest<HTMLElement>('.pdf-page') : null;
    const ps = pageEl ? this.pages[Number(pageEl.dataset.page) - 1] : undefined;
    if (!ps?.ready || ps.hlBoxes.length === 0) return null;
    const page = ps.el.getBoundingClientRect();
    const i = hitIndex(ps.hlBoxes, x - page.left, y - page.top);
    if (i < 0) return null;
    const b = ps.hlBoxes[i];
    return { id: b.id, rect: new DOMRect(page.left + b.left, page.top + b.top, b.right - b.left, b.bottom - b.top) };
  }

  private setHover(id: string | null): void {
    if (id === this.hoverId) return;
    this.hoverId = id;
    if (id) this.scroller.dataset.hlHover = '';
    else delete this.scroller.dataset.hlHover;
    this.refreshHighlightState();
  }

  /** Re-applies hover/active to the painted rects (no repaint: their places don't change). */
  private refreshHighlightState(): void {
    for (const ps of this.pages) {
      if (!ps.ready) continue;
      ps.hlLayer.querySelectorAll<HTMLElement>('.hl').forEach((d) => {
        d.classList.toggle('is-hover', d.dataset.id === this.hoverId);
        d.classList.toggle('is-active', d.dataset.id === this.activeId);
      });
    }
  }

  /**
   * Paints this page's search hits. Skips the DOM work when the page's hits and current hit are
   * unchanged, so streaming more results doesn't restart the current hit's pulse.
   */
  private paintSearch(ps: PageState): void {
    const hits = this.searchHits.get(ps.page) ?? [];
    const key = hits.map((h) => `${h.start}-${h.end}${sameHit(h, this.currentHit) ? '*' : ''}`).join(',');
    if ((ps.searchLayer.dataset.key ?? '') === key) return;
    ps.searchLayer.dataset.key = key;
    ps.searchLayer.replaceChildren();
    const pageRect = ps.el.getBoundingClientRect();
    for (const h of hits) {
      const cls = sameHit(h, this.currentHit) ? 'search-hit is-current' : 'search-hit';
      for (const r of this.rectsFor(ps, h)) ps.searchLayer.appendChild(this.placeRect(cls, r, pageRect));
    }
  }

  private checkAnchors(ps: PageState): void {
    const text = this.textCache.get(ps.page) ?? '';
    for (const a of this.annotations) {
      if (a.unanchored || a.location.kind !== 'pdf' || a.location.value.page !== ps.page) continue;
      const v = a.location.value;
      const key = `${a.id}:${v.page}:${v.start}:${v.end}`;
      if (this.checked.has(key)) continue;
      this.checked.add(key);
      if (!quoteMatches(text, v.start, v.end, a.quote)) this.mismatchEm.emit(a);
    }
  }

  private bindEvents(): void {
    // Throttled, not debounced: the page number and progress follow a long scroll as it happens
    // (a debounce only fired once the scroll stopped), and a trailing run catches the final page.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    const onScroll = () => {
      const wait = SCROLL_PAGE_MS - (Date.now() - last);
      if (wait <= 0) {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        last = Date.now();
        this.updateCurrentPage();
        return;
      }
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          last = Date.now();
          this.updateCurrentPage();
        }, wait);
      }
    };
    // Only the main button selects: a right-click's mouseup (its menu is open by then) must not bring the
    // selection popover up over that menu.
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      this.later(() => this.emitSelection(), 0);
    };
    const onClick = (e: MouseEvent) => this.handleClick(e);
    // Hovering a highlight shows its full fill (spec §5.3); left alone while a selection is being dragged.
    const onHover = (e: MouseEvent) => {
      if (e.buttons !== 0) return;
      this.setHover(this.highlightAt(e.target, e.clientX, e.clientY)?.id ?? null);
    };
    const onLeave = () => this.setHover(null);

    // Trackpad pinch: Chromium-style ctrl+wheel and WebKit gesture events. Applied at most every
    // PINCH_APPLY_MS around the pointer; intermediate steps accumulate unrounded (applyZoom rounds).
    type Anchor = { clientX: number; clientY: number };
    let pinch: { percent: number; at?: Anchor } | null = null;
    let pinchTimer: ReturnType<typeof setTimeout> | undefined;
    // The unrounded percentage the last application asked for: while the zoom is still that (rounded),
    // the next step continues from it, so slow pinches don't lose their fraction at every application.
    let pinchLast: number | null = null;
    const applyPinch = () => {
      pinchTimer = undefined;
      const p = pinch;
      pinch = null;
      if (!p) return;
      pinchLast = p.percent;
      this.applyZoom(p.percent, p.at);
    };
    const pinchBase = () => {
      if (pinch) return pinch.percent;
      const now = percentOf(this.scale);
      return pinchLast !== null && typeof this.zoom === 'number' && clampZoom(pinchLast) === now ? pinchLast : now;
    };
    this.cancelPinch = () => {
      if (pinchTimer !== undefined) clearTimeout(pinchTimer);
      pinchTimer = undefined;
      pinch = null;
      pinchLast = null;
    };
    const queuePinch = (percent: number, at?: Anchor) => {
      pinch = { percent, at };
      if (pinchTimer === undefined) pinchTimer = setTimeout(applyPinch, PINCH_APPLY_MS);
    };
    // WebKit may report one pinch as both gesture* and ctrl+wheel events: while a gesture is active
    // the wheel events are swallowed, so the zoom isn't applied twice (jitter).
    // A gestureend can go missing (focus lost mid-pinch): the flag also clears GESTURE_STALE_MS after
    // the last gesture event, and on the next pointerdown, so ctrl+wheel zoom can't stay disabled.
    let gestureActive = false;
    let gestureTimer: ReturnType<typeof setTimeout> | undefined;
    const endGesture = () => {
      gestureActive = false;
      if (gestureTimer !== undefined) clearTimeout(gestureTimer);
      gestureTimer = undefined;
    };
    const touchGesture = () => {
      gestureActive = true;
      if (gestureTimer !== undefined) clearTimeout(gestureTimer);
      gestureTimer = setTimeout(endGesture, GESTURE_STALE_MS);
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (gestureActive) return;
      const delta = wheelDeltaPx(e.deltaY, e.deltaMode, this.scroller.clientHeight);
      queuePinch(pinchZoom(pinchBase(), delta), { clientX: e.clientX, clientY: e.clientY });
    };
    let gestureBase = 100;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      touchGesture();
      gestureBase = percentOf(this.scale);
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      endGesture();
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      touchGesture();
      const g = e as Event & { scale?: number; clientX?: number; clientY?: number };
      const at = g.clientX !== undefined && g.clientY !== undefined ? { clientX: g.clientX, clientY: g.clientY } : undefined;
      const scale = g.scale !== undefined && Number.isFinite(g.scale) && g.scale > 0 ? g.scale : 1;
      queuePinch(clamp(gestureBase * scale, ZOOM_MIN, ZOOM_MAX), at);
    };

    this.scroller.addEventListener('scroll', onScroll);
    this.scroller.addEventListener('mouseup', onMouseUp);
    this.scroller.addEventListener('click', onClick);
    this.scroller.addEventListener('wheel', onWheel, { passive: false });
    this.scroller.addEventListener('gesturestart', onGestureStart);
    this.scroller.addEventListener('gesturechange', onGestureChange);
    this.scroller.addEventListener('gestureend', onGestureEnd);
    this.scroller.addEventListener('pointerdown', endGesture);
    this.scroller.addEventListener('mousemove', onHover);
    this.scroller.addEventListener('mouseleave', onLeave);
    this.cleanup.push(() => {
      if (timer !== undefined) clearTimeout(timer);
      if (pinchTimer !== undefined) clearTimeout(pinchTimer);
      if (gestureTimer !== undefined) clearTimeout(gestureTimer);
      this.scroller.removeEventListener('scroll', onScroll);
      this.scroller.removeEventListener('mouseup', onMouseUp);
      this.scroller.removeEventListener('click', onClick);
      this.scroller.removeEventListener('wheel', onWheel);
      this.scroller.removeEventListener('gesturestart', onGestureStart);
      this.scroller.removeEventListener('gesturechange', onGestureChange);
      this.scroller.removeEventListener('gestureend', onGestureEnd);
      this.scroller.removeEventListener('pointerdown', endGesture);
      this.scroller.removeEventListener('mousemove', onHover);
      this.scroller.removeEventListener('mouseleave', onLeave);
    });
  }

  /** The page under the reading probe (a third of the way down the viewport); the last page at the very bottom. */
  private probePage(): PageState | undefined {
    const s = this.scroller;
    const i = readingPageIndex(this.pageBoxes(), s.scrollTop, s.clientHeight, s.scrollHeight);
    return i < 0 ? undefined : this.pages[i];
  }

  private updateCurrentPage(): void {
    const ps = this.probePage();
    this.releaseFarPages();
    if (ps && ps.page !== this.currentPage) {
      this.currentPage = ps.page;
      this.locationEm.emit(pdfLocation({ page: ps.page, start: 0, end: 0 }));
    }
  }

  /**
   * The page text selected right now (read from the live selection, not the last one emitted); null when
   * nothing is selected or the selection isn't in a rendered page's text.
   */
  currentSelection(): SelectionInfo | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const res = rangeToPageOffsets(
      range,
      this.pages.filter((p) => p.ready).map((p) => ({ page: p.page, el: p.textLayer })),
    );
    if (!res) return null;
    return {
      location: pdfLocation({ page: res.page, start: res.start, end: res.end }),
      quote: res.quote,
      rect: range.getBoundingClientRect(),
    };
  }

  private emitSelection(): void {
    this.selectionEm.emit(this.currentSelection());
  }

  private handleClick(e: MouseEvent): void {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const hit = this.highlightAt(e.target, e.clientX, e.clientY);
    if (hit) this.clickEm.emit(hit);
  }
}
