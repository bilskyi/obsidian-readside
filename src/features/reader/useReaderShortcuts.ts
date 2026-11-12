import { useEffect, useLayoutEffect, useRef } from 'react';
import { readerCommand, type ReaderCommand } from '../../lib/keys';
import { PINCH_APPLY_MS } from '../../renderers/pdf/zoom';

/** Held keys repeat these; everything else fires once per press. */
export const REPEATABLE: ReadonlySet<ReaderCommand> = new Set<ReaderCommand>(['nextPage', 'prevPage', 'zoomIn', 'zoomOut']);
/** Held zoom keys step at the pinch rate: every step re-renders the visible pages. */
export const THROTTLED: ReadonlySet<ReaderCommand> = new Set<ReaderCommand>(['zoomIn', 'zoomOut']);
/** The least time between two repeats of a THROTTLED key (about 8 a second). */
export const REPEAT_THROTTLE_MS = PINCH_APPLY_MS;

/** Reader-wide shortcuts, bound once; the ref always holds this render's handlers. */
export function useReaderShortcuts(
  /** Each command's handler, given the key event that asked for it (a host's own command passes none). */
  handlers: Partial<Record<ReaderCommand, (e?: KeyboardEvent) => void>>,
  /** The window (desktop) or the host's element (Obsidian: keys act only while its view has focus). */
  target: 'window' | HTMLElement = 'window',
  /** True for a key the browser should handle itself (not prevented, no handler run): EPUB's PageUp/PageDown in the scroller. */
  leave?: (e: KeyboardEvent, cmd: ReaderCommand) => boolean,
): void {
  const ref = useRef(handlers);
  const leaveRef = useRef(leave);
  useLayoutEffect(() => {
    ref.current = handlers;
    leaveRef.current = leave;
  });
  useEffect(() => {
    const lastRun = new Map<ReaderCommand, number>();
    const onKey = (e: KeyboardEvent) => {
      // Something nearer the target already handled this key (a field, menu or popover).
      if (e.defaultPrevented) return;
      const cmd = readerCommand(e);
      const run = cmd ? ref.current[cmd] : undefined;
      if (!cmd || !run) return;
      if (leaveRef.current?.(e, cmd)) return;
      e.preventDefault();
      // Keeps the key from bubbling on to ancestors' listeners. It does not isolate the reader from a host
      // that listens in the capture phase (Obsidian's Keymap, on window): that host is told through its
      // own API instead (the Obsidian view claims these keys in its Scope).
      e.stopPropagation();
      if (e.repeat && !REPEATABLE.has(cmd)) return;
      if (THROTTLED.has(cmd)) {
        const now = Date.now();
        if (e.repeat && now - (lastRun.get(cmd) ?? -Infinity) < REPEAT_THROTTLE_MS) return;
        lastRun.set(cmd, now);
      }
      run(e);
    };
    const el: Window | HTMLElement = target === 'window' ? window : target;
    el.addEventListener('keydown', onKey as EventListener);
    return () => el.removeEventListener('keydown', onKey as EventListener);
  }, [target]);
}
