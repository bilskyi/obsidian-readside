// ⌥-hover word lookup (spec §A5): with ⌥ held alone, the word under the pointer in the page text is
// looked up after the pointer rests on it (200 ms), and the result shown as a tooltip.
//
// Never in the way:
//  - Holding ⌥ alone does nothing: the lookup needs a pointer move with ⌥ (and only ⌥) held. No key or
//    pointer event is ever prevented or stopped, so ⌥←/→, Obsidian's own ⌥ shortcuts, selection,
//    highlight hover and the margin + see every event as before.
//  - A move with a button down (a selection drag) or another modifier hides the tip.
//  - Another key pressed with ⌥ (a chord such as ⌥→) hides the tip.
//
// Kept rare: pointer moves are read once per animation frame; a word is looked up once while the pointer
// stays on it; moving to another word aborts the request in flight (a queued engine request is dropped
// before it runs) and a late answer for a word the pointer left is ignored.
//
// Hidden on: ⌥ released, the pointer leaving the root or the text, a scroll inside the root, the window
// losing focus.
//
// The root is passed as the element itself (callback-ref state), not a RefObject: a root that mounts
// after the first render (EPUB's renderer, a reader shown later) still gets its listeners.
import { useCallback, useEffect, useRef, useState } from 'react';
import { wordAt, type WordHit } from './wordAt';

export type HoverResult = { text: string; from: string; to: string } | { hint: string };

export interface HoverTip {
  rect: DOMRect;
  word: string;
  result: HoverResult;
}

export interface AltHoverOptions {
  /** A function is read at every move (a setting that may change while the reader is open). */
  enabled: boolean | (() => boolean);
  delayMs?: number;
  lookup: (word: string, hit: WordHit, signal: AbortSignal) => Promise<HoverResult | null>;
}

export const HOVER_DELAY_MS = 200;
/** Shown once when a lookup fails (the engine couldn't start, or stopped): the card explains why. */
export const HOVER_ENGINE_TIP = 'Translation engine unavailable — press L for details';
/** After a failed lookup, ⌥-hover asks the engine again only after this long, doubling up to the max. */
export const HOVER_BACKOFF_MS = 30_000;
export const HOVER_BACKOFF_MAX_MS = 10 * 60_000;

const altAlone = (e: { altKey: boolean; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) =>
  e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey;

export function useAltHoverWord(root: HTMLElement | null, opts: AltHoverOptions): { tip: HoverTip | null } {
  const [tip, setTip] = useState<HoverTip | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  /** The word the pointer is on (looked up or waiting to be), and its pending timer / request. */
  const current = useRef<{ node: Text; start: number; timer: ReturnType<typeof setTimeout> | null; ctl: AbortController | null } | null>(null);

  const reset = useCallback(() => {
    const c = current.current;
    if (c) {
      if (c.timer !== null) clearTimeout(c.timer);
      c.ctl?.abort();
    }
    current.current = null;
    setTip((t) => (t ? null : t));
  }, []);

  useEffect(() => {
    const el = root;
    if (!el) return;
    const doc = el.ownerDocument;
    const view = doc.defaultView ?? window;
    let frame: number | null = null;
    let last: PointerEvent | null = null;

    const isOn = () => {
      const en = optsRef.current.enabled;
      return typeof en === 'function' ? en() : en;
    };

    const examine = () => {
      frame = null;
      const e = last;
      if (!e) return;
      const hit = wordAt(doc, e.clientX, e.clientY, el);
      if (!hit) return reset();
      const c = current.current;
      if (c && c.node === hit.node && c.start === hit.start) return; // same word: no new lookup
      reset();
      const mine: NonNullable<typeof current.current> = { node: hit.node, start: hit.start, timer: null, ctl: null };
      current.current = mine;
      mine.timer = setTimeout(() => {
        mine.timer = null;
        const ctl = new AbortController();
        mine.ctl = ctl;
        optsRef.current.lookup(hit.word, hit, ctl.signal).then(
          (result) => {
            if (current.current !== mine || ctl.signal.aborted) return; // the pointer moved on
            if (result) setTip({ rect: hit.rect, word: hit.word, result });
          },
          () => {}, // a failed lookup shows nothing (the card is where errors are explained)
        );
      }, optsRef.current.delayMs ?? HOVER_DELAY_MS);
    };

    const onMove = (e: PointerEvent) => {
      if (!altAlone(e) || e.buttons !== 0 || !isOn()) {
        last = null;
        if (frame !== null) view.cancelAnimationFrame(frame);
        frame = null;
        if (current.current) reset();
        return;
      }
      last = e;
      if (frame === null) frame = view.requestAnimationFrame(examine);
    };
    const hide = () => {
      last = null;
      if (frame !== null) view.cancelAnimationFrame(frame);
      frame = null;
      if (current.current) reset();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') hide(); // a chord (⌥→ …) or typing: not a hover
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') hide();
    };

    el.addEventListener('pointermove', onMove, { passive: true });
    el.addEventListener('pointerleave', hide, { passive: true });
    el.addEventListener('scroll', hide, { capture: true, passive: true });
    view.addEventListener('keydown', onKeyDown, { passive: true });
    view.addEventListener('keyup', onKeyUp, { passive: true });
    view.addEventListener('blur', hide);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', hide);
      el.removeEventListener('scroll', hide, { capture: true });
      view.removeEventListener('keydown', onKeyDown);
      view.removeEventListener('keyup', onKeyUp);
      view.removeEventListener('blur', hide);
      if (frame !== null) view.cancelAnimationFrame(frame);
      const c = current.current;
      if (c?.timer != null) clearTimeout(c.timer);
      c?.ctl?.abort();
      current.current = null;
      setTip(null); // a root that goes away takes its tip with it
    };
  }, [root, reset]);

  return { tip };
}
