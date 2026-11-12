import type { Zoom } from '../types';
import { clamp, FIT_GUTTER, fitScale } from './layout';

export const ZOOM_MIN = 50;
export const ZOOM_MAX = 300;
export const ZOOM_STEP = 10;
export const ZOOM_PRESETS: readonly number[] = [75, 100, 125, 150, 200, 300];

/** A whole percentage within 50–300. */
export const clampZoom = (percent: number): number => Math.round(clamp(percent, ZOOM_MIN, ZOOM_MAX));

/** The next 10 % step from `percent` (113 → 120 up, 110 down), clamped. */
export function stepZoom(percent: number, dir: 1 | -1): number {
  const next =
    dir > 0
      ? Math.floor(percent / ZOOM_STEP) * ZOOM_STEP + ZOOM_STEP
      : Math.ceil(percent / ZOOM_STEP) * ZOOM_STEP - ZOOM_STEP;
  return clampZoom(next);
}

/** pdf.js scale for `zoom` in a scroller `box`, for a page that is `page` big at scale 1. */
export function scaleFor(
  zoom: Zoom,
  box: { width: number; height: number },
  page: { width: number; height: number },
): number {
  if (typeof zoom === 'number') return clampZoom(zoom) / 100;
  const byWidth = fitScale(box.width, page.width);
  if (zoom === 'fit-width' || !(page.height > 0)) return byWidth;
  return Math.min(byWidth, clamp((box.height - FIT_GUTTER) / page.height, ZOOM_MIN / 100, ZOOM_MAX / 100));
}

export const percentOf = (scale: number): number => Math.round(scale * 100);

/** A pinch, and a held ⌘=/⌘−, apply at most this often (each application re-renders the visible pages). */
export const PINCH_APPLY_MS = 120;

/** A pinch gesture with no gesture event for this long is treated as ended (a lost gestureend). */
export const GESTURE_STALE_MS = 1000;

/** books.zoom → Zoom. NULL, garbage and out-of-range values read as fit width. */
export function parseZoom(s: string | null | undefined): Zoom {
  if (s === 'fit-width' || s === 'fit-page') return s;
  if (s && /^[1-9]\d{1,2}$/.test(s)) {
    const n = Number(s);
    if (n >= ZOOM_MIN && n <= ZOOM_MAX) return n;
  }
  return 'fit-width';
}

/** Zoom → books.zoom (the form Rust's `is_valid_zoom` accepts). */
export const serializeZoom = (z: Zoom): string => (typeof z === 'number' ? String(clampZoom(z)) : z);

/** px per line for a `deltaMode` 1 (DOM_DELTA_LINE) wheel event. */
const WHEEL_LINE_PX = 16;

/** A wheel event's `deltaY` in pixels: lines × 16, pages (`deltaMode` 2) × the viewport height. */
export function wheelDeltaPx(deltaY: number, deltaMode: number, viewportHeight: number): number {
  if (deltaMode === 1) return deltaY * WHEEL_LINE_PX;
  if (deltaMode === 2) return deltaY * viewportHeight;
  return deltaY;
}

/**
 * Most px one ctrl+wheel event counts for: a trackpad pinch sends many small deltas (unaffected),
 * while one mouse-wheel notch can report ~100px, which would jump 100 → 272 %. Capped, a notch is
 * about 12.7 %.
 */
export const PINCH_MAX_DELTA = 12;

/**
 * A pinch step (ctrl+wheel delta in px; negative = spreading the fingers) applied to `percent`.
 * Unrounded, so tiny trackpad steps accumulate; kept within 50–300 so pinching back from past a limit
 * responds at once. Round with clampZoom only when applying.
 */
export function pinchZoom(percent: number, deltaPx: number): number {
  const d = Number.isFinite(deltaPx) ? clamp(deltaPx, -PINCH_MAX_DELTA, PINCH_MAX_DELTA) : 0;
  return clamp(percent * Math.exp(-d / 100), ZOOM_MIN, ZOOM_MAX);
}
