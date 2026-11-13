import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindPinch, PINCH_SETTLE_MS, ZOOM_ANIMATE_MS, type Anchor, type PinchControl } from '../../src/renderers/pinch';

function touchEvent(type: string, points: { x: number; y: number }[]): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'touches', { value: points.map((p) => ({ clientX: p.x, clientY: p.y })) });
  return e;
}

function wheel(ctrlKey: boolean, deltaY: number): WheelEvent {
  return new WheelEvent('wheel', { ctrlKey, deltaY, clientX: 100, clientY: 200, bubbles: true, cancelable: true });
}

describe('bindPinch', () => {
  let scroller: HTMLDivElement;
  let percent: number;
  let commits: { percent: number; anchor: Anchor }[];
  let pinch: PinchControl;
  let reduced: boolean;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    reduced = false;
    // jsdom has no matchMedia.
    window.matchMedia = ((q: string) => ({ matches: reduced && q.includes('reduce') }) as MediaQueryList) as typeof window.matchMedia;
    scroller = document.createElement('div');
    Object.defineProperty(scroller, 'clientWidth', { value: 800 });
    Object.defineProperty(scroller, 'clientHeight', { value: 600 });
    document.body.appendChild(scroller);
    percent = 100;
    commits = [];
    pinch = bindPinch({
      scroller,
      percent: () => percent,
      readingAnchor: () => ({ clientX: 400, clientY: 200 }),
      commit: (p, anchor) => {
        // The renderer measures while committing: the preview must be gone by then.
        expect(scroller.classList.contains('is-pinching')).toBe(false);
        commits.push({ percent: p, anchor });
        percent = p;
      },
    });
  });

  afterEach(() => {
    pinch.dispose();
    scroller.remove();
    vi.useRealTimers();
    Reflect.deleteProperty(window, 'matchMedia');
  });

  const scale = () => Number(scroller.style.getPropertyValue('--pinch-scale'));

  it('previews a ctrl+wheel pinch and applies it once it settles', () => {
    scroller.dispatchEvent(wheel(true, -10));
    scroller.dispatchEvent(wheel(true, -10));
    expect(scroller.classList.contains('is-pinching')).toBe(true);
    expect(scale()).toBeGreaterThan(1.2);
    expect(scroller.style.getPropertyValue('--pinch-ox')).toBe('100px');
    expect(commits).toEqual([]);
    vi.advanceTimersByTime(PINCH_SETTLE_MS);
    expect(commits).toHaveLength(1);
    expect(commits[0].percent).toBeCloseTo(100 * Math.exp(0.2));
    expect(commits[0].anchor).toEqual({ clientX: 100, clientY: 200 });
    expect(scroller.classList.contains('is-pinching')).toBe(false);
    expect(scroller.style.getPropertyValue('--pinch-scale')).toBe('');
  });

  it('applies a settling pinch at once when plain scrolling starts', () => {
    scroller.dispatchEvent(wheel(true, -10));
    scroller.dispatchEvent(wheel(false, 40));
    expect(commits).toHaveLength(1);
    vi.advanceTimersByTime(PINCH_SETTLE_MS);
    expect(commits).toHaveLength(1);
  });

  it('follows two fingers and applies the zoom and the pan when they lift', () => {
    scroller.scrollTop = 500;
    scroller.dispatchEvent(touchEvent('touchstart', [{ x: 100, y: 300 }, { x: 200, y: 300 }]));
    const move = touchEvent('touchmove', [{ x: 50, y: 320 }, { x: 250, y: 320 }]);
    scroller.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
    expect(scale()).toBe(2);
    expect(scroller.style.getPropertyValue('--pinch-y')).toBe('20px');
    expect(commits).toEqual([]);
    scroller.dispatchEvent(touchEvent('touchend', [{ x: 50, y: 320 }]));
    expect(commits).toEqual([{ percent: 200, anchor: { clientX: 150, clientY: 300 } }]);
    expect(scroller.scrollTop).toBe(480);
  });

  it('keeps a pinch within 50–300 %', () => {
    scroller.dispatchEvent(touchEvent('touchstart', [{ x: 100, y: 300 }, { x: 110, y: 300 }]));
    scroller.dispatchEvent(touchEvent('touchmove', [{ x: 0, y: 300 }, { x: 500, y: 300 }]));
    scroller.dispatchEvent(touchEvent('touchend', []));
    expect(commits[0].percent).toBe(300);
  });

  it('ignores one finger', () => {
    scroller.dispatchEvent(touchEvent('touchstart', [{ x: 100, y: 300 }]));
    const move = touchEvent('touchmove', [{ x: 100, y: 200 }]);
    scroller.dispatchEvent(move);
    scroller.dispatchEvent(touchEvent('touchend', []));
    expect(move.defaultPrevented).toBe(false);
    expect(commits).toEqual([]);
    expect(scroller.classList.contains('is-pinching')).toBe(false);
  });

  it('animates a zoom step around the reading line, then applies it', () => {
    pinch.animateTo(110);
    vi.advanceTimersByTime(ZOOM_ANIMATE_MS / 2);
    expect(scroller.classList.contains('is-pinching')).toBe(true);
    expect(scale()).toBeGreaterThan(1);
    expect(scale()).toBeLessThan(1.1);
    expect(commits).toEqual([]);
    vi.advanceTimersByTime(ZOOM_ANIMATE_MS);
    expect(commits).toEqual([{ percent: 110, anchor: { clientX: 400, clientY: 200 } }]);
    expect(scroller.classList.contains('is-pinching')).toBe(false);
  });

  it('lets a step finish when a held key repeats it', () => {
    pinch.animateTo(110);
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(ZOOM_ANIMATE_MS / 3);
      pinch.animateTo(110);
    }
    expect(commits).toEqual([{ percent: 110, anchor: { clientX: 400, clientY: 200 } }]);
  });

  it('applies a step at once when motion is reduced', () => {
    reduced = true;
    pinch.animateTo(120);
    expect(commits).toEqual([{ percent: 120, anchor: { clientX: 400, clientY: 200 } }]);
    expect(scroller.classList.contains('is-pinching')).toBe(false);
  });

  it('drops a preview on cancel without applying it', () => {
    scroller.dispatchEvent(wheel(true, -10));
    pinch.cancel();
    vi.advanceTimersByTime(PINCH_SETTLE_MS * 2);
    expect(commits).toEqual([]);
    expect(scroller.classList.contains('is-pinching')).toBe(false);
  });
});
