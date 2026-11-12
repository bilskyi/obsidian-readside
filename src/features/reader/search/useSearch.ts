import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { pdfLocation, startLocation, withSpot } from '../../../lib/location';
import type { Location } from '../../../lib/types';
import type { SearchBatch, SearchHit } from '../../../renderers/types';

export interface SearchDeps {
  search: (query: string, opts: { signal: AbortSignal; fromPage?: number }) => AsyncIterable<SearchBatch>;
  showSearchHits: (hits: readonly SearchHit[], current: SearchHit | null) => void;
  clearSearch: () => void;
  goTo: (location: Location) => Promise<void>;
  /** Where a run starts (then wraps around): the reader's current page. */
  fromPage: () => number;
  /** The book's paged format, for the hits' locations (default 'pdf'). */
  format?: 'pdf' | 'epub';
}

export interface SearchRun {
  /** By page, then offset. */
  hits: SearchHit[];
  current: SearchHit | null;
  /** Pages scanned so far. */
  scanned: number;
  /** Scanned pages that had no text at all. */
  noText: number;
  done: boolean;
  /** Bumped by every step or pick, so picking the current hit again still scrolls to it. */
  nav: number;
}

export const SEARCH_DEBOUNCE_MS = 200;
const IDLE: SearchRun = { hits: [], current: null, scanned: 0, noText: 0, done: true, nav: 0 };
const STARTING: SearchRun = { ...IDLE, done: false };

const byPlace = (a: SearchHit, b: SearchHit) => a.page - b.page || a.start - b.start;
export const sameHit = (a: SearchHit | null, b: SearchHit | null) =>
  !!a && !!b && a.page === b.page && a.start === b.start && a.end === b.end;
/** A hit's place: a PDF page's offsets, or an EPUB section's. */
export const hitLocation = (h: SearchHit, format: 'pdf' | 'epub' = 'pdf'): Location =>
  format === 'epub'
    ? withSpot(startLocation('epub'), { page: h.page, start: h.start, end: h.end })
    : pdfLocation({ page: h.page, start: h.start, end: h.end });

/** In-book search: one cancellable, streaming run per query, kept in sync with the renderer's hit layer. */
export function useSearch(deps: SearchDeps) {
  const depsRef = useRef(deps);
  useLayoutEffect(() => {
    depsRef.current = deps;
  });
  const [query, setQuery] = useState('');
  const [run, setRun] = useState<SearchRun>(IDLE);
  /** Starts the run still waiting for its debounce; null when none is waiting. */
  const pending = useRef<(() => void) | null>(null);

  useEffect(() => {
    const q = query.trim();
    // The previous run's hits go at once, not when the next run starts.
    setRun(q ? STARTING : IDLE);
    if (!q) return;
    const ac = new AbortController();
    const start = () => {
      clearTimeout(timer);
      if (pending.current === start) pending.current = null;
      void (async () => {
        const d = depsRef.current;
        const fromPage = d.fromPage();
        // Pages stream in wrap order (fromPage…end, then 1…fromPage−1), so the hits stay by place as two
        // ascending lists: `head` (pages before fromPage) then `tail`. A batch out of that order falls back
        // to sorting its list.
        const head: SearchHit[] = [];
        const tail: SearchHit[] = [];
        let hits: SearchHit[] = [];
        try {
          for await (const batch of d.search(q, { signal: ac.signal, fromPage })) {
            // A batch of an aborted run (new query, close, unmount) is dropped before it can be painted,
            // even if the iterator yields it after the abort.
            if (ac.signal.aborted) return;
            if (batch.hits.length) {
              const list = batch.page < fromPage ? head : tail;
              const inOrder =
                (!list.length || byPlace(list[list.length - 1], batch.hits[0]) <= 0) &&
                batch.hits.every((h, i) => i === 0 || byPlace(batch.hits[i - 1], h) <= 0);
              list.push(...batch.hits);
              if (!inOrder) list.sort(byPlace);
              hits = head.concat(tail);
            }
            const now = hits;
            setRun((r) => ({
              ...r,
              hits: batch.hits.length ? now : r.hits,
              current: r.current ?? batch.hits[0] ?? null,
              scanned: r.scanned + 1,
              noText: r.noText + (batch.noText ? 1 : 0),
            }));
          }
        } catch (e) {
          if (!ac.signal.aborted) console.warn('Margin: search failed', e);
        }
        if (!ac.signal.aborted) setRun((r) => ({ ...r, done: true }));
      })();
    };
    const timer = setTimeout(start, SEARCH_DEBOUNCE_MS);
    pending.current = start;
    return () => {
      clearTimeout(timer);
      if (pending.current === start) pending.current = null;
      ac.abort();
    };
  }, [query]);

  /** Starts a run still waiting for its debounce right away (Enter). True if there was one. */
  const flush = useCallback(() => {
    const start = pending.current;
    if (!start) return false;
    start();
    return true;
  }, []);

  // Keep the renderer's search layer in step with the hits and the current one.
  useEffect(() => {
    depsRef.current.showSearchHits(run.hits, run.current);
  }, [run.hits, run.current]);

  // Scroll to the current hit: the first one found, then every step or pick.
  const { current, nav } = run;
  useEffect(() => {
    if (current) depsRef.current.goTo(hitLocation(current, depsRef.current.format)).catch(() => {});
  }, [current, nav]);

  // Closing the bar (unmount) clears the layer.
  useEffect(() => () => depsRef.current.clearSearch(), []);

  const step = useCallback(
    (dir: 1 | -1) =>
      setRun((r) => {
        if (!r.hits.length) return r;
        const i = r.current ? r.hits.findIndex((h) => sameHit(h, r.current)) : -1;
        const j = i < 0 ? (dir > 0 ? 0 : r.hits.length - 1) : (i + dir + r.hits.length) % r.hits.length;
        return { ...r, current: r.hits[j], nav: r.nav + 1 };
      }),
    [],
  );
  const next = useCallback(() => step(1), [step]);
  const prev = useCallback(() => step(-1), [step]);
  const select = useCallback((hit: SearchHit) => setRun((r) => ({ ...r, current: hit, nav: r.nav + 1 })), []);

  const index = run.current ? run.hits.findIndex((h) => sameHit(h, run.current)) : -1;
  return { query, setQuery, run, index, next, prev, select, flush };
}
