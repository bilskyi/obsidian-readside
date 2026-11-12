// The ⌥-hover tooltip: the translation over the word, with a small "en → uk" and the dim original, or a
// one-line hint. Placed like the popover (placeOver inside the reader, from the fixed box's real origin);
// it takes no pointer events and no focus, so it never gets in the way of what is under it.
//
// Why role="tooltip" with no aria-describedby: the tip describes a word of the page, which is not a
// focusable control there is nothing to point aria-describedby from. The role keeps it out of the
// tab order and tells assistive tech it is a transient description; ⌥-hover is a pointer feature, and
// the selection card (L) is the keyboard and screen-reader route to the same translation.
//
// The first, hidden pass is measured at left: 0 (not at the word): measured near the right edge, the
// tip would wrap to a narrower width there and then jump when placed.
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { fixedOrigin, floatBounds, placeOver } from '../../lib/floating';
import type { HoverTip } from './useAltHoverWord';
import './translationCard.css';

const GAP = 6;

export function WordTooltip({ tip }: { tip: HoverTip }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const placed = placeOver(tip.rect, { width: el.offsetWidth, height: el.offsetHeight }, floatBounds(el), GAP);
    const origin = fixedOrigin(el);
    const top = placed.top - origin.y;
    const left = placed.left - origin.x;
    setPos((p) => (p && p.top === top && p.left === left ? p : { top, left }));
  });
  const style: CSSProperties = pos
    ? { position: 'fixed', top: pos.top, left: pos.left }
    : { position: 'fixed', top: 0, left: 0, visibility: 'hidden' };
  const r = tip.result;
  return (
    <div ref={ref} className="word-tip" role="tooltip" style={style}>
      {'hint' in r ? (
        <span className="wt-hint">{r.hint}</span>
      ) : (
        <>
          <span className="wt-text" lang={r.to}>
            {r.text}
          </span>
          <span className="wt-meta">
            <span className="wt-pair">
              {r.from} → {r.to}
            </span>{' '}
            <span className="wt-orig" lang={r.from}>
              {tip.word}
            </span>
          </span>
        </>
      )}
    </div>
  );
}
