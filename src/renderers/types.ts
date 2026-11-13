import type { Color, Location, OutlineEntry } from '../lib/types';

export interface SelectionInfo {
  location: Location;
  quote: string;
  rect: DOMRect;
}

export interface PaintableAnnotation {
  id: string;
  location: Location;
  color: Color;
  quote: string;
  unanchored: boolean;
  /** Created moments ago: painted so it inks in (spec §6). */
  fresh?: boolean;
}

export type Unsubscribe = () => void;

/** A page box in the scroller's content coordinates (offsetTop/offsetLeft); `ready` = its text layer is rendered. */
export interface PageLayoutBox {
  page: number;
  top: number;
  left: number;
  width: number;
  height: number;
  ready: boolean;
}

export interface PageLayout {
  scale: number;
  pages: PageLayoutBox[];
  /**
   * The fit area's right edge (`scroller.clientWidth − margin width`) in content coordinates: the margin
   * column anchors to it. The PDF renderer always sets it; optional so a layout without one (tests, other
   * formats) lets the widest page decide.
   */
  fitRight?: number;
}

/** Where a thought's spot sits, in the scroller's content coordinates (the space of PageLayoutBox). */
export interface AnchorPoint {
  /** Top of the spot's line. */
  top: number;
  /** Where its thread ends: a highlight's first-line end, or just inside the page's right edge. */
  x: number;
  /** True when read from the rendered text layer; false when estimated (the page isn't rendered). */
  measured: boolean;
}

/** 'fit-width', 'fit-page' or a fixed percentage; 100 % = pdf.js scale 1 (one PDF point per CSS pixel). */
export type Zoom = 'fit-width' | 'fit-page' | number;

export interface GoToOptions {
  flash?: boolean;
  /** A newer jump replaced this one: skip the scroll (an older jump must never land after a newer one). */
  superseded?: () => boolean;
}

/** The zoom mode and the effective percentage it gives right now. */
export interface ZoomState {
  zoom: Zoom;
  percent: number;
}

/** One match: offsets into the page's text-layer text, plus a one-line snippet for the results list. */
export interface SearchHit {
  page: number;
  start: number;
  end: number;
  snippet: { before: string; match: string; after: string };
}

/** One scanned page: its hits (maybe none) and whether it had any text at all (scanned pages don't). */
export interface SearchBatch {
  page: number;
  hits: SearchHit[];
  noText: boolean;
}

export interface OpenOptions {
  onPageSize?: (size: { width: number; height: number }) => void;
}

export interface RendererAdapter {
  /**
   * `onPageSize`: called with page 1's size at scale 1 as soon as it is read, before any page is built or
   * fitted, so the caller can settle what depends on it (the margin mode and its reserve) before the first fit.
   */
  open(data: ArrayBuffer, at?: Location | null, opts?: OpenOptions): Promise<void>;
  /** `superseded`: checked once the target page is ready; when it returns true the jump does not scroll. */
  goTo(location: Location, opts?: GoToOptions): Promise<void>;
  onSelection(cb: (sel: SelectionInfo | null) => void): Unsubscribe;
  /** The page text selected right now (the live selection); null without one. */
  currentSelection(): SelectionInfo | null;
  onLocationChange(cb: (loc: Location) => void): Unsubscribe;
  onHighlightClick(cb: (hit: { id: string; rect: DOMRect }) => void): Unsubscribe;
  onAnchorMismatch(cb: (a: PaintableAnnotation) => void): Unsubscribe;
  paintHighlights(annotations: PaintableAnnotation[]): void;
  findQuote(quote: string, near?: Location | null): Promise<Location | null>;
  /** 0 until the book is open. */
  pageCount(): number;
  /**
   * The table of contents (cached); [] without one, before open or after close. Rejects when it
   * couldn't be read, so "couldn't read" is never mistaken for "no outline" (a later call retries).
   */
  getOutline(): Promise<OutlineEntry[]>;
  /**
   * A page's text in the offset model (cached, deduped); '' for a page that has no text. Rejects when it
   * couldn't be read (closed, bad page, fetch error), so "couldn't read" is never mistaken for "no text".
   */
  getPageText(page: number): Promise<string>;
  /**
   * The text a range of this book's kind of location covers, in the offset model a selection's quote is
   * read from (a merged highlight's quote); null for another kind, a point, or offsets past the page's text.
   * Rejects like getPageText when the text couldn't be read.
   */
  quoteAt(location: Location): Promise<string | null>;
  /**
   * Point location at the text line nearest `clientY` on `page`; `y`-only (offset 0) on a rendered page
   * without text. Null when the page isn't rendered: its lines are unknown, so no offset is invented.
   */
  pointAt(clientY: number, page: number): Location | null;
  /** Point location at the reading line (a third down the viewport), after that page has rendered. */
  readingLinePoint(): Promise<Location | null>;
  /**
   * Page boxes after open, re-fit/zoom, and whenever a page renders or is released. A new subscriber gets
   * the current boxes at once (once open); with no subscriber the renderer reads no page boxes at all.
   */
  onPageLayout(cb: (layout: PageLayout) => void): Unsubscribe;
  getZoom(): ZoomState;
  /**
   * Before open: remembered and used by open(). After: re-lays out keeping the reading line (or `anchor`) in
   * place. `smooth` (a percentage from a zoom button or key) animates there first, unless motion is reduced.
   */
  setZoom(zoom: Zoom, opts?: { anchor?: { clientX: number; clientY: number }; smooth?: boolean }): void;
  onZoomChange(cb: (zoom: ZoomState) => void): Unsubscribe;
  /** Streams one batch per page, from `fromPage` (default: the current page) and wrapping; ends quietly when aborted. */
  search(query: string, opts?: { signal?: AbortSignal; fromPage?: number }): AsyncIterable<SearchBatch>;
  /** Paints hits on the search layer (replacing earlier ones); `current` pulses. */
  showSearchHits(hits: readonly SearchHit[], current: SearchHit | null): void;
  clearSearch(): void;
  /** Page 1's size at scale 1; null before open. */
  pageSize(): { width: number; height: number } | null;
  /** The layer inside the scroller that the margin column renders into (content coordinates; scrolls with the pages). */
  marginLayer(): HTMLElement;
  /** Room (px) right of the pages for the margin column; fit zooms fit the pages into the rest. 0 = none. */
  setMarginWidth(px: number): void;
  /** Each location's spot; null for another format or a missing page. Measured on rendered pages, estimated on others. */
  anchorPoints(locations: readonly Location[]): (AnchorPoint | null)[];
  /** The highlight shown fully filled because its popover is open or its margin note has focus; null for none. */
  setActiveHighlight(id: string | null): void;
  /**
   * Optional (EPUB only): a click on a link to another place in the book. With a subscriber the renderer
   * only reports the target, so the reader can route the jump through its own navigation (and "back");
   * without one it jumps there itself.
   */
  onInternalLink?(cb: (to: Location) => void): Unsubscribe;
  close(): void;
}
