import { clamp } from './pdf/layout';
import { GESTURE_STALE_MS, pinchZoom, wheelDeltaPx, ZOOM_MAX, ZOOM_MIN } from './pdf/zoom';

/**
 * Smooth zoom for both renderers. While fingers or a trackpad pinch, or while a zoom step animates, the
 * scroller is only scaled with a CSS transform around the pinch point (`.is-pinching`, the --pinch-*
 * variables in pdf.css): no re-layout, no re-render, so it follows the fingers frame by frame. When the
 * gesture ends (fingers lift, gestureend, or ctrl+wheel goes quiet for PINCH_SETTLE_MS) the transform is
 * dropped and the real zoom applied in the same task, keeping the point under the pinch where the preview
 * showed it, so there is nothing to see between the two.
 */

export interface Anchor {
  clientX: number;
  clientY: number;
}

export interface PinchHost {
  /** The scroll container. The preview scales it, so its parent must clip (`.reader-host`). */
  scroller: HTMLElement;
  /** The zoom being shown, in percent. */
  percent(): number;
  /** Where a zoom step without a pointer holds still: the renderer's reading line. */
  readingAnchor(): Anchor;
  /** Applies `percent` for real, keeping the content under `anchor` at `anchor`. Synchronous. */
  commit(percent: number, anchor: Anchor): void;
}

export interface PinchControl {
  /** Animates to `percent` (a zoom button or key), then commits. Instant when motion is reduced. */
  animateTo(percent: number, anchor?: Anchor): void;
  /** Drops any preview without applying it (an explicit zoom choice replaces it). */
  cancel(): void;
  /** True while a preview is on screen. */
  active(): boolean;
  dispose(): void;
}

/** ctrl+wheel (trackpad pinch, ctrl + mouse wheel) commits after this long without another event. */
export const PINCH_SETTLE_MS = 160;
/** A zoom step's animation. */
export const ZOOM_ANIMATE_MS = 180;

const VARS = ['--pinch-scale', '--pinch-x', '--pinch-y', '--pinch-ox', '--pinch-oy'] as const;

interface Preview {
  /** The committed zoom the preview scales from. */
  base: number;
  /** The zoom shown, unrounded. */
  percent: number;
  /** The pinch point, in client coordinates at the start. */
  anchor: Anchor;
  /** The pinch point in the scroller's box (the transform origin). */
  ox: number;
  oy: number;
  /** How far two fingers have moved together since they landed. */
  panX: number;
  panY: number;
}

const ease = (t: number) => 1 - (1 - t) ** 3;

export function bindPinch(host: PinchHost): PinchControl {
  const s = host.scroller;
  const win = s.ownerDocument.defaultView ?? window;
  let preview: Preview | null = null;
  let settle: number | undefined;
  let frame: number | undefined;
  let anim: { from: number; to: number; start: number } | null = null;
  let touch: { dist: number; midX: number; midY: number } | null = null;
  let gesture = false;
  let gestureBase = 100;

  const clearTimers = () => {
    if (settle !== undefined) win.clearTimeout(settle);
    settle = undefined;
    if (frame !== undefined) win.cancelAnimationFrame(frame);
    frame = undefined;
    anim = null;
  };

  const start = (anchor: Anchor): Preview => {
    if (preview) return preview;
    const r = s.getBoundingClientRect();
    const base = host.percent();
    preview = { base, percent: base, anchor, ox: anchor.clientX - r.left, oy: anchor.clientY - r.top, panX: 0, panY: 0 };
    return preview;
  };

  const show = () => {
    if (!preview) return;
    const st = s.style;
    st.setProperty('--pinch-scale', String(preview.percent / preview.base));
    st.setProperty('--pinch-x', `${preview.panX}px`);
    st.setProperty('--pinch-y', `${preview.panY}px`);
    st.setProperty('--pinch-ox', `${preview.ox}px`);
    st.setProperty('--pinch-oy', `${preview.oy}px`);
    s.classList.add('is-pinching');
  };

  const hide = () => {
    s.classList.remove('is-pinching');
    for (const v of VARS) s.style.removeProperty(v);
  };

  const commit = () => {
    clearTimers();
    const p = preview;
    preview = null;
    // The transform goes first: the renderer measures the scroller and its pages while it re-lays out.
    hide();
    if (!p) return;
    const percent = clamp(p.percent, ZOOM_MIN, ZOOM_MAX);
    if (Math.abs(percent - p.base) >= 0.5) host.commit(percent, p.anchor);
    // Two fingers that moved together pan: the pinch point lands where they are now.
    if (p.panX) s.scrollLeft -= p.panX;
    if (p.panY) s.scrollTop -= p.panY;
  };

  const cancel = () => {
    clearTimers();
    preview = null;
    touch = null;
    hide();
  };

  // ---- ctrl+wheel: Chromium's trackpad pinch, and ctrl + a mouse wheel ----
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) {
      // Scrolling during a settling pinch: apply it first, so the scroll moves the real layout.
      if (preview && !anim && !touch && !gesture) commit();
      return;
    }
    e.preventDefault();
    if (gesture || touch) return;
    if (anim) commit();
    const p = start({ clientX: e.clientX, clientY: e.clientY });
    p.percent = pinchZoom(p.percent, wheelDeltaPx(e.deltaY, e.deltaMode, s.clientHeight));
    show();
    if (settle !== undefined) win.clearTimeout(settle);
    settle = win.setTimeout(commit, PINCH_SETTLE_MS);
  };

  // ---- two fingers on a touch screen (iOS and Android) ----
  const two = (e: TouchEvent) => {
    const [a, b] = [e.touches[0], e.touches[1]];
    return { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), midX: (a.clientX + b.clientX) / 2, midY: (a.clientY + b.clientY) / 2 };
  };
  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 2) return;
    if (preview) commit();
    touch = two(e);
    if (!(touch.dist > 0)) {
      touch = null;
      return;
    }
    start({ clientX: touch.midX, clientY: touch.midY });
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!touch || !preview || e.touches.length < 2) return;
    e.preventDefault();
    const now = two(e);
    preview.percent = clamp((preview.base * now.dist) / touch.dist, ZOOM_MIN, ZOOM_MAX);
    preview.panX = now.midX - touch.midX;
    preview.panY = now.midY - touch.midY;
    show();
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (!touch || e.touches.length >= 2) return;
    touch = null;
    commit();
  };

  // ---- WebKit gesture events (Safari's trackpad and touch pinch); ignored under a touch pinch ----
  const endGesture = () => {
    if (!gesture) return;
    gesture = false;
    commit();
  };
  let gestureStale: number | undefined;
  const touchGesture = () => {
    gesture = true;
    if (gestureStale !== undefined) win.clearTimeout(gestureStale);
    gestureStale = win.setTimeout(endGesture, GESTURE_STALE_MS);
  };
  const onGestureStart = (e: Event) => {
    e.preventDefault();
    if (touch) return;
    if (preview) commit();
    touchGesture();
    gestureBase = host.percent();
  };
  const onGestureChange = (e: Event) => {
    e.preventDefault();
    if (touch || !gesture) return;
    touchGesture();
    const g = e as Event & { scale?: number; clientX?: number; clientY?: number };
    const at = g.clientX !== undefined && g.clientY !== undefined ? { clientX: g.clientX, clientY: g.clientY } : host.readingAnchor();
    const scale = g.scale !== undefined && Number.isFinite(g.scale) && g.scale > 0 ? g.scale : 1;
    const p = start(at);
    p.percent = clamp(gestureBase * scale, ZOOM_MIN, ZOOM_MAX);
    show();
  };
  const onGestureEnd = (e: Event) => {
    e.preventDefault();
    if (gestureStale !== undefined) win.clearTimeout(gestureStale);
    gestureStale = undefined;
    endGesture();
  };
  // A press while a wheel pinch settles (a click, a selection): the real layout first.
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    if (preview && !anim) commit();
  };

  const reduced = () => win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  const animateTo = (percent: number, anchor?: Anchor) => {
    const to = clamp(percent, ZOOM_MIN, ZOOM_MAX);
    if (touch || gesture) return;
    // A wheel pinch still settling: it is applied, and the step goes on from there.
    if (preview && !anim) commit();
    if (reduced() || !(s.clientWidth > 0)) {
      const at = anchor ?? host.readingAnchor();
      if (preview) {
        // An animation in flight: drop it; the new step replaces it.
        clearTimers();
        preview = null;
        hide();
      }
      host.commit(to, at);
      return;
    }
    // A held key repeats the same step until this one lands: let it finish rather than start over.
    if (anim && Math.abs(anim.to - to) < 0.5) return;
    const p = start(anchor ?? host.readingAnchor());
    anim = { from: p.percent, to, start: win.performance.now() };
    const tick = () => {
      frame = undefined;
      if (!preview || !anim) return;
      const t = Math.min(1, (win.performance.now() - anim.start) / ZOOM_ANIMATE_MS);
      preview.percent = anim.from + (anim.to - anim.from) * ease(t);
      show();
      if (t >= 1) commit();
      else frame = win.requestAnimationFrame(tick);
    };
    if (frame === undefined) frame = win.requestAnimationFrame(tick);
  };

  s.addEventListener('wheel', onWheel, { passive: false });
  s.addEventListener('touchstart', onTouchStart, { passive: true });
  s.addEventListener('touchmove', onTouchMove, { passive: false });
  s.addEventListener('touchend', onTouchEnd);
  s.addEventListener('touchcancel', onTouchEnd);
  s.addEventListener('gesturestart', onGestureStart);
  s.addEventListener('gesturechange', onGestureChange);
  s.addEventListener('gestureend', onGestureEnd);
  s.addEventListener('pointerdown', onPointerDown);

  return {
    animateTo,
    cancel,
    active: () => preview !== null,
    dispose() {
      cancel();
      if (gestureStale !== undefined) win.clearTimeout(gestureStale);
      s.removeEventListener('wheel', onWheel);
      s.removeEventListener('touchstart', onTouchStart);
      s.removeEventListener('touchmove', onTouchMove);
      s.removeEventListener('touchend', onTouchEnd);
      s.removeEventListener('touchcancel', onTouchEnd);
      s.removeEventListener('gesturestart', onGestureStart);
      s.removeEventListener('gesturechange', onGestureChange);
      s.removeEventListener('gestureend', onGestureEnd);
      s.removeEventListener('pointerdown', onPointerDown);
    },
  };
}
