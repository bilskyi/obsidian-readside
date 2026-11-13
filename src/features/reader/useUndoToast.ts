import { useCallback, useEffect, useState } from 'react';
import { UNDO_MS } from './useNewThoughts';

/**
 * One "… · Undo" toast's state: what can be undone, for UNDO_MS (a newer one starts it over), never while
 * the pointer or the keyboard is on the toast, and the full time again once they leave.
 */
export function useUndoToast<T>(ms = UNDO_MS) {
  const [entry, setEntry] = useState<{ key: number; value: T } | null>(null);
  const [held, setHeld] = useState({ hover: false, focus: false });
  const key = entry?.key;
  const isHeld = held.hover || held.focus;
  useEffect(() => {
    if (key === undefined) {
      setHeld((h) => (h.hover || h.focus ? { hover: false, focus: false } : h));
      return;
    }
    if (isHeld) return;
    const t = setTimeout(() => setEntry((e) => (e?.key === key ? null : e)), ms);
    return () => clearTimeout(t);
  }, [key, isHeld, ms]);
  const show = useCallback((value: T) => setEntry((e) => ({ key: (e?.key ?? 0) + 1, value })), []);
  const dismiss = useCallback(() => setEntry(null), []);
  const hold = useCallback((by: 'hover' | 'focus', on: boolean) => {
    setHeld((h) => (h[by] === on ? h : { ...h, [by]: on }));
  }, []);
  return { value: entry?.value ?? null, show, dismiss, hold };
}
