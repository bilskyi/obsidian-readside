import { useMemo } from 'react';
import { thoughtPlace } from '../../../lib/labels';
import { spotOf } from '../../../lib/location';
import type { Annotation, Thought } from '../../../lib/types';

/**
 * The page of every thought that has one (its highlight's page for an anchored thought), for the
 * contents counts. The array keeps its identity until the list of pages changes, so a keystroke in a
 * thought (which replaces the thoughts array) doesn't recount the contents.
 */
export function useThoughtPages(thoughts: readonly Thought[], annotations: readonly Annotation[]): readonly number[] {
  const pages = useMemo(() => {
    const anchors = new Map(annotations.map((a) => [a.id, a]));
    return thoughts.flatMap((t) => {
      const place = thoughtPlace(t, anchors);
      const spot = place ? spotOf(place.location) : null;
      return spot ? [spot.page] : [];
    });
  }, [annotations, thoughts]);
  const key = pages.join(',');
  // Keyed on the pages themselves: same pages, same array.
  return useMemo(() => pages, [key]);
}
