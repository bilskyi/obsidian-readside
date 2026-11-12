import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { backend } from '../../lib/backend';
import { parseLocation } from '../../lib/location';
import type { Annotation, AnnotationPatchInput, NewAnnotationInput } from '../../lib/types';
import type { PaintableAnnotation } from '../../renderers/types';
import { collapseDuplicates } from './highlightRules';

interface Loaded {
  items: Annotation[];
  /** Something was written (or may have been): the reader reloads its thoughts. */
  changed: boolean;
  /** The collapse failed: shown, while the highlights still are. */
  error?: string;
}

/** Collapses in flight, per book: a second mount of the same book (StrictMode, a split pane) waits for the first. */
const collapsing = new Map<string, Promise<Loaded>>();
/** Books whose collapse failed this session: not tried again until the app (or plugin) restarts. */
const collapseFailed = new Set<string>();

/** Test hook: forget which books' collapse failed. */
export function resetCollapseFailuresForTests(): void {
  collapseFailed.clear();
}

/**
 * The book's highlights, with exact duplicates collapsed once (highlightRules.collapseDuplicates). A
 * collapse that fails part-way never hides the highlights: they are listed again as they now are, and the
 * error is reported alongside.
 */
function loadCollapsed(bookId: string): Promise<Loaded> {
  const running = collapsing.get(bookId);
  if (running) return running;
  const b = backend();
  const p = b
    .listAnnotations(bookId)
    .then(async (list): Promise<Loaded> => {
      if (collapseFailed.has(bookId)) return { items: list, changed: false };
      try {
        return await collapseDuplicates(list, {
          listThoughts: () => b.listThoughts(bookId),
          update: (id, patch) => b.updateAnnotation(id, patch),
          updateThought: (id, patch) => b.updateThought(id, patch),
          remove: (id) => b.deleteAnnotation(id),
        });
      } catch (e) {
        collapseFailed.add(bookId);
        const now = await b.listAnnotations(bookId).catch(() => list);
        return { items: now, changed: true, error: `Couldn't merge stacked highlights: ${String(e)}` };
      }
    })
    .finally(() => collapsing.delete(bookId));
  collapsing.set(bookId, p);
  return p;
}

export const isPresent = <T,>(v: T | null | undefined): v is T => v != null;

export function toPaintable(a: Annotation): PaintableAnnotation | null {
  const location = parseLocation(a.location);
  return location
    ? { id: a.id, location, color: a.color, quote: a.quote, unanchored: a.unanchored }
    : null;
}

export function useAnnotations(bookId: string) {
  const [items, setItems] = useState<Annotation[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Bumped when opening the book collapsed duplicates (their thoughts moved): the reader reloads its thoughts. */
  const [collapsed, setCollapsed] = useState(0);
  /** The first load (and its collapse) has landed and rendered, for this book. */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const itemsRef = useRef(items);
  useLayoutEffect(() => {
    itemsRef.current = items;
  });
  const firstLoad = useRef<{ bookId: string; promise: Promise<void>; resolve: () => void } | null>(null);
  const firstLoadFor = (id: string) => {
    if (firstLoad.current?.bookId !== id) {
      let resolve = () => {};
      const promise = new Promise<void>((r) => (resolve = r));
      firstLoad.current = { bookId: id, promise, resolve };
    }
    return firstLoad.current;
  };

  useEffect(() => {
    let alive = true;
    loadCollapsed(bookId)
      .then(({ items: list, changed, error: failed }) => {
        if (!alive) return;
        setItems(list);
        if (changed) setCollapsed((n) => n + 1);
        if (failed) setError(failed);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      })
      .finally(() => {
        if (alive) setLoadedFor(bookId);
      });
    return () => {
      alive = false;
    };
  }, [bookId]);
  // After the render that shows the loaded list, so `ready` hands out that list.
  useEffect(() => {
    if (loadedFor === bookId) firstLoadFor(bookId).resolve();
  }, [loadedFor, bookId]);

  /**
   * The highlights once the first load (with its collapse) has landed: a highlight made before then would
   * be planned against an empty list and stack on one still loading.
   */
  const ready = useCallback(async () => {
    await firstLoadFor(bookId).promise;
    return itemsRef.current;
  }, [bookId]);

  const create = useCallback(
    async (input: Omit<NewAnnotationInput, 'bookId'>) => {
      const a = await backend().createAnnotation({ ...input, bookId });
      setItems((xs) => [...xs, a]);
      return a;
    },
    [bookId],
  );

  const update = useCallback(async (id: string, patch: AnnotationPatchInput) => {
    const a = await backend().updateAnnotation(id, patch);
    setItems((xs) => xs.map((x) => (x.id === id ? a : x)));
    return a;
  }, []);

  const remove = useCallback(async (id: string) => {
    await backend().deleteAnnotation(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  return { items, error, create, update, remove, collapsed, ready };
}
