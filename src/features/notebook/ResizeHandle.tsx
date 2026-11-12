import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { MAX_WIDTH, MIN_WIDTH } from './useNotebookLayout';
import './notebook.css';

const STEP = 16;

export interface ResizeHandleProps {
  width: number;
  onResize: (width: number, persist: boolean) => void;
  /** Which side of the reader the panel is on; the handle sits on its inner edge. */
  panel?: 'left' | 'right';
  label?: string;
  min?: number;
  max?: number;
}

/** Splitter on a side panel's inner edge: drag it, or focus it and use ←/→ (Home/End = min/max). */
export function ResizeHandle({
  width,
  onResize,
  panel = 'right',
  label = 'Resize notebook',
  min = MIN_WIDTH,
  max = MAX_WIDTH,
}: ResizeHandleProps) {
  const drag = useRef<{ x: number; width: number; last: number } | null>(null);
  const onResizeRef = useRef(onResize);
  useLayoutEffect(() => {
    onResizeRef.current = onResize;
  });
  // Unmounted mid-drag (the panel closed by a shortcut): keep the width reached so far.
  useEffect(
    () => () => {
      const d = drag.current;
      drag.current = null;
      if (d) onResizeRef.current(d.last, true);
    },
    [],
  );
  /** +1 when moving the pointer (or pressing →) to the right widens the panel. */
  const grow = panel === 'left' ? 1 : -1;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.classList.add('is-dragging');
    drag.current = { x: e.clientX, width, last: width };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.last = d.width + grow * (e.clientX - d.x);
    onResize(d.last, false);
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    e.currentTarget.classList.remove('is-dragging');
    onResize(d.last, true);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next =
      e.key === 'ArrowRight'
        ? width + grow * STEP
        : e.key === 'ArrowLeft'
          ? width - grow * STEP
          : e.key === 'Home'
            ? min
            : e.key === 'End'
              ? max
              : null;
    if (next === null) return;
    e.preventDefault();
    onResize(next, true);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      tabIndex={0}
      className="notebook-resizer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}
