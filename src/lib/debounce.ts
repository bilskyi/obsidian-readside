export type Debounced<A extends unknown[]> = ((...a: A) => void) & {
  /** Run a pending call now (if any) and clear the timer. */
  flush: () => void;
  /** Drop a pending call without running it. */
  cancel: () => void;
};

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): Debounced<A> {
  let t: ReturnType<typeof setTimeout> | undefined;
  let pending: A | undefined;
  const d = ((...a: A) => {
    if (t !== undefined) clearTimeout(t);
    pending = a;
    t = setTimeout(() => {
      t = undefined;
      pending = undefined;
      fn(...a);
    }, ms);
  }) as Debounced<A>;
  d.cancel = () => {
    if (t !== undefined) clearTimeout(t);
    t = undefined;
    pending = undefined;
  };
  d.flush = () => {
    if (t === undefined || pending === undefined) return;
    const a = pending;
    d.cancel();
    fn(...a);
  };
  return d;
}
