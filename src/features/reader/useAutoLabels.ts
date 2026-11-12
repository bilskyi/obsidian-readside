import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { autoLabelsAt, thoughtPlace, type AutoLabels, type ThoughtPlace } from '../../lib/labels';
import { spotOf } from '../../lib/location';
import type { Annotation, OutlineEntry, Thought } from '../../lib/types';

/** Backfill reads page text: a book full of old thoughts must not queue every page at once. */
export const AUTO_LABEL_CONCURRENCY = 4;

export interface AutoLabelDeps {
  /** The book is open and its outline has loaded ([] counts as loaded; a failed read does not). */
  ready: boolean;
  outline: readonly OutlineEntry[];
  /** '' for a page without text; rejects when the text couldn't be read. */
  getPageText: (page: number) => Promise<string>;
  setAutoLabels: (id: string, section: string | null, snippet: string) => Promise<unknown>;
}

/**
 * The automatic label for a place (spec §3.3): an anchored thought is named by its highlight's quote,
 * a pin by the page text from its line start; a page without text ('') gives `p. N`. A page whose text
 * couldn't be read rejects, so nothing permanent is stored for it.
 */
export async function computeAutoLabels(
  place: ThoughtPlace,
  outline: readonly OutlineEntry[],
  getPageText: (page: number) => Promise<string>,
): Promise<AutoLabels | null> {
  const spot = spotOf(place.location);
  if (!spot) return null;
  if (place.quote !== null) return autoLabelsAt(outline, place.location, place.quote);
  return autoLabelsAt(outline, place.location, await getPageText(spot.page), spot.start);
}

/**
 * Labels every thought that has a place but no stored automatic label: new thoughts right after they
 * are created, older ones on the first open after migration 3 (spec §3.2 backfill), at most
 * AUTO_LABEL_CONCURRENCY at a time. Each thought is tried once per reader session; a failure (or the
 * reader closing first) leaves it unlabelled (it shows `p. N`) until the next open. An anchored thought
 * whose highlight hasn't loaded yet waits for it.
 */
export function useAutoLabels(thoughts: Thought[], annotations: Annotation[], deps: AutoLabelDeps): void {
  const tried = useRef(new Set<string>());
  const queue = useRef<{ id: string; place: ThoughtPlace }[]>([]);
  const active = useRef(0);
  /** False once unmounted (book closed or changed): late results are dropped, never written. */
  const alive = useRef(true);
  const depsRef = useRef(deps);
  useLayoutEffect(() => {
    depsRef.current = deps;
  });
  // Declared before the labelling effect, so a StrictMode remount is alive again before it pumps.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Starts queued thoughts while fewer than AUTO_LABEL_CONCURRENCY are running. */
  const pump = useCallback(function run() {
    while (alive.current && active.current < AUTO_LABEL_CONCURRENCY && queue.current.length) {
      const { id, place } = queue.current.shift()!;
      active.current++;
      const d = depsRef.current;
      void computeAutoLabels(place, d.outline, d.getPageText)
        .then((labels) => {
          if (labels && alive.current) return depsRef.current.setAutoLabels(id, labels.section, labels.snippet);
        })
        .catch((e) => {
          if (alive.current) console.warn(`Margin: couldn't label thought ${id}`, e);
        })
        .finally(() => {
          active.current--;
          run();
        });
    }
  }, []);

  const { ready } = deps;
  useEffect(() => {
    if (!ready) return;
    const anchors = new Map(annotations.map((a) => [a.id, a]));
    for (const t of thoughts) {
      if (t.labelSnippet || tried.current.has(t.id)) continue;
      const place = thoughtPlace(t, anchors);
      if (!place) continue; // a general thought, or its highlight isn't loaded yet
      tried.current.add(t.id);
      queue.current.push({ id: t.id, place });
    }
    pump();
  }, [thoughts, annotations, ready, pump]);
}
