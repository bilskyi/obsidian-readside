import { snippetLabelAt, snippetWords } from '../../src/lib/labels';
import { parseLocation, serializeLocation, spotOf } from '../../src/lib/location';
import type { Location } from '../../src/lib/types';
import { PROTOCOL_ACTION } from './identity';

/** encodeURIComponent plus `(` and `)`, so the URL can sit inside a Markdown link. */
const enc = (s: string) => encodeURIComponent(s).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** `obsidian://readside?file=<vault path>&loc=<Location JSON>` (spec §7; older links say `obsidian://margin`). */
export function buildObsidianUrl(path: string, location: Location | null): string {
  const loc = location ? `&loc=${enc(serializeLocation(location))}` : '';
  return `obsidian://${PROTOCOL_ACTION}?file=${enc(path)}${loc}`;
}

export interface MarginLinkTarget {
  file: string;
  location: Location | null;
}

/** The protocol handler's parameters (Obsidian has already decoded them). A bad `loc` opens the file without a jump. */
export function parseMarginParams(params: Record<string, string | undefined>): MarginLinkTarget | null {
  const file = params.file?.trim();
  if (!file) return null;
  return { file, location: parseLocation(params.loc ?? null) };
}

/** `p. 42 · “Opening words…”` for a highlight, `p. 42` for a place (`§ 7` in an epub). */
export function linkLabel(location: Location, quote: string | null): string {
  if (!spotOf(location)) return location.label;
  return snippetLabelAt(location, quote ? snippetWords(quote) : '');
}

const escapeLinkText = (s: string) => s.replace(/[[\]\\]/g, (c) => `\\${c}`);

/** `[p. 42 · “snippet…”](obsidian://readside?…)` */
export function markdownLink(path: string, location: Location, quote: string | null): string {
  return `[${escapeLinkText(linkLabel(location, quote))}](${buildObsidianUrl(path, location)})`;
}
