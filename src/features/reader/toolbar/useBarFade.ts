import { useEffect, useState } from 'react';

/** Scrolling this far down (px, in one go) fades the toolbar; this far up brings it back. */
export const FADE_SCROLL_PX = 8;

/**
 * Whether the reader's toolbar is faded: it fades once the reader scrolls down into the book and comes
 * back on a scroll up or a tap on the page (touch). Hovering it or moving focus into it shows it as well,
 * which CSS handles (`.reader-bar.is-faded:hover`, `:focus-within`). Never faded while `active` is false
 * (the book isn't open yet).
 */
export function useBarFade(area: HTMLElement | null, active: boolean): boolean {
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    if (!active) setFaded(false);
  }, [active]);
  useEffect(() => {
    if (!area || !active) return;
    const last = new WeakMap<EventTarget, number>();
    let touch = false;
    const onScroll = (e: Event) => {
      const t = e.target;
      // Only the book's own scroller: a panel's list or the notebook scrolling leaves the bar alone.
      if (!(t instanceof HTMLElement) || !t.classList.contains('pdf-scroller')) return;
      const top = t.scrollTop;
      const before = last.get(t);
      if (before === undefined) {
        last.set(t, top);
        return;
      }
      const d = top - before;
      if (Math.abs(d) < FADE_SCROLL_PX) return;
      last.set(t, top);
      setFaded(d > 0);
    };
    const onPointerDown = (e: PointerEvent) => {
      touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    };
    // A tap on the page (not a selection, a link or a control) shows or hides the bar, as in a phone's reader.
    const onClick = (e: MouseEvent) => {
      if (!touch) return;
      const t = e.target instanceof Element ? e.target : null;
      if (!t?.closest('.pdf-scroller') || t.closest('a, button, input, textarea, [contenteditable], .hl')) return;
      const sel = area.ownerDocument.getSelection();
      if (sel && !sel.isCollapsed) return;
      setFaded((f) => !f);
    };
    area.addEventListener('scroll', onScroll, true);
    area.addEventListener('pointerdown', onPointerDown, true);
    area.addEventListener('click', onClick);
    return () => {
      area.removeEventListener('scroll', onScroll, true);
      area.removeEventListener('pointerdown', onPointerDown, true);
      area.removeEventListener('click', onClick);
    };
  }, [area, active]);
  return faded;
}
