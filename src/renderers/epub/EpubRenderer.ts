import { epubLocation, epubPoint, serializeLocation, spotOf } from '../../lib/location';
import { watchTouchSelection } from '../../lib/touchSelection';
import type { EpubLocationValue, Location, OutlineEntry } from '../../lib/types';
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
import { anchorFor, firstLineEnd, type AnchorFraction, type AnchorMeasure } from '../pdf/anchors';
import { findQuoteInPage, pageOrder, quoteMatches } from '../pdf/findQuote';
import { highlightClass, hitIndex, pencilDefs } from '../pdf/highlightStyle';
import { searchPages, wrapOrder } from '../pdf/search';
import {
  captureAt,
  captureX,
  clamp,
  decideRefit,
  fitArea,
  FIT_GUTTER,
  KEEP_RENDERED_RADIUS,
  pageLane,
  pageLeft,
  POINT_BAND_PX,
  readingLineY,
  readingPageIndex,
  RESIZE_SETTLE_MS,
  restoreAt,
  restoreX,
  SCROLL_PAGE_MS,
  type WidthChange,
} from '../pdf/layout';
import { nearestLine, type LineBox } from '../pdf/lines';
import { indexText, pointToOffset, rangeToPageOffsets, type Segment, type TextIndex } from '../pdf/textOffsets';
import { clampZoom, GESTURE_STALE_MS, percentOf, PINCH_APPLY_MS, pinchZoom, wheelDeltaPx, ZOOM_MAX, ZOOM_MIN } from '../pdf/zoom';
import { bookBudget } from './budget';
import { imageAllowed } from './imageInfo';
import { openEpub, type EpubPackage, type EpubTocEntry } from './epubPackage';
import { sanitizeSection } from './sanitize';
import { scopeCss } from './scopeCss';

/**
 * EPUB as one continuous scroll (spec §B6): every spine section is sanitised into its own page box in
 * the same scroller structure the PDF renderer builds (`.pdf-scroller`, `[data-page]` boxes, the
 * `.pdf-margin` layer), so the margin, focus mode and the ⌥-hover lookup work unchanged. A section is
 * a page with an unusual height: the column is `EPUB_COLUMN` px wide at 100 %, and zoom scales both the
 * column and the font, so lines break the same way at every zoom and offsets never move.
 *
 * Offsets index `indexText(<sanitised section root>).text` (the model `SANITIZER_VERSION` pins).
 * Selection, highlights (the PDF classes, pencil filter and hit test), anchors, quote re-anchoring and
 * search reuse the PDF helpers over that model. Overlay rects come from layout, so a section repaints
 * them after it reflows, and only while it is near the viewport (the image observer's margin): a far
 * section is marked stale and repaints when it comes near.
 */

const FONT_EXT: Record<string, string> = { woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' };

/**
 * The blob type of a zip font: a `font/*` manifest type as is, else the `font/*` type its extension names
 * (`application/x-font-ttf`, `application/vnd.ms-opentype` …), else `application/octet-stream`. Never a
 * non-font type from the manifest.
 */
export function fontBlobType(manifestType: string, path: string): string {
  const t = manifestType.trim().toLowerCase();
  if (/^font\/[a-z0-9.+-]+$/.test(t)) return t;
  return FONT_EXT[/\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/** The column's width at 100 % (CSS px). */
export const EPUB_COLUMN = 680;
/** The base font size at 100 %. */
export const EPUB_FONT_PX = 18;
export const EPUB_LINE = 1.6;
/** `pageSize().height`: the nominal page the margin's room rules read. */
export const EPUB_NOMINAL_HEIGHT = 880;
/** Fit zooms keep the column between these scales: a text column never grows past its readable measure. */
export const FIT_MIN = 0.75;
export const FIT_MAX = 1;
/**
 * A fit zoom on a screen too narrow for the column at FIT_MIN (a phone): the column narrows to the screen
 * instead, less the fit gutter (pageLane keeps half of it on each side), and the text stays at this
 * scale (16 px), with thinner side padding.
 */
export const NARROW_FIT_SCALE = 0.9;
export const NARROW_GUTTER = FIT_GUTTER;
/** The narrow column never gets narrower than this (CSS px). */
export const NARROW_MIN_COLUMN = 240;

/**
 * A fit zoom's layout for a fit area `areaWidth` px wide (fitArea: the scroller less the margin's reserve
 * on both sides): the column at its fitted scale, clamped to FIT_MIN..FIT_MAX; or, when even FIT_MIN
 * would not fit, a narrow column as wide as the area less the fit gutter, with text at NARROW_FIT_SCALE.
 */
export function epubFit(areaWidth: number): { scale: number; column: number; narrow: boolean } {
  const fitted = (areaWidth - FIT_GUTTER) / EPUB_COLUMN;
  if (!(areaWidth > 0) || fitted >= FIT_MIN) {
    const scale = clamp(fitted, FIT_MIN, FIT_MAX);
    return { scale, column: EPUB_COLUMN * scale, narrow: false };
  }
  return { scale: NARROW_FIT_SCALE, column: Math.max(NARROW_MIN_COLUMN, Math.floor(areaWidth - NARROW_GUTTER)), narrow: true };
}
/** Above this many characters, sections far from the reading one skip rendering (`content-visibility`). */
export const LARGE_BOOK_CHARS = 1_500_000;
/** Sections further than this from the reading one are "far" in a large book. */
const FAR_RADIUS = 3;
/** linesNear descends at most this many levels of nested blocks. */
const MAX_BLOCK_DEPTH = 12;
/** A block without text looks at most this many siblings each way for lines. */
const SIBLING_PROBES = 8;
/** charRect looks this far past an offset for a non-blank character. */
const CHAR_SCAN = 256;
/**
 * A run of text with more segments than this (a text block, the stray text between blocks, the whole
 * section) is bisected with one-Range probes rather than measured segment by segment.
 */
export const BISECT_OVER = 16;

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Book instances on this page: each gets its own scope and id prefix, so two panes never collide. */
let instances = 0;

interface SectionState {
  section: number;
  href: string;
  /** `div.pdf-page.epub-page[data-page]`: the page box. */
  el: HTMLDivElement;
  /** `div.epub-section`: the sanitised content, the text model's container. */
  root: HTMLElement;
  hlLayer: HTMLDivElement;
  searchLayer: HTMLDivElement;
  images: { el: HTMLImageElement; path: string }[];
  /** Images have blob URLs (the section came within two viewports). */
  imagesLoaded: boolean;
  /** The section's text model (static: the sanitised content never changes), built at open. */
  index: TextIndex;
  /** Measured runs of segments (`from:to`, indices into index.segments): their lines relative to the page box top; dropped on reflow. */
  runs: Map<string, LineBox[]>;
  /** The painted highlight rects, page-relative, for hover/click hit tests without reading every rect's box. */
  hlBoxes: { id: string; left: number; top: number; right: number; bottom: number }[];
  /** Highlights / search hits changed or the section reflowed while it was far: repaint when it nears. */
  hlStale: boolean;
  searchStale: boolean;
}

const sameHit = (a: SearchHit, b: SearchHit | null) => !!b && a.page === b.page && a.start === b.start && a.end === b.end;

type Anchor = { clientX: number; clientY: number };

export class EpubRenderer implements RendererAdapter {
  private pkg: EpubPackage | null = null;
  private sections: SectionState[] = [];
  private scroller: HTMLDivElement;
  /** `.margin-epub[data-book]`: the scope every injected selector starts with. */
  private bookEl: HTMLDivElement;
  /** The book's scoped CSS, adopted by the document while the book is open. */
  private sheet: CSSStyleSheet | null = null;
  private marginEl: HTMLDivElement;
  private extentEl: HTMLDivElement;
  private readonly bookId: number;
  /** Prefix of every element id in this instance (unique per renderer). */
  private readonly uid: string;
  private readonly bookKey: string;
  private observer: IntersectionObserver | null = null;
  private intersecting = new Set<number>();
  private cleanup: (() => void)[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private textCache = new Map<number, string>();
  /** Each section's search text (ruby readings left out) and its map back to section offsets, built on first search. */
  private searchCache = new Map<number, { text: string; map: number[] }>();
  /** Every blob URL this book created (images and fonts): all revoked on close. */
  private urls = new Set<string>();
  private fontUrls = new Map<string, string | null>();
  /** Images that have their (single) load listener. */
  private sizing = new WeakSet<HTMLImageElement>();
  private closed = false;
  private opened = false;
  /** Set once open() has laid the sections out. */
  private ready = false;
  private large = false;
  private currentPage = 1;
  /**
   * goTo's target section and the scrollTop it left: it stays the reading section until the scroller
   * actually moves from there (a section shorter than the reading line's depth would otherwise hand the
   * report straight to the next one, and ‹ would land where the reader already is).
   * Any scrollTop change releases it, including the renderer's own zoom re-anchoring and the browser's
   * `overflow-anchor` adjustments as sections above lay out. That is intended: the report is then the
   * section actually at the reading line, only earlier than "the reader scrolled".
   */
  private held: { section: number; scrollTop: number } | null = null;
  private scale = 1;
  private zoom: Zoom = 'fit-width';
  private fitWidth = 0;
  private fitHeight = 0;
  private lastChange: WidthChange | null = null;
  private marginWidth = 0;
  /** The column's width now (CSS px): EPUB_COLUMN × scale, or the screen's width in a narrow fit. */
  private column = EPUB_COLUMN;
  private layoutQueued = false;
  private outline: OutlineEntry[] | null = null;
  private cancelPinch: () => void = () => {};
  private annotations: PaintableAnnotation[] = [];
  /** `annotations` that anchor in this book, by section: grouped once per paintHighlights. */
  private bySection = new Map<number, PaintableAnnotation[]>();
  /** Annotation spots already checked against their quotes (each mismatch is reported once). */
  private checked = new Set<string>();
  /** The highlight under the pointer, and the one whose popover or margin note has focus. */
  private hoverId: string | null = null;
  private activeId: string | null = null;
  /** Each location's last measured place (section fractions), for a far (unlaid-out) section. */
  private anchorCache = new Map<string, AnchorFraction>();
  private searchHits = new Map<number, SearchHit[]>();
  private currentHit: SearchHit | null = null;

  private selectionEm = new Emitter<SelectionInfo | null>();
  private locationEm = new Emitter<Location>();
  private clickEm = new Emitter<{ id: string; rect: DOMRect }>();
  private mismatchEm = new Emitter<PaintableAnnotation>();
  private layoutEm = new Emitter<PageLayout>();
  private zoomEm = new Emitter<ZoomState>();
  private linkEm = new Emitter<Location>();

  constructor(host: HTMLElement) {
    this.bookId = ++instances;
    this.uid = `mb${this.bookId}`;
    this.bookKey = randomKey();
    this.scroller = document.createElement('div');
    this.scroller.className = 'pdf-scroller epub-scroller';
    this.bookEl = document.createElement('div');
    this.bookEl.className = 'margin-epub';
    this.bookEl.dataset.book = String(this.bookId);
    this.scroller.appendChild(this.bookEl);
    this.marginEl = document.createElement('div');
    this.marginEl.className = 'pdf-margin';
    this.scroller.appendChild(this.marginEl);
    this.extentEl = document.createElement('div');
    this.extentEl.className = 'pdf-extent';
    this.extentEl.setAttribute('aria-hidden', 'true');
    this.scroller.appendChild(this.extentEl);
    this.scroller.appendChild(pencilDefs());
    host.appendChild(this.scroller);
  }

  /** Rejects with the package's `EpubError` (fixed layout, DRM, not a zip …) for ReaderView's open-error UI. */
  async open(data: ArrayBuffer, at?: Location | null, opts: OpenOptions = {}): Promise<void> {
    if (this.opened) throw new Error('EpubRenderer already opened');
    this.opened = true;
    // Yield once: a reader closed before the book is read (a quick tab switch) never parses it.
    await Promise.resolve();
    if (this.closed) return;
    const pkg = openEpub(data);
    this.pkg = pkg;
    const scope = `.margin-epub[data-book="${this.bookId}"]`;
    const families = new Map<string, string>();
    // One work budget for the whole book, spent by every section and sheet below (see budget.ts).
    const budget = bookBudget();
    const ctx = {
      scope,
      bookKey: this.bookKey,
      fontUrl: (path: string) => this.fontUrl(path),
      resolve: pkg.resolve,
      readCss: (path: string) => pkg.text(path),
      families,
      budget,
    };
    const css: string[] = [];
    const seenSheets = new Set<string>();
    let chars = 0;
    for (const s of pkg.sections) {
      const xhtml = pkg.text(s.href) ?? '';
      const out = sanitizeSection(xhtml, { section: s.index, path: s.href, pkg, doc: document, budget });
      // Ids are unique per section (sanitiser) and per book instance (here): two panes on one book never share one.
      out.root.querySelectorAll<HTMLElement>('[id]').forEach((el) => (el.id = `${this.uid}-${el.id}`));
      // An internal link has no href (nothing navigates the reader's page): focusable and announced as a
      // link here, Enter follows it (bindEvents).
      out.root.querySelectorAll<HTMLElement>('[data-epub-target]').forEach((a) => {
        a.setAttribute('tabindex', '0');
        a.setAttribute('role', 'link');
      });
      // In cascade order, one shared family map for the book; a sheet linked by every section is injected once.
      for (const src of out.sources) {
        if ('link' in src) {
          if (seenSheets.has(src.link)) continue;
          seenSheets.add(src.link);
          const text = pkg.text(src.link);
          if (text) css.push(scopeCss(text, src.link, ctx));
        } else {
          css.push(scopeCss(src.inline, s.href, ctx));
        }
      }
      const ps = this.createSection(s.index, s.href, out.root, out.images);
      const text = ps.index.text;
      this.textCache.set(s.index, text);
      chars += text.length;
      this.sections.push(ps);
    }
    if (this.closed) return;
    this.adoptBookCss(css.filter(Boolean).join('\n'));
    this.large = chars > LARGE_BOOK_CHARS;
    // Before the first fit: a margin width set from this size (setMarginWidth) is in the fit below.
    try {
      opts.onPageSize?.({ width: EPUB_COLUMN, height: EPUB_NOMINAL_HEIGHT });
    } catch (err) {
      console.error('EpubRenderer: onPageSize threw', err);
    }
    if (this.closed) return;
    this.scale = this.targetScale();
    this.applyScale();
    this.ready = true;
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const n = Number((e.target as HTMLElement).dataset.page);
          if (e.isIntersecting) {
            this.intersecting.add(n);
            this.loadImages(n);
            const ps = this.sections[n - 1];
            if (ps?.hlStale) this.paintSection(ps);
            if (ps?.searchStale) this.paintSearch(ps);
          } else {
            this.intersecting.delete(n);
          }
        }
        this.releaseFarSections();
      },
      // Images load once their section comes within two viewports.
      { root: this.scroller, rootMargin: '200% 0px' },
    );
    this.sections.forEach((ps) => this.observer!.observe(ps.el));
    // Highlights or hits handed over while the book was opening: checked now, painted as sections come near.
    if (this.annotations.length) this.paintHighlights(this.annotations);
    if (this.searchHits.size) this.showSearchHits([...this.searchHits.values()].flat(), this.currentHit);
    this.placePages();
    this.fitWidth = this.scroller.clientWidth;
    this.fitHeight = this.scroller.clientHeight;
    this.bindEvents();
    this.observeResize();
    this.markFar();
    this.queueLayout();
    this.emitZoom();
    if (at && at.kind === 'epub') await this.goTo(at);
  }

  async goTo(location: Location, opts: GoToOptions = {}): Promise<void> {
    if (location.kind !== 'epub' || this.closed || !this.ready) return;
    const ps = this.sections[location.value.section - 1];
    if (!ps || opts.superseded?.()) return;
    // The target is the reading section now: in a large book it and its neighbours are laid out before
    // anything is measured (a skipped section's size is only its placeholder's).
    this.setCurrent(ps.section);
    const v = location.value;
    const pageRect = ps.el.getBoundingClientRect();
    const rects = v.end > v.start ? this.rectsFor(ps, v) : [];
    // A point with an offset or a height has a line of its own; a page-level location (0, no y) doesn't.
    const band = rects.length === 0 && (v.start > 0 || v.y !== undefined) ? this.pointBand(ps, v, pageRect) : null;
    const marks = band ? [band] : rects;
    const within = marks.length ? marks[0].top - pageRect.top - readingLineY(this.scroller.clientHeight) : 0;
    this.scroller.scrollTop = ps.el.offsetTop + Math.max(0, within);
    // Read back: the browser clamps a target past the end.
    this.held = { section: ps.section, scrollTop: this.scroller.scrollTop };
    if (!opts.flash) return;
    if (marks.length) {
      const flashes = marks.map((r) => placeRect('hl-flash', r, pageRect));
      flashes.forEach((f) => ps.hlLayer.appendChild(f));
      this.later(() => flashes.forEach((f) => f.remove()), 1300);
    } else {
      ps.el.classList.remove('is-flashing');
      void ps.el.offsetWidth; // restart the animation
      ps.el.classList.add('is-flashing');
      this.later(() => ps.el.classList.remove('is-flashing'), 1300);
    }
  }

  onSelection(cb: (sel: SelectionInfo | null) => void): Unsubscribe {
    return this.selectionEm.on(cb);
  }

  /**
   * The book text selected right now (the live selection), as offsets into the section it starts in;
   * a selection running on into later sections is clipped to the end of that one, as PDF clips to a
   * page. Null without a selection, or one that doesn't start in this book's text.
   */
  currentSelection(): SelectionInfo | null {
    if (!this.ready || this.closed) return null;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const res = rangeToPageOffsets(range, this.sections.map((ps) => ({ page: ps.section, el: ps.root })));
    if (!res) return null;
    const ps = this.sections[res.page - 1];
    // The popover sits by the part that counts: the clipped range, not the whole drag.
    const own = rangeIn(ps.index, res.start, res.end);
    return {
      location: epubLocation({ section: res.page, start: res.start, end: res.end }),
      quote: res.quote,
      rect: (own ?? range).getBoundingClientRect(),
    };
  }

  /**
   * Internal link clicks (a `[data-epub-target]` in this book). With a subscriber the renderer only
   * reports the target, so the reader can jump through its own path (and "back" works); with none it
   * jumps there itself.
   */
  onInternalLink(cb: (to: Location) => void): Unsubscribe {
    return this.linkEm.on(cb);
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
  /** Checks every annotation's quote against its section (no layout needed); paints the sections near the viewport. */
  paintHighlights(annotations: PaintableAnnotation[]): void {
    if (this.closed) return;
    this.annotations = annotations;
    // One pass: painting and checking a section then look at its own annotations only.
    this.bySection = new Map();
    for (const a of annotations) {
      const loc = a.location;
      if (a.unanchored || loc.kind !== 'epub') continue;
      const list = this.bySection.get(loc.value.section);
      if (list) list.push(a);
      else this.bySection.set(loc.value.section, [a]);
    }
    if (!this.ready) return;
    for (const ps of this.sections) {
      this.checkAnchors(ps);
      this.refreshHighlights(ps);
    }
  }

  /** Nearest section to `near` first (pageOrder), the first whitespace-insensitive match wins. */
  async findQuote(quote: string, near?: Location | null): Promise<Location | null> {
    if (!this.ready || this.closed || !quote.trim()) return null;
    for (const n of pageOrder(this.sections.length, near?.kind === 'epub' ? near.value.section : undefined)) {
      const v = findQuoteInPage(this.textCache.get(n) ?? '', quote);
      if (v) return epubLocation({ section: n, ...v });
    }
    return null;
  }

  /**
   * One batch per section, from `fromPage` (default: the reading section) and wrapping; ignores case and
   * whitespace. It searches the base text: ruby readings (`rt`) and their fallback parentheses (`rp`) are
   * left out, so "漢字" matches 漢<rt>かん</rt>字<rt>じ</rt>; hits are offsets into the section text.
   */
  search(query: string, opts: { signal?: AbortSignal; fromPage?: number } = {}): AsyncIterable<SearchBatch> {
    if (!this.ready || this.closed) return searchPages([], async () => null, query);
    const getText = async (n: number) => (this.closed ? null : (this.searchText(n)?.text ?? ''));
    const inner = searchPages(wrapOrder(this.sections.length, opts.fromPage ?? this.currentPage), getText, query, opts.signal);
    const toSection = (n: number) => this.searchText(n)?.map;
    return (async function* () {
      for await (const batch of inner) {
        const map = toSection(batch.page);
        if (!map) {
          yield batch;
          continue;
        }
        yield { ...batch, hits: batch.hits.map((h) => ({ ...h, start: map[h.start], end: map[h.end - 1] + 1 })) };
      }
    })();
  }

  showSearchHits(hits: readonly SearchHit[], current: SearchHit | null): void {
    if (this.closed) return;
    const bySection = new Map<number, SearchHit[]>();
    for (const h of hits) {
      const list = bySection.get(h.page);
      if (list) list.push(h);
      else bySection.set(h.page, [h]);
    }
    this.searchHits = bySection;
    this.currentHit = current;
    for (const ps of this.sections) this.refreshSearch(ps);
  }

  clearSearch(): void {
    this.showSearchHits([], null);
  }

  /**
   * Each location's spot (scroller content coordinates): a highlight's first-line end, a point's line
   * (its first character's box) at the column's right inset, a section-level location at the section
   * top. A far section in a large book isn't laid out: its spots are estimated (last measured place, `y`,
   * top) rather than forcing its layout.
   */
  anchorPoints(locations: readonly Location[]): (AnchorPoint | null)[] {
    if (this.closed || !this.ready) return locations.map(() => null);
    const pageRects = new Map<number, DOMRect>();
    return locations.map((loc) => {
      if (loc.kind !== 'epub') return null;
      const ps = this.sections[loc.value.section - 1];
      if (!ps) return null;
      const v = loc.value;
      const box = { top: ps.el.offsetTop, left: ps.el.offsetLeft, width: ps.el.offsetWidth, height: ps.el.offsetHeight };
      const key = serializeLocation(loc);
      const measure = ps.el.classList.contains('is-far') ? null : this.measureAnchor(ps, v, pageRects);
      const spot = v.y === undefined ? { page: v.section, start: v.start, end: v.end } : { page: v.section, start: v.start, end: v.end, y: v.y };
      const a = anchorFor(box, spot, measure, this.anchorCache.get(key) ?? null);
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

  pageCount(): number {
    return this.ready && !this.closed ? this.sections.length : 0;
  }

  getOutline(): Promise<OutlineEntry[]> {
    if (!this.pkg || this.closed) return Promise.resolve([]);
    if (!this.outline) this.outline = this.pkg.toc.map((e) => this.outlineEntry(e));
    return Promise.resolve(this.outline);
  }

  async quoteAt(location: Location): Promise<string | null> {
    const spot = location.kind === 'epub' ? spotOf(location) : null;
    if (!spot || spot.start >= spot.end) return null;
    const text = await this.getPageText(spot.page);
    return spot.end <= text.length ? text.slice(spot.start, spot.end) : null;
  }

  async getPageText(page: number): Promise<string> {
    if (!this.pkg || this.closed) throw new Error('EpubRenderer: closed');
    const text = Number.isInteger(page) ? this.textCache.get(page) : undefined;
    if (text === undefined) throw new Error(`EpubRenderer: no section ${page}`);
    return text;
  }

  pointAt(clientY: number, page: number): Location | null {
    const ps = this.sections[page - 1];
    if (!ps || this.closed || !this.ready) return null;
    const box = ps.el.getBoundingClientRect();
    if (box.height <= 0) return null;
    // Only the block at that height is measured (the margin "+" calls this on mousemove).
    const line = nearestLine(this.linesNear(ps, clientY, box), clientY - box.top);
    // No line: a section without text (an image page) keeps only the height.
    const y = round4(clamp((line ? line.top : clientY - box.top) / box.height, 0, 1));
    return epubPoint(page, line ? line.start : 0, y);
  }

  async readingLinePoint(): Promise<Location | null> {
    if (!this.ready || this.closed) return null;
    // goTo's hold stands here too (updateCurrentPage): a short target section is the reading one, not
    // the section the reading line has already reached below it.
    const held = this.held && Math.abs(this.scroller.scrollTop - this.held.scrollTop) < 1 ? this.held : null;
    const ps = held ? this.sections[held.section - 1] : this.probePage();
    if (!ps) return null;
    const box = ps.el.getBoundingClientRect();
    const lineY = this.scroller.getBoundingClientRect().top + readingLineY(this.scroller.clientHeight);
    // The reading line below the whole held section: that section from its top.
    if (held && lineY > box.bottom) return epubPoint(ps.section, 0, 0);
    return this.pointAt(clamp(lineY, box.top, box.bottom), ps.section);
  }

  onPageLayout(cb: (layout: PageLayout) => void): Unsubscribe {
    const off = this.layoutEm.on(cb);
    if (this.ready && !this.closed) {
      try {
        cb(this.readLayout());
      } catch (err) {
        console.error('EpubRenderer: page-layout listener threw', err);
      }
    }
    return off;
  }

  getZoom(): ZoomState {
    const percent = !this.ready && typeof this.zoom === 'number' ? this.zoom : percentOf(this.scale);
    return { zoom: this.zoom, percent };
  }

  setZoom(zoom: Zoom, opts: { anchor?: Anchor } = {}): void {
    if (this.closed || (typeof zoom === 'number' && !Number.isFinite(zoom))) return;
    this.cancelPinch();
    this.applyZoom(zoom, opts.anchor);
  }

  onZoomChange(cb: (zoom: ZoomState) => void): Unsubscribe {
    return this.zoomEm.on(cb);
  }

  pageSize(): { width: number; height: number } | null {
    return this.ready ? { width: EPUB_COLUMN, height: EPUB_NOMINAL_HEIGHT } : null;
  }

  marginLayer(): HTMLElement {
    return this.marginEl;
  }

  setMarginWidth(px: number): void {
    const width = Number.isFinite(px) ? Math.max(0, Math.round(px)) : 0;
    if (this.closed || width === this.marginWidth) return;
    this.marginWidth = width;
    if (!this.ready) return;
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
    this.placePages();
    this.queueLayout();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.observer?.disconnect();
    this.observer = null;
    this.cleanup.forEach((f) => f());
    this.cleanup = [];
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls.clear();
    this.fontUrls.clear();
    this.dropBookCss();
    this.selectionEm.clear();
    this.locationEm.clear();
    this.clickEm.clear();
    this.mismatchEm.clear();
    this.layoutEm.clear();
    this.zoomEm.clear();
    this.linkEm.clear();
    this.outline = null;
    this.annotations = [];
    this.bySection.clear();
    this.anchorCache.clear();
    this.searchHits.clear();
    this.searchCache.clear();
    this.pkg = null;
    this.scroller.remove();
  }

  // ---- internals ----

  /** Section `n`'s text without ruby readings (`rt`, `rp`), with `map[i]` = the section offset of char i. */
  private searchText(n: number): { text: string; map: number[] } | null {
    let v = this.searchCache.get(n);
    if (v) return v;
    const ps = this.sections[n - 1];
    if (!ps) return null;
    let text = '';
    const map: number[] = [];
    for (const seg of ps.index.segments) {
      const reading = seg.br ? null : seg.node.parentElement?.closest('rt, rp');
      if (reading && ps.root.contains(reading)) continue;
      const chunk = seg.br ? '\n' : seg.node.data;
      for (let i = 0; i < chunk.length; i++) map.push(seg.start + i);
      text += chunk;
    }
    v = { text, map };
    this.searchCache.set(n, v);
    return v;
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  /**
   * Adopts the book's scoped CSS as a constructed stylesheet of the reader's document (the window it is
   * shown in, which may be a popout). Obsidian's plugin review disallows <style> elements.
   */
  private adoptBookCss(text: string): void {
    const doc = this.bookEl.ownerDocument;
    const Sheet = doc.defaultView?.CSSStyleSheet ?? CSSStyleSheet;
    const sheet = new Sheet();
    sheet.replaceSync(text);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    this.sheet = sheet;
  }

  private dropBookCss(): void {
    const sheet = this.sheet;
    if (!sheet) return;
    const doc = this.bookEl.ownerDocument;
    doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet);
    this.sheet = null;
  }

  private createSection(section: number, href: string, root: HTMLElement, images: SectionState['images']): SectionState {
    const el = document.createElement('div');
    el.className = 'pdf-page epub-page';
    el.dataset.page = String(section);
    const hlLayer = document.createElement('div');
    hlLayer.className = 'hl-layer';
    const searchLayer = document.createElement('div');
    searchLayer.className = 'search-layer';
    el.append(hlLayer, searchLayer, root);
    this.bookEl.appendChild(el);
    const index = indexText(root);
    return {
      section,
      href,
      el,
      root,
      hlLayer,
      searchLayer,
      images,
      imagesLoaded: false,
      index,
      runs: new Map(),
      hlBoxes: [],
      hlStale: false,
      searchStale: false,
    };
  }

  /** A zip font's blob URL (created once per path); null when absent, obfuscated or not a font. */
  private fontUrl(path: string): string | null {
    const pkg = this.pkg;
    if (!pkg || this.closed) return null;
    if (this.fontUrls.has(path)) return this.fontUrls.get(path)!;
    let url: string | null = null;
    const type = (pkg.mediaType(path) ?? '').toLowerCase();
    const isFont = /^(font\/|application\/(font-|x-font-|vnd\.ms-opentype))/.test(type) || /\.(woff2?|otf|ttf)$/i.test(path);
    if (isFont && !pkg.obfuscated.has(path)) {
      const bytes = pkg.bytes(path);
      if (bytes) url = this.blobUrl(bytes, fontBlobType(type, path));
    }
    this.fontUrls.set(path, url);
    return url;
  }

  private blobUrl(bytes: Uint8Array, type: string): string {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    this.urls.add(url);
    return url;
  }

  /** Gives a section's zip images their blob URLs (once it comes within two viewports). */
  private loadImages(n: number): void {
    const ps = this.sections[n - 1];
    const pkg = this.pkg;
    if (!ps || !pkg || this.closed || ps.imagesLoaded) return;
    ps.imagesLoaded = true;
    for (const { el, path } of ps.images) {
      const type = (pkg.mediaType(path) ?? '').toLowerCase();
      if (!type.startsWith('image/')) continue;
      const bytes = pkg.bytes(path);
      if (!bytes) continue;
      // Checked before the decoder sees it (imageInfo): an oversized or unreadable image keeps its alt text
      // and never gets a URL.
      if (!imageAllowed(bytes, type)) {
        el.classList.add('epub-img-blocked');
        continue;
      }
      const svg = type.startsWith('image/svg');
      // An SVG blob is shown as an image only (no script runs there); it is never a drag source or a link
      // target, since opened on its own it would be a document in the reader's origin.
      if (svg) el.draggable = false;
      // One listener per image for the book's life: released and reloaded images don't stack them.
      if (!this.sizing.has(el)) {
        this.sizing.add(el);
        el.addEventListener('load', () => {
          // A late load of a released URL (or after close) sizes nothing.
          if (this.closed || !ps.imagesLoaded || !el.getAttribute('src')) return;
          // Keep its box once known, so releasing the URL later doesn't collapse the column.
          if (!el.hasAttribute('width') && el.naturalWidth > 0) el.setAttribute('width', String(el.naturalWidth));
          if (!el.hasAttribute('height') && el.naturalHeight > 0) el.setAttribute('height', String(el.naturalHeight));
        });
      }
      el.src = this.blobUrl(bytes, type);
    }
  }

  /** Drops a section's image URLs (revoked); they come back when it nears the viewport again. */
  private releaseImages(ps: SectionState): void {
    if (!ps.imagesLoaded) return;
    ps.imagesLoaded = false;
    for (const { el } of ps.images) {
      const src = el.getAttribute('src');
      if (!src) continue;
      el.removeAttribute('src');
      if (this.urls.delete(src)) URL.revokeObjectURL(src);
    }
  }

  /** Sections outside the observer margin and more than KEEP_RENDERED_RADIUS from the current one release their images. */
  private releaseFarSections(): void {
    const current = this.probePage()?.section ?? this.currentPage;
    for (const ps of this.sections) {
      if (this.intersecting.has(ps.section)) continue;
      if (Math.abs(ps.section - current) <= KEEP_RENDERED_RADIUS) continue;
      this.releaseImages(ps);
    }
  }

  /** In a large book, sections more than FAR_RADIUS from the reading one skip rendering until near. */
  private markFar(current = this.probePage()?.section ?? this.currentPage): void {
    if (!this.large) return;
    for (const ps of this.sections) ps.el.classList.toggle('is-far', Math.abs(ps.section - current) > FAR_RADIUS);
  }

  private outlineEntry(e: EpubTocEntry): OutlineEntry {
    const entry: OutlineEntry = { title: e.title, page: e.section, children: e.children.map((c) => this.outlineEntry(c)) };
    if (e.section !== null && e.fragment) {
      const offset = this.fragmentOffset(e.section, `e${e.section}-${e.fragment}`);
      if (offset !== null) entry.at = epubLocation({ section: e.section, start: offset, end: offset });
    }
    return entry;
  }

  /** The text offset where element `id` (as the sanitiser wrote it) starts in `section`; null if it isn't there. */
  private fragmentOffset(section: number, id: string): number | null {
    const ps = this.sections[section - 1];
    if (!ps) return null;
    const el = findById(ps.root, `${this.uid}-${id}`);
    return el ? pointToOffset(ps.root, el, 0) : null;
  }

  /** The scale the current zoom asks for: a fixed percentage, or the column fitted (clamped) into the fit area. */
  private targetScale(): number {
    if (typeof this.zoom === 'number') return clampZoom(this.zoom) / 100;
    return epubFit(fitArea(this.scroller.clientWidth, this.scroller.clientHeight, this.marginWidth).width).scale;
  }

  /** In a fit zoom on a screen too narrow for the column at FIT_MIN: the column's width; otherwise null. */
  private narrowColumn(): number | null {
    if (typeof this.zoom === 'number') return null;
    const fit = epubFit(fitArea(this.scroller.clientWidth, this.scroller.clientHeight, this.marginWidth).width);
    return fit.narrow ? fit.column : null;
  }

  /** Column width and font follow the scale; lines reflow, so measured lines are dropped. */
  private applyScale(): void {
    const narrow = this.narrowColumn();
    this.column = narrow ?? EPUB_COLUMN * this.scale;
    this.bookEl.style.setProperty('--epub-scale', String(this.scale));
    this.bookEl.classList.toggle('is-narrow', narrow !== null);
    const width = `${round4(this.column)}px`;
    const font = `${round4(EPUB_FONT_PX * this.scale)}px`;
    for (const ps of this.sections) {
      ps.el.style.width = width;
      ps.el.style.fontSize = font;
      dropLines(ps);
    }
  }

  /**
   * After a resize at an unchanged scale: a narrow column follows the screen's width (a phone turned
   * sideways). True when the column changed.
   */
  private syncColumn(): boolean {
    if (!this.ready) return false;
    const want = this.narrowColumn() ?? EPUB_COLUMN * this.scale;
    if (want === this.column) return false;
    this.applyScale();
    return true;
  }

  private applyZoom(zoom: Zoom, anchor?: Anchor): void {
    if (this.closed || (typeof zoom === 'number' && !Number.isFinite(zoom))) return;
    this.zoom = typeof zoom === 'number' ? clampZoom(zoom) : zoom;
    if (!this.ready) {
      if (typeof this.zoom === 'number') this.emitZoom();
      return;
    }
    this.fitWidth = this.scroller.clientWidth;
    this.fitHeight = this.scroller.clientHeight;
    this.relayout(this.targetScale(), anchor);
    this.emitZoom();
  }

  /**
   * Re-lays out at `scale`, keeping the reading line (or `anchor`) on the same text line: the line under
   * it is found by offset after the reflow. Without a line there, the spot's fraction of the section holds.
   */
  private relayout(scale: number, anchor?: Anchor): void {
    if (scale === this.scale) {
      if (this.syncColumn()) {
        this.placePages();
        this.queueLayout();
      }
      return;
    }
    const sc = this.scroller.getBoundingClientRect();
    const anchorY = anchor ? anchor.clientY - sc.top : readingLineY(this.scroller.clientHeight);
    const anchorX = anchor ? anchor.clientX - sc.left : this.scroller.clientWidth / 2;
    const scrollTop = this.scroller.scrollTop;
    const pos = captureAt(this.pageBoxes(), scrollTop, anchorY);
    const ps = this.sections[Math.min(pos.index, this.sections.length - 1)];
    // Cheap on every pinch step: one block measured before, one character's box read after.
    let hold: { offset: number; delta: number } | null = null;
    if (ps && pos.offset === 0) {
      const y = sc.top + anchorY;
      const box = ps.el.getBoundingClientRect();
      const line = nearestLine(this.linesNear(ps, y, box), y - box.top);
      const char = line ? this.charRect(ps, line.start) : null;
      if (line && char) hold = { offset: line.start, delta: y - char.top };
    }
    const span = () => ({ left: ps.el.offsetLeft, width: ps.el.offsetWidth });
    const fx = ps ? captureX(span(), this.scroller.scrollLeft, anchorX) : 0.5;
    const ratio = scale / this.scale;
    this.scale = scale;
    this.applyScale();
    this.placePages();
    let top = restoreAt(pos, this.pageBoxes(), anchorY);
    if (ps && hold) {
      const char = this.charRect(ps, hold.offset);
      // The character's place in content coordinates (the scroll hasn't moved yet), the same scaled distance below it.
      if (char) top = Math.max(0, scrollTop + (char.top - sc.top) + hold.delta * ratio - anchorY);
    }
    this.scroller.scrollTop = top;
    this.scroller.scrollLeft = ps ? restoreX(fx, span(), anchorX) : 0;
    this.queueLayout();
    // The selection survives a reflow (unlike PDF's re-rendered text layer), but its box moved.
    if (this.selectionEm.size > 0) this.selectionEm.emit(this.currentSelection());
  }

  /** The column lane, as PDF places its pages (pageLane): centred, room for the margin, scrollable both ways when zoomed. */
  private placePages(): boolean {
    const width = this.scroller.clientWidth;
    if (this.sections.length === 0 || width <= 0) return false;
    const laneWidth = this.column;
    const lane = pageLane(width, laneWidth, this.marginWidth);
    const left = `${pageLeft(lane.left, laneWidth, laneWidth)}px`;
    let changed = false;
    for (const ps of this.sections) {
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

  private observeResize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let burstStart = 0;
    const ro = new ResizeObserver(() => {
      if (!this.closed && (this.syncColumn() || this.placePages())) {
        this.placePages();
        this.queueLayout();
      }
      if (timer !== undefined) clearTimeout(timer);
      else burstStart = performance.now();
      timer = setTimeout(() => {
        timer = undefined;
        this.refit(burstStart);
      }, RESIZE_SETTLE_MS);
    });
    ro.observe(this.scroller);
    // Sections reflow on their own (images, fonts, zoom): their lines are stale and the boxes moved.
    const sectionsRo = new ResizeObserver((entries) => {
      if (this.closed) return;
      for (const e of entries) {
        const ps = this.sections[Number((e.target as HTMLElement).dataset.page) - 1];
        if (!ps) continue;
        dropLines(ps);
        // The overlay rects came from the old layout.
        this.refreshHighlights(ps);
        delete ps.searchLayer.dataset.key;
        this.refreshSearch(ps);
      }
      this.queueLayout();
    });
    this.sections.forEach((ps) => sectionsRo.observe(ps.el));
    this.cleanup.push(() => {
      ro.disconnect();
      sectionsRo.disconnect();
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  private refit(resizedAt: number): void {
    if (this.closed || !this.ready) return;
    const d = decideRefit({
      width: this.scroller.clientWidth,
      height: this.scroller.clientHeight,
      fitWidth: this.fitWidth,
      fitHeight: this.fitHeight,
      // Fit page is fit width for a column of text.
      zoom: this.zoom === 'fit-page' ? 'fit-width' : this.zoom,
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
    // A width change reflows the text either way.
    for (const ps of this.sections) dropLines(ps);
    if (d.action === 'layout') {
      this.placePages();
      this.queueLayout();
      return;
    }
    this.relayout(d.scale);
    this.emitZoom();
  }

  private emitZoom(): void {
    this.zoomEm.emit(this.getZoom());
  }

  private pageBoxes() {
    return this.sections.map((p) => ({ top: p.el.offsetTop, height: p.el.offsetHeight }));
  }

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
      pages: this.sections.map((p) => ({
        page: p.section,
        top: p.el.offsetTop,
        left: p.el.offsetLeft,
        width: p.el.offsetWidth,
        height: p.el.offsetHeight,
        ready: true,
      })),
    };
  }

  private rectsFor(ps: SectionState, v: { start: number; end: number }): DOMRect[] {
    const range = rangeIn(ps.index, v.start, v.end);
    if (!range) return [];
    return Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  }

  /**
   * The lines of segments [from, to) relative to the page box top that lie nearest `clientY`. A short run
   * is measured whole (cached until reflow); a long one is bisected with one-Range probes down to the
   * segment at that height (or the two either side of it), and only those are measured. A run without
   * non-blank text reads nothing and gives no lines.
   */
  private runLines(ps: SectionState, from: number, to: number, clientY: number, box: DOMRect): LineBox[] {
    const segs = ps.index.segments;
    if (to - from > BISECT_OVER) {
      const near = bisectRun(segs, from, to, clientY);
      if (!near) return [];
      [from, to] = near;
    }
    const key = `${from}:${to}`;
    let lines = ps.runs.get(key);
    if (!lines) {
      lines = relativeLines(measureSegmentLines(segs.slice(from, to)), box);
      ps.runs.set(key, lines);
    }
    return lines;
  }

  /**
   * The text lines near `clientY` without measuring the whole section. From the section root it descends
   * into the block child at that height (a binary search over the block children's boxes; inline children
   * such as a stray `<br/>`, an empty `<a id>` or a page-break `<span>` don't stop it) until it reaches a
   * block of text, and measures only that one. When `clientY` falls between two blocks on stray inline
   * text, only the text between them is measured. A block without text (an image) borrows its nearest
   * text-bearing siblings; with none, the whole section's text is searched. Every run is bounded by
   * runLines' bisection, so no markup makes a pinch step measure a whole section.
   *
   * Known limit: the search assumes block children stack vertically. Side-by-side blocks (table cells in a
   * row, floats, multi-column book CSS) are told apart by height only, so a neighbouring cell may be the
   * one measured; the line found is then a real line close by, not always the nearest one under x.
   */
  private linesNear(ps: SectionState, clientY: number, box: DOMRect): LineBox[] {
    const segs = ps.index.segments;
    let el: Element = ps.root;
    for (let depth = 0; depth < MAX_BLOCK_DEPTH; depth++) {
      const kids = blockChildren(el);
      if (kids.length === 0) break; // a block of text
      const hit = blockAt(kids, clientY);
      if (!hit) break; // no block child has a box: el's own text is searched
      if (hit.gap) {
        const [from, to] = runBetween(segs, el, hit.gap.before, hit.gap.after);
        const stray = this.runLines(ps, from, to, clientY, box);
        if (stray.length) return stray;
      }
      el = kids[hit.index];
    }
    const [from, to] = runWithin(segs, el);
    const own = this.runLines(ps, from, to, clientY, box);
    if (own.length || el === ps.root) return own;
    const parent = el.parentElement;
    const sibs = parent ? blockChildren(parent) : [];
    const at = sibs.indexOf(el);
    const near: LineBox[] = [];
    for (const step of [-1, 1]) {
      for (let i = at + step, n = 0; i >= 0 && i < sibs.length && n < SIBLING_PROBES; i += step, n++) {
        const [a, b] = runWithin(segs, sibs[i]);
        const l = this.runLines(ps, a, b, clientY, box);
        if (l.length) {
          near.push(...l);
          break;
        }
      }
    }
    return near.length ? near : this.runLines(ps, 0, segs.length, clientY, box);
  }

  /** The box of the first non-blank character at or after `offset` (a line's own box, read with one Range); null without one. */
  private charRect(ps: SectionState, offset: number): DOMRect | null {
    const { text, segments } = ps.index;
    let o = Math.max(0, offset);
    const stop = Math.min(text.length, o + CHAR_SCAN);
    while (o < stop && /\s/.test(text[o])) o++;
    if (o >= stop) return null;
    const seg = segmentAt(segments, o);
    if (!seg || seg.br) return null;
    const range = document.createRange();
    range.setStart(seg.node, o - seg.start);
    range.setEnd(seg.node, Math.min(seg.node.length, o - seg.start + 1));
    return Array.from(range.getClientRects()).find((r) => r.height > 0) ?? null;
  }

  /** A full-width band at a point's line (its first character's box), or at its `y` in a section without text there. */
  private pointBand(ps: SectionState, v: EpubLocationValue, page: DOMRect): DOMRect | null {
    const char = this.charRect(ps, v.start);
    if (char) return new DOMRect(page.left, char.top, page.width, char.height);
    if (v.y === undefined) return null;
    return new DOMRect(page.left, page.top + v.y * page.height, page.width, POINT_BAND_PX);
  }

  private probePage(): SectionState | undefined {
    const s = this.scroller;
    const i = readingPageIndex(this.pageBoxes(), s.scrollTop, s.clientHeight, s.scrollHeight);
    return i < 0 ? undefined : this.sections[i];
  }

  private updateCurrentPage(): void {
    const held = this.held;
    // goTo's own scroll (or none yet): its target stands.
    if (held && Math.abs(this.scroller.scrollTop - held.scrollTop) < 1) {
      this.releaseFarSections();
      return;
    }
    this.held = null;
    const ps = this.probePage();
    this.releaseFarSections();
    if (ps) this.setCurrent(ps.section);
  }

  /** `section` is the reading one: far sections follow it, and listeners hear of a change (page-level location). */
  private setCurrent(section: number): void {
    if (section === this.currentPage) return;
    this.currentPage = section;
    this.markFar(section);
    this.locationEm.emit(epubLocation({ section, start: 0, end: 0 }));
  }

  /** An internal link (`data-epub-target="<section>[#<id>]"`): jump there, its target looked up inside this book only. */
  private followLink(a: HTMLElement): void {
    const m = /^(\d+)(?:#(.+))?$/.exec(a.dataset.epubTarget ?? '');
    if (!m) return;
    const section = Number(m[1]);
    if (!this.sections[section - 1]) return;
    const offset = m[2] ? (this.fragmentOffset(section, m[2]) ?? 0) : 0;
    const to = epubLocation({ section, start: offset, end: offset });
    if (this.linkEm.size > 0) this.linkEm.emit(to);
    else void this.goTo(to, { flash: true });
  }

  // ---- highlights, search, anchors ----

  /** Paints a section's highlights now if it is near the viewport, else once it comes near. */
  private refreshHighlights(ps: SectionState): void {
    if (this.intersecting.has(ps.section)) this.paintSection(ps);
    else ps.hlStale = true;
  }

  private refreshSearch(ps: SectionState): void {
    if (this.intersecting.has(ps.section)) this.paintSearch(ps);
    else ps.searchStale = true;
  }

  /** The section's highlight rects (PDF's classes: `highlightClass`, the pencil band), and their boxes for hit tests. */
  private paintSection(ps: SectionState): void {
    ps.hlStale = false;
    ps.hlLayer.querySelectorAll('.hl').forEach((n) => n.remove());
    const hoverWasHere = this.hoverId !== null && ps.hlBoxes.some((b) => b.id === this.hoverId);
    ps.hlBoxes = [];
    const pageRect = ps.el.getBoundingClientRect();
    for (const a of this.bySection.get(ps.section) ?? []) {
      if (a.location.kind !== 'epub') continue;
      const state = { hover: a.id === this.hoverId, active: a.id === this.activeId, fresh: !!a.fresh };
      this.rectsFor(ps, a.location.value).forEach((r, i) => {
        const d = placeRect(highlightClass(a.color, state), r, pageRect);
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
    // The hovered highlight is gone from this section (deleted, or moved): drop the hover.
    if (hoverWasHere && !ps.hlBoxes.some((b) => b.id === this.hoverId)) this.setHover(null);
  }

  /** Each annotation whose stored offsets no longer hold its quote is reported once (the reader re-anchors it). */
  private checkAnchors(ps: SectionState): void {
    const text = this.textCache.get(ps.section) ?? '';
    for (const a of this.bySection.get(ps.section) ?? []) {
      if (a.location.kind !== 'epub') continue;
      const v = a.location.value;
      const key = `${a.id}:${v.section}:${v.start}:${v.end}`;
      if (this.checked.has(key)) continue;
      this.checked.add(key);
      if (!quoteMatches(text, v.start, v.end, a.quote)) this.mismatchEm.emit(a);
    }
  }

  /** The highlight rect under (x, y) in the section holding `target`; one page box read, rects from hlBoxes. */
  private highlightAt(target: EventTarget | null, x: number, y: number): { id: string; rect: DOMRect } | null {
    const pageEl = target instanceof Element ? target.closest<HTMLElement>('.pdf-page') : null;
    if (!pageEl || !this.bookEl.contains(pageEl)) return null;
    const ps = this.sections[Number(pageEl.dataset.page) - 1];
    if (!ps || ps.hlBoxes.length === 0) return null;
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
    for (const ps of this.sections) {
      if (ps.hlBoxes.length === 0) continue;
      ps.hlLayer.querySelectorAll<HTMLElement>('.hl').forEach((d) => {
        d.classList.toggle('is-hover', d.dataset.id === this.hoverId);
        d.classList.toggle('is-active', d.dataset.id === this.activeId);
      });
    }
  }

  private handleClick(e: MouseEvent): void {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const hit = this.highlightAt(e.target, e.clientX, e.clientY);
    if (hit) this.clickEm.emit(hit);
  }

  /** The section's search hits; skipped when its hits and current hit are unchanged (the pulse doesn't restart). */
  private paintSearch(ps: SectionState): void {
    ps.searchStale = false;
    const hits = this.searchHits.get(ps.section) ?? [];
    const key = hits.map((h) => `${h.start}-${h.end}${sameHit(h, this.currentHit) ? '*' : ''}`).join(',');
    if ((ps.searchLayer.dataset.key ?? '') === key) return;
    ps.searchLayer.dataset.key = key;
    ps.searchLayer.replaceChildren();
    const pageRect = ps.el.getBoundingClientRect();
    for (const h of hits) {
      const cls = sameHit(h, this.currentHit) ? 'search-hit is-current' : 'search-hit';
      for (const r of this.rectsFor(ps, h)) ps.searchLayer.appendChild(placeRect(cls, r, pageRect));
    }
  }

  /** Section-relative measurements of a location, sharing section boxes per call. */
  private measureAnchor(ps: SectionState, v: EpubLocationValue, pageRects: Map<number, DOMRect>): AnchorMeasure {
    let page = pageRects.get(ps.section);
    if (!page) {
      page = ps.el.getBoundingClientRect();
      pageRects.set(ps.section, page);
    }
    if (v.end > v.start) {
      const end = firstLineEnd(this.rectsFor(ps, v));
      return { highlight: end && { top: end.top - page.top, right: end.right - page.left }, lineTop: null };
    }
    // A section-level location (offset 0, no y) has no line of its own.
    if (v.start === 0 && v.y === undefined) return { highlight: null, lineTop: null };
    const char = this.charRect(ps, v.start);
    return { highlight: null, lineTop: char ? char.top - page.top : null };
  }

  private bindEvents(): void {
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
    const onClick = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-epub-target]') : null;
      if (t && this.bookEl.contains(t)) {
        e.preventDefault();
        this.followLink(t);
        return;
      }
      // An external link (http/https/mailto) keeps its default; it isn't a highlight click either.
      if (e.target instanceof Element && e.target.closest('a[href]')) return;
      this.handleClick(e);
    };
    // Only the main button selects: a right-click's mouseup (its menu is open by then) must not bring the
    // selection popover up over that menu.
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      this.later(() => this.selectionEm.emit(this.currentSelection()), 0);
    };
    // Hovering a highlight shows its full fill; left alone while a selection is being dragged.
    const onHover = (e: MouseEvent) => {
      if (e.buttons !== 0) return;
      this.setHover(this.highlightAt(e.target, e.clientX, e.clientY)?.id ?? null);
    };
    const onLeave = () => this.setHover(null);
    // Enter on a focused internal link follows it, as a click does.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-epub-target]') : null;
      if (!t || !this.bookEl.contains(t)) return;
      e.preventDefault();
      this.followLink(t);
    };

    // Trackpad pinch (ctrl+wheel; WebKit gesture events), applied at most every PINCH_APPLY_MS: as in PDF.
    let pinch: { percent: number; at?: Anchor } | null = null;
    let pinchTimer: ReturnType<typeof setTimeout> | undefined;
    const applyPinch = () => {
      pinchTimer = undefined;
      const p = pinch;
      pinch = null;
      if (p) this.applyZoom(p.percent, p.at);
    };
    this.cancelPinch = () => {
      if (pinchTimer !== undefined) clearTimeout(pinchTimer);
      pinchTimer = undefined;
      pinch = null;
    };
    const queuePinch = (percent: number, at?: Anchor) => {
      pinch = { percent, at };
      if (pinchTimer === undefined) pinchTimer = setTimeout(applyPinch, PINCH_APPLY_MS);
    };
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
      const base = pinch ? pinch.percent : percentOf(this.scale);
      queuePinch(pinchZoom(base, wheelDeltaPx(e.deltaY, e.deltaMode, this.scroller.clientHeight)), {
        clientX: e.clientX,
        clientY: e.clientY,
      });
    };
    let gestureBase = 100;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      touchGesture();
      gestureBase = percentOf(this.scale);
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      touchGesture();
      const g = e as Event & { scale?: number; clientX?: number; clientY?: number };
      const at = g.clientX !== undefined && g.clientY !== undefined ? { clientX: g.clientX, clientY: g.clientY } : undefined;
      const scale = g.scale !== undefined && Number.isFinite(g.scale) && g.scale > 0 ? g.scale : 1;
      queuePinch(clamp(gestureBase * scale, ZOOM_MIN, ZOOM_MAX), at);
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      endGesture();
    };

    const s = this.scroller;
    s.addEventListener('scroll', onScroll);
    s.addEventListener('click', onClick);
    s.addEventListener('mouseup', onMouseUp);
    const stopTouchSelection = watchTouchSelection(s, () => this.selectionEm.emit(this.currentSelection()));
    s.addEventListener('mousemove', onHover);
    s.addEventListener('mouseleave', onLeave);
    s.addEventListener('keydown', onKey);
    s.addEventListener('wheel', onWheel, { passive: false });
    s.addEventListener('gesturestart', onGestureStart);
    s.addEventListener('gesturechange', onGestureChange);
    s.addEventListener('gestureend', onGestureEnd);
    s.addEventListener('pointerdown', endGesture);
    this.cleanup.push(() => {
      if (timer !== undefined) clearTimeout(timer);
      if (pinchTimer !== undefined) clearTimeout(pinchTimer);
      if (gestureTimer !== undefined) clearTimeout(gestureTimer);
      s.removeEventListener('scroll', onScroll);
      s.removeEventListener('click', onClick);
      s.removeEventListener('mouseup', onMouseUp);
      stopTouchSelection();
      s.removeEventListener('mousemove', onHover);
      s.removeEventListener('mouseleave', onLeave);
      s.removeEventListener('keydown', onKey);
      s.removeEventListener('wheel', onWheel);
      s.removeEventListener('gesturestart', onGestureStart);
      s.removeEventListener('gesturechange', onGestureChange);
      s.removeEventListener('gestureend', onGestureEnd);
      s.removeEventListener('pointerdown', endGesture);
    });
  }
}

// ---- helpers ----

function randomKey(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function placeRect(className: string, r: DOMRect, pageRect: DOMRect): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  d.style.left = `${r.left - pageRect.left}px`;
  d.style.top = `${r.top - pageRect.top}px`;
  d.style.width = `${r.width}px`;
  d.style.height = `${r.height}px`;
  return d;
}

/** An element with this exact id inside `root` (the document's lookup, checked to be in `root`; a scan when detached). */
function findById(root: HTMLElement, id: string): HTMLElement | null {
  const el = root.ownerDocument.getElementById(id);
  if (el && root.contains(el)) return el;
  for (const c of Array.from(root.querySelectorAll<HTMLElement>('[id]'))) if (c.id === id) return c;
  return null;
}

/**
 * The visual lines of reflowed text, in text order, in client coordinates. Each text node's own rects
 * (one per line it wraps over) are read through a Range; a wrapped node's later lines find their first
 * character by bisection. A line starts at its first non-blank character.
 */
export function measureTextLines(root: HTMLElement): LineBox[] {
  return measureSegmentLines(indexText(root).segments);
}

/** measureTextLines over some segments of a text index (offsets stay the index's own). */
export function measureSegmentLines(segments: readonly Segment[]): LineBox[] {
  const lines: LineBox[] = [];
  let cur: LineBox | null = null;
  const range = document.createRange();
  for (const seg of segments) {
    if (seg.br) continue;
    const node = seg.node;
    const data = node.data;
    if (!data.trim()) continue;
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0);
    rects.forEach((r, i) => {
      const mid = (r.top + r.bottom) / 2;
      const outside = cur === null || Math.abs(mid - (cur.top + cur.bottom) / 2) > (cur.bottom - cur.top) / 2;
      if (!outside && cur) {
        cur.top = Math.min(cur.top, r.top);
        cur.bottom = Math.max(cur.bottom, r.bottom);
        return;
      }
      const at = i === 0 ? 0 : firstCharAtOrBelow(node, r.top, range);
      cur = { start: seg.start + skipBlank(data, at), top: r.top, bottom: r.bottom };
      lines.push(cur);
    });
  }
  return lines;
}

/** Index of the first character of `node` whose box starts at or below `top` (a wrapped line's start). */
function firstCharAtOrBelow(node: Text, top: number, range: Range): number {
  let lo = 0;
  let hi = node.length - 1;
  let ans = node.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    range.setStart(node, mid);
    range.setEnd(node, mid + 1);
    const r = range.getBoundingClientRect();
    if (r.height > 0 && (r.top + r.bottom) / 2 >= top) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

/** Client-coordinate lines → relative to `box`'s top. */
function relativeLines(lines: LineBox[], box: DOMRect): LineBox[] {
  return lines.map((l) => ({ start: l.start, top: l.top - box.top, bottom: l.bottom - box.top }));
}

function dropLines(ps: SectionState): void {
  ps.runs.clear();
}

/** Elements laid out inline: they never make their parent a container of blocks. */
const INLINE = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i', 'img', 'ins', 'kbd',
  'mark', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
]);

/** The block (non-inline) element children of `el`: none means `el` is a block of text. */
function blockChildren(el: Element): Element[] {
  const out: Element[] = [];
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (!INLINE.has(c.localName)) out.push(c);
  return out;
}

/**
 * The block of `kids` at height `y` (client): the last one whose top is at or above it, or the next one
 * when `y` sits nearer that in the gap below. A binary search over the boxes (memoised, in document
 * order); blocks without a box (hidden) are skipped. When `y` is outside the chosen block's box, `gap`
 * names the visible blocks either side of `y` (null at an end): stray inline text may sit there. Null
 * without a block that has a box.
 *
 * Height only: side-by-side blocks (cells of one row, floats, columns) can't be told apart by `y`, and
 * the one picked may be a neighbour of the block under the pointer (see linesNear).
 */
function blockAt(kids: Element[], y: number): { index: number; gap: { before: Element | null; after: Element | null } | null } | null {
  const n = kids.length;
  const boxes = new Map<number, DOMRect | null>();
  const boxOf = (i: number): DOMRect | null => {
    let b = boxes.get(i);
    if (b === undefined) {
      const r = kids[i].getBoundingClientRect();
      b = r.width > 0 || r.height > 0 ? r : null;
      boxes.set(i, b);
    }
    return b;
  };
  const visibleFrom = (from: number, to: number) => {
    for (let i = from; i <= to; i++) if (boxOf(i)) return i;
    return -1;
  };
  let lo = 0;
  let hi = n - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = visibleFrom(mid, hi);
    if (v < 0) {
      hi = mid - 1;
    } else if (boxOf(v)!.top <= y) {
      at = v;
      lo = v + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (at < 0) {
    const first = visibleFrom(0, n - 1);
    return first < 0 ? null : { index: first, gap: { before: null, after: kids[first] } };
  }
  const box = boxOf(at)!;
  if (y <= box.bottom) return { index: at, gap: null };
  const next = visibleFrom(at + 1, n - 1);
  const gap = { before: kids[at], after: next >= 0 ? kids[next] : null };
  if (next >= 0 && boxOf(next)!.top - y < y - box.bottom) return { index: next, gap };
  return { index: at, gap };
}

/** First index in [lo, hi) where `after(i)` holds, `after` being false then true over the range. */
function lowerBound(lo: number, hi: number, after: (i: number) => boolean): number {
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (after(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The segments (document order) inside `el`, as an index range [from, to): binary searches, no layout. */
function runWithin(segments: readonly Segment[], el: Element): [number, number] {
  const pos = (i: number) => el.compareDocumentPosition(segments[i].node);
  const from = lowerBound(0, segments.length, (i) => !(pos(i) & Node.DOCUMENT_POSITION_PRECEDING) || el.contains(segments[i].node));
  const to = lowerBound(from, segments.length, (i) => !el.contains(segments[i].node));
  return [from, to];
}

/** The segments of `parent` after block `before` and before block `after` (null: its start / end), as [from, to). */
function runBetween(segments: readonly Segment[], parent: Element, before: Element | null, after: Element | null): [number, number] {
  const range = document.createRange();
  if (before) range.setStartAfter(before);
  else range.setStart(parent, 0);
  if (after) range.setEndBefore(after);
  else range.setEnd(parent, parent.childNodes.length);
  // A leaf's point (node, 0) is before, inside or after the range: -1, 0, 1 over document order.
  const from = lowerBound(0, segments.length, (i) => range.comparePoint(segments[i].node, 0) >= 0);
  const to = lowerBound(from, segments.length, (i) => range.comparePoint(segments[i].node, 0) > 0);
  return [from, to];
}

const nonBlank = (seg: Segment) => !seg.br && seg.node.data.trim() !== '';

/**
 * Narrows segments [from, to) to the one whose box holds `y` (client), or, in a gap, the nearer of the
 * non-blank ones either side of it, with one Range box read per probe: [from, to) of the result. Null without
 * a non-blank segment that has a box. Assumes the run's text flows top to bottom.
 */
export function bisectRun(segments: readonly Segment[], from: number, to: number, y: number): [number, number] | null {
  const range = document.createRange();
  const boxOf = (seg: Segment): DOMRect | null => {
    range.selectNodeContents(seg.node);
    const r = range.getBoundingClientRect();
    return r.height > 0 ? r : null;
  };
  let lo = from;
  let hi = to - 1;
  let above = -1;
  let below = -1;
  let aboveBottom = 0;
  let belowTop = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let j = mid;
    let r: DOMRect | null = null;
    for (; j <= hi; j++) if (nonBlank(segments[j]) && (r = boxOf(segments[j]))) break;
    if (!r) {
      hi = mid - 1;
    } else if (r.bottom < y) {
      above = j;
      aboveBottom = r.bottom;
      lo = j + 1;
    } else if (r.top > y) {
      below = j;
      belowTop = r.top;
      hi = mid - 1;
    } else {
      return [j, j + 1];
    }
  }
  if (above < 0 && below < 0) return null;
  // In the gap between two segments: the nearer one holds the nearest line (its last or its first).
  const pick = below < 0 || (above >= 0 && y - aboveBottom <= belowTop - y) ? above : below;
  return [pick, pick + 1];
}

/**
 * `offsetsToRange` over a prebuilt text index (the section's, built once): the same range, without
 * walking the section's text nodes for every highlight and hit.
 */
export function rangeIn(idx: TextIndex, start: number, end: number): Range | null {
  if (start < 0 || end > idx.text.length || start >= end) return null;
  const s = segmentAt(idx.segments, start);
  const e = segmentEndingAt(idx.segments, end);
  if (!s || !e) return null;
  const r = document.createRange();
  if (s.br) r.setStartBefore(s.node);
  else r.setStart(s.node, start - s.start);
  if (e.br) r.setEndAfter(e.node);
  else r.setEnd(e.node, end - e.start);
  return r;
}

/** The segment where a range ending at `o` ends (`start < o <= start + length`), or undefined. */
function segmentEndingAt(segments: readonly Segment[], o: number): Segment | undefined {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const g = segments[mid];
    if (o <= g.start) hi = mid - 1;
    else if (o > g.start + g.length) lo = mid + 1;
    else return g;
  }
  return undefined;
}

/** The segment holding text offset `o`, or undefined. */
function segmentAt(segments: readonly Segment[], o: number): Segment | undefined {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const g = segments[mid];
    if (o < g.start) hi = mid - 1;
    else if (o >= g.start + g.length) lo = mid + 1;
    else return g;
  }
  return undefined;
}

function skipBlank(data: string, from: number): number {
  let i = from;
  while (i < data.length && /\s/.test(data[i])) i++;
  return i < data.length ? i : from;
}
