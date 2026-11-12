import { buildMarginUrl } from '../../lib/deeplink';
import { compareLocations, pageLocation, parseLocation } from '../../lib/location';
import {
  COLORS,
  type Annotation,
  type Color,
  type Location,
  type Thought,
  type ThoughtPatchInput,
} from '../../lib/types';

export type EntryType = 'highlight' | 'note' | 'thought';
export const ENTRY_TYPES: readonly EntryType[] = ['highlight', 'note', 'thought'];

export type NotebookEntry =
  | { kind: 'annotation'; annotation: Annotation; location: Location | null }
  | { kind: 'thought'; thought: Thought; location: Location | null; anchor: Annotation | null };

export interface NotebookGroup {
  key: string; // 'general' | `loc:${label}` | 'unanchored'
  label: string;
  entries: NotebookEntry[];
}

export interface NotebookFilter {
  types: ReadonlySet<EntryType>;
  colors: ReadonlySet<Color>;
}

export const SHOW_ALL: NotebookFilter = { types: new Set(ENTRY_TYPES), colors: new Set(COLORS) };

export const annotationType = (a: Annotation): 'highlight' | 'note' => (a.note ? 'note' : 'highlight');

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byPosition = (a: Thought, b: Thought) => a.position - b.position || cmp(a.id, b.id);

interface Bucket {
  label: string;
  first: Location;
  annotations: { annotation: Annotation; location: Location }[];
  thoughts: { thought: Thought; location: Location }[];
}

/**
 * The notebook stream in reading order (spec §6). "General" thoughts come first, then one group
 * per Location.label ordered by its earliest location, then "Unanchored" highlights. Within a
 * group, annotations go by offset, each followed by its anchored thoughts. Location-only thoughts
 * come after the group's annotations. Thoughts sort by `position`. The colour filter narrows
 * highlights and notes only; thoughts are filtered by type.
 */
export function buildNotebook(
  annotations: Annotation[],
  thoughts: Thought[],
  filter: NotebookFilter = SHOW_ALL,
): NotebookGroup[] {
  const showThoughts = filter.types.has('thought');
  const showAnnotation = (a: Annotation) => filter.types.has(annotationType(a)) && filter.colors.has(a.color);

  const byId = new Map(annotations.map((a) => [a.id, a]));
  const anchored = new Map<string, Thought[]>();
  const general: Thought[] = [];
  const located: { thought: Thought; location: Location }[] = [];
  for (const t of thoughts) {
    if (t.anchorId && byId.has(t.anchorId)) {
      anchored.set(t.anchorId, [...(anchored.get(t.anchorId) ?? []), t]);
      continue;
    }
    // A stale anchor (annotation not loaded) falls back to the thought's own location.
    const location = parseLocation(t.location);
    if (location) located.push({ thought: t, location });
    else general.push(t);
  }

  const buckets = new Map<string, Bucket>();
  const bucketFor = (location: Location): Bucket => {
    const existing = buckets.get(location.label);
    if (existing) {
      if (compareLocations(location, existing.first) < 0) existing.first = location;
      return existing;
    }
    const created: Bucket = { label: location.label, first: location, annotations: [], thoughts: [] };
    buckets.set(location.label, created);
    return created;
  };
  const unanchored: Annotation[] = [];
  for (const a of annotations) {
    const location = parseLocation(a.location);
    if (a.unanchored || !location) unanchored.push(a);
    else bucketFor(location).annotations.push({ annotation: a, location });
  }
  for (const x of located) bucketFor(x.location).thoughts.push(x);

  const thoughtEntry = (thought: Thought, location: Location | null, anchor: Annotation | null): NotebookEntry => ({
    kind: 'thought',
    thought,
    location,
    anchor,
  });
  const withThoughts = (a: Annotation, location: Location | null): NotebookEntry[] => {
    const out: NotebookEntry[] = [];
    if (showAnnotation(a)) out.push({ kind: 'annotation', annotation: a, location });
    if (showThoughts) {
      for (const t of [...(anchored.get(a.id) ?? [])].sort(byPosition)) out.push(thoughtEntry(t, location, a));
    }
    return out;
  };

  const groups: NotebookGroup[] = [];
  const push = (key: string, label: string, entries: NotebookEntry[]) => {
    if (entries.length) groups.push({ key, label, entries });
  };

  push('general', 'General', showThoughts ? [...general].sort(byPosition).map((t) => thoughtEntry(t, null, null)) : []);
  for (const b of [...buckets.values()].sort((x, y) => compareLocations(x.first, y.first))) {
    const anns = [...b.annotations].sort(
      (x, y) => compareLocations(x.location, y.location) || cmp(x.annotation.createdAt, y.annotation.createdAt),
    );
    const pageThoughts = showThoughts ? [...b.thoughts].sort((x, y) => byPosition(x.thought, y.thought)) : [];
    push(`loc:${b.label}`, b.label, [
      ...anns.flatMap((x) => withThoughts(x.annotation, x.location)),
      ...pageThoughts.map((x) => thoughtEntry(x.thought, x.location, null)),
    ]);
  }
  push(
    'unanchored',
    'Unanchored',
    [...unanchored].sort((x, y) => cmp(x.createdAt, y.createdAt)).flatMap((a) => withThoughts(a, null)),
  );
  return groups;
}

/** The margin:// link for an entry, or null when the entry has no place in the book. */
export function linkForEntry(entry: NotebookEntry): string | null {
  if (!entry.location) return null;
  if (entry.kind === 'annotation') return buildMarginUrl(entry.annotation.bookId, { annotationId: entry.annotation.id });
  if (entry.anchor) return buildMarginUrl(entry.thought.bookId, { annotationId: entry.anchor.id });
  return buildMarginUrl(entry.thought.bookId, { location: entry.location });
}

/**
 * "Unlink": an anchored thought keeps the highlight's page as a page-level location; a page
 * thought becomes general. Null when an anchored thought's highlight is not loaded and the thought
 * has no location of its own: unlinking would silently move it into General.
 */
export function unlinkPatch(thought: Thought, anchor: Annotation | null): ThoughtPatchInput | null {
  if (thought.anchorId) {
    const loc = parseLocation(anchor ? anchor.location : thought.location);
    if (!anchor && !loc) return null;
    return { anchorId: null, location: loc ? pageLocation(loc) : null };
  }
  return { location: null };
}
