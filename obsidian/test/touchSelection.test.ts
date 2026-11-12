import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOUCH_SELECTION_SETTLE_MS, watchTouchSelection } from '../../src/lib/touchSelection';

function pointerDown(target: Element, pointerType: string): void {
  const e = new Event('pointerdown', { bubbles: true });
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  target.dispatchEvent(e);
}

function select(node: Node, start: number, end: number): void {
  const r = document.createRange();
  r.setStart(node, start);
  r.setEnd(node, end);
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(r);
  document.dispatchEvent(new Event('selectionchange'));
}

describe('watchTouchSelection', () => {
  let book: HTMLDivElement;
  let elsewhere: HTMLDivElement;
  let stop: () => void;
  const settled = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    settled.mockReset();
    book = document.createElement('div');
    book.innerHTML = '<p>The studio was filled with the rich odour of roses.</p>';
    elsewhere = document.createElement('div');
    elsewhere.textContent = 'A thought being typed in the notebook.';
    document.body.append(book, elsewhere);
    stop = watchTouchSelection(book, settled);
  });
  afterEach(() => {
    stop();
    book.remove();
    elsewhere.remove();
    document.getSelection()?.removeAllRanges();
    vi.useRealTimers();
  });

  const text = () => book.querySelector('p')!.firstChild!;

  it('reports a touch selection once it has held still', () => {
    pointerDown(book, 'touch');
    select(text(), 4, 10);
    vi.advanceTimersByTime(TOUCH_SELECTION_SETTLE_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('waits while the handles are dragged, then reports once', () => {
    pointerDown(book, 'touch');
    select(text(), 4, 10);
    vi.advanceTimersByTime(TOUCH_SELECTION_SETTLE_MS / 2);
    select(text(), 4, 20);
    vi.advanceTimersByTime(TOUCH_SELECTION_SETTLE_MS / 2);
    select(text(), 4, 30);
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TOUCH_SELECTION_SETTLE_MS);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('works for a pen', () => {
    pointerDown(book, 'pen');
    select(text(), 0, 3);
    vi.advanceTimersByTime(TOUCH_SELECTION_SETTLE_MS);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('leaves mouse selections to mouseup (nothing reported twice on desktop)', () => {
    pointerDown(book, 'mouse');
    select(text(), 4, 10);
    vi.advanceTimersByTime(TOUCH_SELECTION_SETTLE_MS * 2);
    expect(settled).not.toHaveBeenCalled();
  });

  it('ignores a selection made outside the book', () => {
    pointerDown(book, 'touch');
    select(elsewhere.firstChild!, 0, 9);
    vi.advanceTimersByTime(TOUCH_SELECTION_SETTLE_MS * 2);
    expect(settled).not.toHaveBeenCalled();
  });

  it('reports a cleared selection, so tapping away hides the popover', () => {
    pointerDown(book, 'touch');
    select(text(), 4, 10);
    vi.advanceTimersByTime(TOUCH_SELECTION_SETTLE_MS);
    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(TOUCH_SELECTION_SETTLE_MS);
    expect(settled).toHaveBeenCalledTimes(2);
  });

  it('stops listening after cleanup, and drops a pending report', () => {
    pointerDown(book, 'touch');
    select(text(), 4, 10);
    stop();
    vi.advanceTimersByTime(TOUCH_SELECTION_SETTLE_MS * 2);
    select(text(), 4, 12);
    vi.advanceTimersByTime(TOUCH_SELECTION_SETTLE_MS * 2);
    expect(settled).not.toHaveBeenCalled();
  });
});
