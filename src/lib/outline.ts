import { compareLocations, spotOf } from './location';
import type { Location, OutlineEntry } from './types';

/**
 * A level as it takes part in the lookup: an entry without a page (unresolvable destination) is
 * transparent, so its children stand in its place, in document order. It is never a section itself.
 */
function visibleLevel(level: readonly OutlineEntry[]): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  for (const e of level) {
    if (e.page === null) out.push(...visibleLevel(e.children));
    else out.push(e);
  }
  return out;
}

/**
 * The sections `page` is in, outermost first (spec §3.3): at each level the last entry in document
 * order whose page is at or before `page`, then the same among its children. Entries without a page
 * are transparent (see `visibleLevel`).
 */
export function sectionPath(outline: readonly OutlineEntry[], page: number): OutlineEntry[] {
  return pathWhere(outline, (e) => e.page !== null && e.page <= page);
}

/** At each level the last visible entry that `starts` accepts, then the same among its children. */
function pathWhere(outline: readonly OutlineEntry[], starts: (e: OutlineEntry) => boolean): OutlineEntry[] {
  const path: OutlineEntry[] = [];
  let level: readonly OutlineEntry[] = outline;
  for (;;) {
    let pick: OutlineEntry | null = null;
    for (const e of visibleLevel(level)) if (starts(e)) pick = e;
    if (!pick) return path;
    path.push(pick);
    level = pick.children;
  }
}

/** Title of the deepest section containing `page`; null without an outline or before its first entry. */
export function sectionFor(outline: readonly OutlineEntry[], page: number): string | null {
  const path = sectionPath(outline, page);
  return path.length ? path[path.length - 1].title : null;
}

/**
 * Title of the deepest section containing `loc`. Entries with an exact target (`at`, epub anchors) count
 * when it is at or before `loc` in reading order, so two entries in one section split it; entries
 * without one go by page, as in `sectionFor`. null for a location without a page.
 */
export function sectionAt(outline: readonly OutlineEntry[], loc: Location): string | null {
  const path = sectionPathAt(outline, loc);
  return path.length ? path[path.length - 1].title : null;
}

/** `sectionPath` for a location: the path `sectionAt` names the end of. [] for a location without a page. */
export function sectionPathAt(outline: readonly OutlineEntry[], loc: Location): OutlineEntry[] {
  const spot = spotOf(loc);
  if (!spot) return [];
  return pathWhere(outline, (e) => (e.at ? compareLocations(e.at, loc) <= 0 : e.page !== null && e.page <= spot.page));
}

/** Thoughts per outline entry. A thought counts toward every section on its path, so a chapter includes its subsections. */
export function countBySection(outline: readonly OutlineEntry[], pages: readonly number[]): Map<OutlineEntry, number> {
  const counts = new Map<OutlineEntry, number>();
  for (const p of pages) {
    for (const e of sectionPath(outline, p)) counts.set(e, (counts.get(e) ?? 0) + 1);
  }
  return counts;
}
