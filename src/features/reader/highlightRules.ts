import { parseLocation, spotOf, withSpot, type Spot } from '../../lib/location';
import { normalizeText } from '../../renderers/pdf/findQuote';
import type {
  Annotation,
  AnnotationPatchInput,
  Color,
  Location,
  NewAnnotationInput,
  Thought,
  ThoughtPatchInput,
} from '../../lib/types';

/**
 * A highlight over a highlight never stacks (one Delete must remove what the reader sees):
 * - a selection inside (or equal to) one highlight changes that highlight;
 * - a selection that overlaps or covers highlights merges them into one over the union;
 * - otherwise a new highlight.
 * Overlap is measured in the location model (same page or section, offsets); ranges that only touch
 * at an end don't overlap. Unanchored highlights aren't painted where their offsets say and are left out.
 */
export type HighlightPlan =
  | { kind: 'create' }
  | { kind: 'update'; target: Annotation }
  | { kind: 'merge'; overlapped: Annotation[]; location: Location };

/** An EPUB location's text model (absent: model 3); null for other kinds. */
const textModel = (loc: Location): number | null => (loc.kind === 'epub' ? (loc.value.v ?? 3) : null);

/**
 * A highlight's spot, when it is a painted range in the same kind of location as `like` (for EPUB, written
 * in the same text model: offsets of another model index other text).
 */
function rangeSpot(a: Annotation, like: Location): Spot | null {
  if (a.unanchored) return null;
  const loc = parseLocation(a.location);
  if (!loc || loc.kind !== like.kind || textModel(loc) !== textModel(like)) return null;
  const s = spotOf(loc);
  return s && s.start < s.end ? s : null;
}

const byAge = (a: Annotation, b: Annotation) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function planHighlight(items: readonly Annotation[], bookId: string, location: Location): HighlightPlan {
  const sel = spotOf(location);
  if (!sel || sel.start >= sel.end) return { kind: 'create' };
  const hits: { a: Annotation; s: Spot }[] = [];
  for (const a of items) {
    if (a.bookId !== bookId) continue;
    const s = rangeSpot(a, location);
    if (s && s.page === sel.page && s.start < sel.end && sel.start < s.end) hits.push({ a, s });
  }
  if (hits.length === 0) return { kind: 'create' };
  if (hits.length === 1 && hits[0].s.start <= sel.start && sel.end <= hits[0].s.end) {
    return { kind: 'update', target: hits[0].a };
  }
  const start = Math.min(sel.start, ...hits.map((h) => h.s.start));
  const end = Math.max(sel.end, ...hits.map((h) => h.s.end));
  return {
    kind: 'merge',
    overlapped: hits.map((h) => h.a).sort(byAge),
    location: withSpot(location, { page: sel.page, start, end }),
  };
}

const paragraphs = (n: string) => n.split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean);

/**
 * The first non-empty note kept exactly as written (the user's text: its spacing, repeats and blank lines),
 * followed by each paragraph of the later notes it doesn't already hold (compared trimmed), a blank line
 * apart. So a merge run again (after a crash between its writes) never repeats text. Null when all are empty.
 */
export function joinNotes(notes: readonly (string | null | undefined)[]): string | null {
  let out: string | null = null;
  const seen = new Set<string>();
  for (const n of notes) {
    if (!n?.trim()) continue;
    if (out === null) {
      out = n;
      for (const p of paragraphs(n)) seen.add(p);
      continue;
    }
    for (const p of paragraphs(n)) {
      if (seen.has(p)) continue;
      seen.add(p);
      out += `\n\n${p}`;
    }
  }
  return out;
}

/** The note as joinNotes sees it: null when blank, else exactly as stored. */
const noteOf = (n: string | null | undefined): string | null => (n?.trim() ? n : null);

export interface HighlightOps {
  create: (input: Omit<NewAnnotationInput, 'bookId'>) => Promise<Annotation>;
  update: (id: string, patch: AnnotationPatchInput) => Promise<Annotation>;
  remove: (id: string) => Promise<void>;
  updateThought: (id: string, patch: ThoughtPatchInput) => Promise<unknown>;
  thoughts: readonly Thought[];
  /** The renderer's text for a range (the union's quote); null when it can't be read. */
  quoteAt: (location: Location) => Promise<string | null>;
  /** The backend's updateAnnotation honours `quote` (Obsidian). Without it a merge creates the union anew. */
  patchesQuote: boolean;
}

export interface HighlightRequest {
  location: Location;
  quote: string;
  /** The colour chosen; none (a note, a thought) keeps an existing highlight's colour, and a new one is yellow. */
  color?: Color;
  note?: string;
}

/**
 * `created`: a new highlight over text no highlight touched; `updated`: an existing one recoloured (or
 * given the note); `merged`: one highlight now covers the union (reshaped, possibly a new id).
 * `reshaped`: the highlights a merge reshaped or replaced (their ids), so drafts made with them let go.
 */
export interface HighlightOutcome {
  annotation: Annotation;
  kind: 'created' | 'updated' | 'merged';
  reshaped?: string[];
}

/** Moves the thoughts hanging off `from` onto `to`. */
async function moveThoughts(ops: HighlightOps, from: readonly Annotation[], to: string): Promise<void> {
  const ids = new Set(from.map((a) => a.id));
  for (const t of ops.thoughts) {
    if (t.anchorId !== null && ids.has(t.anchorId)) await ops.updateThought(t.id, { anchorId: to });
  }
}

/** Highlights `req` under the rules above; the one place a selection becomes a highlight. */
export async function applyHighlight(
  items: readonly Annotation[],
  bookId: string,
  req: HighlightRequest,
  ops: HighlightOps,
): Promise<HighlightOutcome> {
  const plan = planHighlight(items, bookId, req.location);
  const createSelection = async (): Promise<HighlightOutcome> => {
    const color = req.color ?? 'yellow';
    const input =
      req.note === undefined
        ? { location: req.location, quote: req.quote, color }
        : { location: req.location, quote: req.quote, color, note: req.note };
    return { annotation: await ops.create(input), kind: 'created' };
  };
  if (plan.kind === 'create') return createSelection();

  /** The request applied to one existing highlight: its colour, its note joined; nothing written when nothing changes. */
  const patchOne = async (a: Annotation, withNote: boolean): Promise<Annotation> => {
    const patch: AnnotationPatchInput = {};
    if (req.color && req.color !== a.color) patch.color = req.color;
    if (withNote && req.note !== undefined) {
      const note = joinNotes([a.note, req.note]);
      if (note !== noteOf(a.note)) patch.note = note ?? '';
    }
    return Object.keys(patch).length === 0 ? a : ops.update(a.id, patch);
  };

  if (plan.kind === 'update') return { annotation: await patchOne(plan.target, true), kind: 'updated' };

  const [survivor, ...others] = plan.overlapped;
  const quote = await ops.quoteAt(plan.location).catch(() => null);
  if (!quote?.trim()) {
    // The union can't be read as one quote: the overlapped highlights take the colour (the oldest the note)
    // and nothing new is made, which would stack again. A thought hangs off the oldest.
    const first = await patchOne(survivor, true);
    for (const a of others) await patchOne(a, false);
    return { annotation: first, kind: 'updated' };
  }
  const color = req.color ?? survivor.color;
  const note = joinNotes([...plan.overlapped.map((a) => a.note), req.note]);
  if (ops.patchesQuote) {
    const patch: AnnotationPatchInput = { location: plan.location, quote, color };
    if (note !== noteOf(survivor.note)) patch.note = note ?? '';
    const merged = await ops.update(survivor.id, patch);
    await moveThoughts(ops, others, survivor.id);
    for (const a of others) await ops.remove(a.id);
    return { annotation: merged, kind: 'merged', reshaped: plan.overlapped.map((a) => a.id) };
  }
  // The backend can't rewrite a quote (desktop): the union is a new highlight, the overlapped ones go.
  // Accepted for now (fixing it needs a quote in the Rust patch): the merged highlight gets a new id, so
  // older margin:// links to the overlapped highlights stop resolving. See obsidian/README.md, Known limits.
  const merged = await ops.create(
    note === null ? { location: plan.location, quote, color } : { location: plan.location, quote, color, note },
  );
  await moveThoughts(ops, plan.overlapped, merged.id);
  for (const a of plan.overlapped) await ops.remove(a.id);
  return { annotation: merged, kind: 'merged', reshaped: plan.overlapped.map((a) => a.id) };
}

/**
 * What makes two highlights true duplicates: an anchored one, at the same place (kind, page or section,
 * offsets, EPUB text model) with the same quote. Unanchored highlights (their offsets are stale) never are.
 */
const sameSpotKey = (a: Annotation): string | null => {
  if (a.unanchored) return null;
  const loc = parseLocation(a.location);
  const s = loc && spotOf(loc);
  if (!loc || !s) return null;
  return JSON.stringify([a.bookId, loc.kind, s.page, s.start, s.end, s.y ?? null, textModel(loc), normalizeText(a.quote)]);
};

export interface CollapseOps {
  listThoughts: () => Promise<Thought[]>;
  update: (id: string, patch: AnnotationPatchInput) => Promise<Annotation>;
  updateThought: (id: string, patch: ThoughtPatchInput) => Promise<unknown>;
  remove: (id: string) => Promise<void>;
}

/**
 * Highlights stacked at exactly the same place (left by older versions) become one: the oldest keeps its
 * id and takes the most recently updated colour and every note; the others' thoughts move onto it and the
 * others are deleted. Partial overlaps are left alone. Returns the list without the duplicates, and
 * whether anything changed.
 */
export async function collapseDuplicates(
  items: readonly Annotation[],
  ops: CollapseOps,
): Promise<{ items: Annotation[]; changed: boolean }> {
  const groups = new Map<string, Annotation[]>();
  for (const a of items) {
    const key = sameSpotKey(a);
    if (key === null) continue;
    const g = groups.get(key);
    if (g) g.push(a);
    else groups.set(key, [a]);
  }
  const dupes = [...groups.values()].filter((g) => g.length > 1);
  if (dupes.length === 0) return { items: [...items], changed: false };
  const thoughts = await ops.listThoughts();
  const replaced = new Map<string, Annotation>();
  const gone = new Set<string>();
  for (const g of dupes) {
    const sorted = [...g].sort(byAge);
    const [survivor, ...others] = sorted;
    const byUpdate = [...g].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : byAge(a, b)));
    const newest = byUpdate[byUpdate.length - 1];
    const note = joinNotes(sorted.map((a) => a.note));
    const patch: AnnotationPatchInput = {};
    if (newest.color !== survivor.color) patch.color = newest.color;
    if (note !== noteOf(survivor.note)) patch.note = note ?? '';
    if (Object.keys(patch).length) replaced.set(survivor.id, await ops.update(survivor.id, patch));
    const ids = new Set(others.map((a) => a.id));
    for (const t of thoughts) {
      if (t.anchorId !== null && ids.has(t.anchorId)) await ops.updateThought(t.id, { anchorId: survivor.id });
    }
    for (const a of others) {
      await ops.remove(a.id);
      gone.add(a.id);
    }
  }
  return { items: items.filter((a) => !gone.has(a.id)).map((a) => replaced.get(a.id) ?? a), changed: true };
}
