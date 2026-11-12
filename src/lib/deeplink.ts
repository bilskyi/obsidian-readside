import { parseLocation, serializeLocation } from './location';
import type { Location } from './types';

export type DeepLinkTarget = { annotationId: string } | { location: Location };

export interface DeepLink {
  bookId: string;
  target: DeepLinkTarget;
}

export type ParsedDeepLink = { ok: true; link: DeepLink } | { ok: false; error: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** margin://open?book=<id>&loc=<annotation id | url-encoded Location JSON> (spec §3.2). */
export function buildMarginUrl(bookId: string, target: DeepLinkTarget): string {
  const loc = 'annotationId' in target ? target.annotationId : serializeLocation(target.location);
  return `margin://open?book=${encodeURIComponent(bookId)}&loc=${encodeURIComponent(loc)}`;
}

export function parseMarginUrl(raw: string): ParsedDeepLink {
  const fail = (error: string): ParsedDeepLink => ({ ok: false, error });
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return fail('This isn’t a Margin link.');
  }
  // WHATWG URL lower-cases the scheme; a non-special scheme keeps the host's case.
  if (url.protocol !== 'margin:') return fail('This isn’t a Margin link.');
  if (url.hostname.toLowerCase() !== 'open' || (url.pathname !== '' && url.pathname !== '/')) {
    return fail('Margin can’t open this kind of link.');
  }
  const bookId = url.searchParams.get('book');
  if (!bookId || !ID.test(bookId)) return fail('The link has no valid book id.');
  const loc = url.searchParams.get('loc');
  if (!loc) return fail('The link has no location.');
  if (loc.startsWith('{')) {
    const location = parseLocation(loc);
    return location ? { ok: true, link: { bookId, target: { location } } } : fail('The link’s location is invalid.');
  }
  return ID.test(loc)
    ? { ok: true, link: { bookId, target: { annotationId: loc } } }
    : fail('The link’s location is invalid.');
}
