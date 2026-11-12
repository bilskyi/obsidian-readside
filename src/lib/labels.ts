import { parseLocation, placeName, spotOf } from './location';
import { sectionAt, sectionFor } from './outline';
import type { Annotation, Location, OutlineEntry, Thought } from './types';

const SNIPPET_WORDS = 8;
/** Code points, the trailing "…" included. */
const SNIPPET_CHARS = 60;
const TRAILING_PUNCTUATION = /[,;:\s]+$/;

const codePoints = (s: string): string[] => Array.from(s);

/** The leading words that fit `limit` code points and the word cap, joined with single spaces. */
function fit(words: readonly string[], limit: number): { body: string; taken: number } {
  let body = '';
  let taken = 0;
  for (const w of words) {
    if (taken === SNIPPET_WORDS) break;
    const next = body ? `${body} ${w}` : w;
    if (codePoints(next).length > limit) break;
    body = next;
    taken++;
  }
  return { body, taken };
}

/**
 * Opening words of the text, from the start of the line that contains `offset` (back to the previous
 * "\n"): whitespace collapsed, at most 8 words and 60 code points including the trailing "…". When the
 * text goes on, the body is cut to fit beside the "…" and trailing `,;:` and spaces are dropped first.
 * A first word longer than the limit is cut to its first code points.
 */
export function snippetWords(text: string, offset = 0): string {
  const at = Math.min(Math.max(0, offset), text.length);
  const start = at > 0 ? text.lastIndexOf('\n', at - 1) + 1 : 0;
  const words = text.slice(start).split(/\s+/).filter(Boolean);
  const whole = fit(words, SNIPPET_CHARS);
  if (whole.taken === words.length) return whole.body;
  let body = fit(words, SNIPPET_CHARS - 1).body;
  if (!body) body = codePoints(words[0]).slice(0, SNIPPET_CHARS - 1).join('');
  body = body.replace(TRAILING_PUNCTUATION, '') || body;
  return `${body}…`;
}

/** Fewer letters than this and a snippet names nothing: the label is the bare `p. N`. */
const MIN_SNIPPET_LETTERS = 3;
/**
 * A word that is only ligature glyphs (`fi`, `ffl`, `ﬁ`…): what a line of broken ligatures extracts to,
 * e.g. `fi ' fi ' fi fi ' '`. Its letters don't count.
 */
const LIGATURE_DEBRIS = /^(?:ffi|ffl|ff|fi|fl|[\uFB00-\uFB06])+$/u;

/** Letters (`\p{L}`) in the words, ligature debris left out. */
function snippetLetters(words: string): number {
  let n = 0;
  for (const w of words.split(/\s+/)) {
    const letters = w.match(/\p{L}/gu);
    if (letters && !LIGATURE_DEBRIS.test(letters.join(''))) n += letters.length;
  }
  return n;
}

/** `<place> · “words”`, or the bare place when the words have fewer than 3 letters. */
const placedSnippet = (place: string, words: string): string =>
  snippetLetters(words) >= MIN_SNIPPET_LETTERS ? `${place} · “${words}”` : place;

/** `p. 42 · “The law of least effort…”`, or `p. 42` when the words have fewer than 3 letters. */
export function snippetLabel(page: number, words: string): string {
  return placedSnippet(`p. ${page}`, words);
}

/** `snippetLabel` named by the location's place: `p. 42 · “…”` (pdf), `§ 7 · “…”` (epub). */
export function snippetLabelAt(loc: Location, words: string): string {
  return placedSnippet(placeName(loc), words);
}

export interface AutoLabels {
  section: string | null;
  snippet: string;
}

/**
 * The automatic label of a thought on `page`. `source` is the page text with `offset` at the start of
 * the thought's line, or (anchored thoughts) the highlight's quote with offset 0; null = no text.
 */
export function autoLabels(
  outline: readonly OutlineEntry[],
  page: number,
  source: string | null,
  offset = 0,
): AutoLabels {
  return { section: sectionFor(outline, page), snippet: snippetLabel(page, source ? snippetWords(source, offset) : '') };
}

/**
 * `autoLabels` for a location in any paged format: the section by `sectionAt` (exact outline targets
 * count), the snippet named by `placeName`. Null for a location without a page.
 */
export function autoLabelsAt(
  outline: readonly OutlineEntry[],
  loc: Location,
  source: string | null,
  offset = 0,
): AutoLabels | null {
  if (!spotOf(loc)) return null;
  return { section: sectionAt(outline, loc), snippet: snippetLabelAt(loc, source ? snippetWords(source, offset) : '') };
}

/** Where a thought sits and the text that names it. */
export interface ThoughtPlace {
  location: Location;
  /** The highlight's quote for an anchored thought; null for a pin or page thought. */
  quote: string | null;
}

/** An anchored thought sits at its highlight; otherwise at its own location; a general thought nowhere. */
export function thoughtPlace(t: Thought, anchors: ReadonlyMap<string, Annotation>): ThoughtPlace | null {
  const anchor = t.anchorId ? anchors.get(t.anchorId) : undefined;
  if (anchor) {
    const location = parseLocation(anchor.location);
    if (location) return { location, quote: anchor.quote };
  }
  const location = parseLocation(t.location);
  return location ? { location, quote: null } : null;
}

export type ThoughtLabel =
  | { kind: 'custom'; text: string }
  | { kind: 'auto'; section: string | null; snippet: string }
  | { kind: 'none' };

/**
 * What a thought is called (spec §3.3): the rename, else the stored automatic label, else the place's
 * own label (`p. N`) while the automatic one is missing (backfill pending or failed).
 */
export function thoughtLabel(t: Thought, place: ThoughtPlace | null): ThoughtLabel {
  const custom = t.labelCustom?.trim();
  if (custom) return { kind: 'custom', text: custom };
  if (t.labelSnippet) return { kind: 'auto', section: t.labelSection, snippet: t.labelSnippet };
  if (place) return { kind: 'auto', section: null, snippet: place.location.label };
  return { kind: 'none' };
}

/** One-line form of a label, for tooltips and accessible names. */
export function labelText(l: ThoughtLabel): string {
  if (l.kind === 'custom') return l.text;
  if (l.kind === 'auto') return l.section ? `${l.section} — ${l.snippet}` : l.snippet;
  return '';
}
