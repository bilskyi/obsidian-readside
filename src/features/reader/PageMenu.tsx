import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { fixedOrigin, floatBounds, placeAt } from '../../lib/floating';
import { shortcutKey } from '../../lib/keys';
import { COLORS } from '../../lib/types';
import type { PageMenuItem, PageMenuItemId } from './pageMenuItems';

/** The choices that make a thought: its editor takes focus, so the page doesn't. */
const MAKES_A_THOUGHT = new Set<PageMenuItemId>(['add-thought-here', 'thought-on-selection']);

interface Props {
  /** Where the right-click was, in viewport coordinates. */
  x: number;
  y: number;
  items: PageMenuItem[];
  /** The menu closes (a choice, Escape, a press outside, a scroll, the window losing focus). */
  onClose: (opts: { restoreFocus: boolean }) => void;
}

/**
 * The page's right-click menu where the host has no menu of its own (the desktop app): a small menu in the
 * selection popover's style, at the pointer, kept inside the reader (and the window). Arrow keys move between its items,
 * 1–5 highlight in that colour (as in the selection popover), Escape closes it; it never takes the text
 * selection (presses inside it are cancelled). After a choice that makes no thought (a highlight, a copy),
 * the page has the keyboard again; a new thought takes it itself.
 */
export function PageMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Layout size: getBoundingClientRect is scaled by the entry animation's transform.
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    // Inside the reader's own box (within the window), not just the window: see floatBounds. Placed in
    // viewport coordinates, written relative to the fixed containing block (the leaf in Obsidian).
    const placed = placeAt(x, y, { width, height }, floatBounds(el));
    const origin = fixedOrigin(el);
    setPos({ top: placed.top - origin.y, left: placed.left - origin.x });
  }, [x, y]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const close = () => closeRef.current({ restoreFocus: false });
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      close();
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = all.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => all[(i + all.length) % all.length]?.focus();
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose({ restoreFocus: true });
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onClose({ restoreFocus: true });
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      move(at + 1);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      move(at - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      move(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      move(all.length - 1);
    } else if (!e.metaKey && !e.ctrlKey && !e.altKey) {
      // The swatches' keys (a non-Latin layout reads the key's QWERTY place).
      const i = ['1', '2', '3', '4', '5'].indexOf(shortcutKey(e));
      const highlight = items.find((item) => item.onColor);
      if (i < 0 || !highlight) return;
      e.preventDefault();
      choose(highlight.id, () => highlight.onColor!(COLORS[i]));
    }
  };

  /** Runs a choice; the page gets the keyboard back unless the choice makes a thought (it focuses that). */
  const choose = (id: PageMenuItemId, fn: () => void) => {
    onClose({ restoreFocus: !MAKES_A_THOUGHT.has(id) });
    fn();
  };
  const style: CSSProperties = pos
    ? { position: 'fixed', top: pos.top, left: pos.left }
    : { position: 'fixed', top: y, left: x, visibility: 'hidden' };

  return (
    <div
      ref={ref}
      className="page-menu"
      role="menu"
      aria-label="Page actions"
      style={style}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) =>
        item.onColor ? (
          <div key={item.id} className="page-menu-row">
            <button type="button" role="menuitem" className="page-menu-item" onClick={() => choose(item.id, item.onSelect)}>
              {item.label}
            </button>
            <span className="dot-wrap">
              {COLORS.map((c, i) => (
                <button
                  key={c}
                  type="button"
                  role="menuitem"
                  className={`dot dot-${c}`}
                  aria-label={`Highlight ${c} (${i + 1})`}
                  aria-keyshortcuts={String(i + 1)}
                  onClick={() => choose(item.id, () => item.onColor!(c))}
                />
              ))}
            </span>
          </div>
        ) : (
          <button key={item.id} type="button" role="menuitem" className="page-menu-item" onClick={() => choose(item.id, item.onSelect)}>
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
