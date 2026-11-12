import type { EpubLocationValue, Format, Location, PdfLocationValue } from './types';

export function pdfLocation(value: PdfLocationValue): Location {
  return { kind: 'pdf', value, label: `p. ${value.page}` };
}

/** A point (no selection) on a pdf page: `start === end` = the start of a text line; `y` = its top as a fraction of the page height. */
export function pdfPoint(page: number, offset: number, y?: number): Location {
  return pdfLocation(y === undefined ? { page, start: offset, end: offset } : { page, start: offset, end: offset, y });
}

/**
 * The EPUB text model new locations are written in (`EpubLocationValue.v`): which sections a book has and
 * what text their offsets index. It is the sanitiser's `SANITIZER_VERSION` (sanitize.ts lists what belongs
 * to the model). A stored location without `v` was written under model 3.
 */
export const EPUB_TEXT_MODEL = 3;

/** An epub place: offsets into section `section`'s text (1-based spine index). Labelled `§ N`. Stamped with its text model (`v`, the current one unless given). */
export function epubLocation(value: EpubLocationValue): Location {
  return { kind: 'epub', value: { ...value, v: value.v ?? EPUB_TEXT_MODEL }, label: `§ ${value.section}` };
}

/** A point in an epub section: `start === end`; `y` = its top as a fraction of the section's height. */
export function epubPoint(section: number, offset: number, y?: number): Location {
  return epubLocation(
    y === undefined ? { section, start: offset, end: offset } : { section, start: offset, end: offset, y },
  );
}

/** Formats read as a column of page boxes (pdf pages, epub sections). */
export const isPagedFormat = (f: Format): f is 'pdf' | 'epub' => f === 'pdf' || f === 'epub';

/**
 * A place in a paged format, format-neutral: `page` is the pdf page or the epub section (both 1-based),
 * the offsets index that page's text, `y` (points only) is a 0–1 fraction of its height.
 */
export interface Spot {
  page: number;
  start: number;
  end: number;
  y?: number;
}

const spotFrom = (page: number, v: { start: number; end: number; y?: number }): Spot =>
  v.y === undefined ? { page, start: v.start, end: v.end } : { page, start: v.start, end: v.end, y: v.y };

/** The paged spot of a location: pdf and epub; null for kinds without pages ('text'). */
export function spotOf(loc: Location): Spot | null {
  if (loc.kind === 'pdf') return spotFrom(loc.value.page, loc.value);
  if (loc.kind === 'epub') return spotFrom(loc.value.section, loc.value);
  return null;
}

/** The same kind of location at another spot, label recomputed. A 'text' location has no spot and is returned as is. */
export function withSpot(loc: Location, spot: Spot): Location {
  const { page, start, end, y } = spot;
  if (loc.kind === 'pdf') return pdfLocation(y === undefined ? { page, start, end } : { page, start, end, y });
  if (loc.kind === 'epub') {
    // Same book, same text model: the new spot keeps the location's `v`.
    const v = loc.value.v;
    return epubLocation(y === undefined ? { section: page, start, end, v } : { section: page, start, end, y, v });
  }
  return loc;
}

/** The name of a page in a paged format: `p. 42` (pdf) or `§ 7` (epub). */
export function placeNameFor(format: 'pdf' | 'epub', page: number): string {
  return format === 'epub' ? `§ ${page}` : `p. ${page}`;
}

/** What a location's page is called: `p. 42`, `§ 7`, or the location's own label for kinds without pages. */
export function placeName(loc: Location): string {
  const spot = spotOf(loc);
  return spot && (loc.kind === 'pdf' || loc.kind === 'epub') ? placeNameFor(loc.kind, spot.page) : loc.label;
}

/** True for pin locations: a paged point that carries its `y`. Page-level locations (`start = end = 0`, no `y`) are not points. */
export const isPoint = (loc: Location): boolean => {
  const spot = spotOf(loc);
  return spot !== null && spot.start === spot.end && spot.y !== undefined;
};

/** The old name of `isPoint`, from when only a pdf had points. */
export const isPdfPoint = isPoint;

export function serializeLocation(loc: Location): string {
  return JSON.stringify(loc);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Offsets and `y` of a paged location value: whole offsets, `0 <= start <= end`, `y` within 0–1. */
const validOffsets = (val: Record<string, unknown>): boolean =>
  isInt(val.start) &&
  isInt(val.end) &&
  val.start >= 0 &&
  val.start <= val.end &&
  (val.y === undefined || (isNum(val.y) && val.y >= 0 && val.y <= 1));

export function parseLocation(json: string | null | undefined): Location | null {
  if (!json) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as { kind?: unknown; value?: unknown; label?: unknown };
  if (typeof o.label !== 'string' || !o.value || typeof o.value !== 'object') return null;
  const val = o.value as Record<string, unknown>;
  switch (o.kind) {
    case 'pdf':
      return isInt(val.page) && val.page >= 1 && validOffsets(val) ? (v as Location) : null;
    case 'epub': {
      // The old `{ cfi }` shape was never written; it has no section and is rejected here.
      if (!(isInt(val.section) && val.section >= 1 && validOffsets(val))) return null;
      if (val.v === undefined) return { ...(v as Location), value: { ...(val as unknown as EpubLocationValue), v: 3 } } as Location;
      return isInt(val.v) && val.v >= 1 ? (v as Location) : null;
    }
    case 'text':
      return isNum(val.start) && isNum(val.end) ? (v as Location) : null;
    default:
      return null;
  }
}

/** Same place with in-page offsets dropped: what "this page" means for a thought. */
export function pageLocation(loc: Location): Location {
  const spot = spotOf(loc);
  return spot ? withSpot(loc, { page: spot.page, start: 0, end: 0 }) : loc;
}

/** Reading order: negative when `a` comes first. pdf and epub: page (section), then start offset, then y. */
export function compareLocations(a: Location, b: Location): number {
  if (a.kind === b.kind) {
    const sa = spotOf(a);
    const sb = spotOf(b);
    if (sa && sb) return sa.page - sb.page || sa.start - sb.start || (sa.y ?? 0) - (sb.y ?? 0);
  }
  if (a.kind === 'text' && b.kind === 'text') return a.value.start - b.value.start;
  // A book has one kind; mixed kinds only meet in corrupt data. Keep the sort total.
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}

/** Same page (pdf) or section (epub), or same label (other kinds): drives the notebook's "current page" highlight. */
export function sameSpot(a: Location, b: Location): boolean {
  if (a.kind !== b.kind) return false;
  const sa = spotOf(a);
  const sb = spotOf(b);
  if (sa && sb) return sa.page === sb.page;
  return a.label === b.label;
}

/** Where a new book of a paged format starts: page 1 / section 1, no offsets. */
export function startLocation(format: 'pdf' | 'epub'): Location {
  return format === 'epub' ? epubLocation({ section: 1, start: 0, end: 0 }) : pdfLocation({ page: 1, start: 0, end: 0 });
}
