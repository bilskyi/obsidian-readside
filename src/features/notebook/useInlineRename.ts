import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Thought } from '../../lib/types';

/**
 * A thought's inline name field (LabelField), shared by the notebook and the margin. Enter saves the
 * trimmed name, Escape cancels, an empty name restores the automatic label; nothing is sent when the
 * name didn't change. After Enter or Escape focus goes back to `refocusTarget()` (the surface's header),
 * not lost to the page; after a blur the reader has already put focus somewhere else, so it stays there.
 */
export function useInlineRename(
  thought: Thought,
  onRename: (id: string, label: string | null) => void,
  refocusTarget: () => HTMLElement | null | undefined,
) {
  const [renaming, setRenaming] = useState(false);
  const refocus = useRef(false);
  const target = useRef(refocusTarget);
  useLayoutEffect(() => {
    target.current = refocusTarget;
  });
  useEffect(() => {
    if (!renaming && refocus.current) {
      refocus.current = false;
      target.current()?.focus();
    }
  }, [renaming]);
  const finishRename = (value: string | null, by: 'key' | 'blur') => {
    refocus.current = by === 'key';
    setRenaming(false);
    if (value === null) return; // cancelled
    const next = value.trim() || null;
    if (next !== (thought.labelCustom?.trim() || null)) onRename(thought.id, next);
  };
  return { renaming, startRename: () => setRenaming(true), finishRename };
}
