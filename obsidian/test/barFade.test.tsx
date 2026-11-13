import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FADE_SCROLL_PX, useBarFade } from '../../src/features/reader/toolbar/useBarFade';

function reader() {
  const area = document.body.appendChild(document.createElement('div'));
  const scroller = area.appendChild(document.createElement('div'));
  scroller.className = 'pdf-scroller';
  const p = scroller.appendChild(document.createElement('p'));
  p.textContent = 'text';
  const scrollTo = (top: number) =>
    act(() => {
      scroller.scrollTop = top;
      scroller.dispatchEvent(new Event('scroll'));
    });
  const tap = (el: Element, pointerType = 'touch') =>
    act(() => {
      const down = new Event('pointerdown', { bubbles: true });
      Object.defineProperty(down, 'pointerType', { value: pointerType });
      el.dispatchEvent(down);
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  return { area, scroller, p, scrollTo, tap };
}

afterEach(() => document.body.replaceChildren());

describe('useBarFade', () => {
  it('fades when the book scrolls down and comes back when it scrolls up', () => {
    const r = reader();
    const { result } = renderHook(() => useBarFade(r.area, true));
    expect(result.current).toBe(false);
    r.scrollTo(100);
    r.scrollTo(400);
    expect(result.current).toBe(true);
    // A small wobble changes nothing.
    r.scrollTo(400 - FADE_SCROLL_PX + 1);
    expect(result.current).toBe(true);
    r.scrollTo(300);
    expect(result.current).toBe(false);
  });

  it('a tap on the page shows or hides it; a mouse click and a tap on a button do not', () => {
    const r = reader();
    const button = r.scroller.appendChild(document.createElement('button'));
    const { result } = renderHook(() => useBarFade(r.area, true));
    r.tap(r.p);
    expect(result.current).toBe(true);
    r.tap(r.p, 'mouse');
    expect(result.current).toBe(true);
    r.tap(button);
    expect(result.current).toBe(true);
    r.tap(r.p);
    expect(result.current).toBe(false);
  });

  it('never fades while the book is not open, and comes back when it closes', () => {
    const r = reader();
    const { result, rerender } = renderHook(({ on }) => useBarFade(r.area, on), { initialProps: { on: false } });
    r.scrollTo(100);
    r.scrollTo(500);
    expect(result.current).toBe(false);
    rerender({ on: true });
    r.scrollTo(900);
    r.scrollTo(1300);
    expect(result.current).toBe(true);
    rerender({ on: false });
    expect(result.current).toBe(false);
  });
});
