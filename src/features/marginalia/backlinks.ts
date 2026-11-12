import { compareLocations, serializeLocation, spotOf } from '../../lib/location';
import type { Location } from '../../lib/types';

/**
 * A note elsewhere (Obsidian: a vault note) that links into this book. The host finds them; the margin
 * shows them as quiet markers at their place, and the notebook counts the notes.
 */
export interface Backlink {
  /** Stable across refreshes for the same link. */
  id: string;
  /** Where it points: an exact place, or a page (`#page=N`: start = end = 0). */
  location: Location;
  sourcePath: string;
  /** The linking note's name. */
  sourceTitle: string;
  /** The line holding the link, made readable. */
  snippet: string;
  /** That line (0-based), for the host to open the note there. */
  line?: number;
}

/** The links to one place: one marker in the margin. */
export interface BacklinkMarker {
  key: string;
  location: Location;
  page: number;
  links: Backlink[];
  /** How many distinct notes link here. */
  notes: number;
}

/** The margin's markers: links grouped by place (paged locations only), in reading order. */
export function backlinkMarkers(links: readonly Backlink[]): BacklinkMarker[] {
  const byKey = new Map<string, BacklinkMarker>();
  for (const link of links) {
    const spot = spotOf(link.location);
    if (!spot) continue;
    const key = serializeLocation(link.location);
    let m = byKey.get(key);
    if (!m) {
      m = { key, location: link.location, page: spot.page, links: [], notes: 0 };
      byKey.set(key, m);
    }
    if (!m.links.some((l) => l.id === link.id)) m.links.push(link);
  }
  const out = [...byKey.values()];
  for (const m of out) m.notes = new Set(m.links.map((l) => l.sourcePath)).size;
  return out.sort((a, b) => compareLocations(a.location, b.location) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** How many distinct notes link into the book. */
export function linkingNotes(links: readonly Backlink[]): number {
  return new Set(links.map((l) => l.sourcePath)).size;
}

/** "1 note links here", "2 notes link here". */
export function linkedFromText(n: number): string {
  return n === 1 ? '1 note links here' : `${n} notes link here`;
}
