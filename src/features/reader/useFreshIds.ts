import { useCallback, useEffect, useRef, useState } from 'react';

/** How long something just created counts as new: its arrival motion (≤ 500 ms) has played by then. */
export const FRESH_MS = 1500;

/** Ids created moments ago (thoughts, highlights), for their arrival motion; each expires on its own. */
export function useFreshIds(): [ReadonlySet<string>, (id: string) => void] {
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((t) => clearTimeout(t));
      pending.clear();
    };
  }, []);
  const mark = useCallback((id: string) => {
    setFresh((s) => (s.has(id) ? s : new Set(s).add(id)));
    clearTimeout(timers.current.get(id)); // re-marked: the first timer must not expire it early
    const t = setTimeout(() => {
      timers.current.delete(id);
      setFresh((s) => {
        if (!s.has(id)) return s;
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }, FRESH_MS);
    timers.current.set(id, t);
  }, []);
  return [fresh, mark];
}
