import { useLayoutEffect, useState, type RefObject } from 'react';
import { marginModeFor, type MarginMode } from './marginLayout';

/**
 * What the margin shows, from the reading column's width (spec §5.2: notes, or tabs when narrow).
 * Measured before paint and on every resize; 'off' while disabled (not a PDF) or unmeasured.
 */
export function useMarginMode(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  pageWidth: number | null = null,
  /** Focus mode: a column too narrow for tabs may still show dots (marginModeFor's `dots`). */
  opts: { dots?: boolean } = {},
): MarginMode {
  const dots = !!opts.dots;
  const [mode, setMode] = useState<MarginMode>('off');
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) {
      setMode('off');
      return;
    }
    const measure = () => setMode(marginModeFor(el.getBoundingClientRect().width, pageWidth, { dots }));
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref, enabled, pageWidth, dots]);
  return mode;
}

/** `value`, except while `hold` is true: then the value it had when holding began (applied again once released). */
export function useHeld<T>(value: T, hold: boolean): T {
  const [held, setHeld] = useState(value);
  // Derived state: while not holding, follow the value (React re-renders at once, before committing).
  if (!hold && !Object.is(held, value)) setHeld(value);
  return hold ? held : value;
}
