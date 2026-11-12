/**
 * Touch and pen selections end without a mouseup: a long-press selects a word, then the handles are
 * dragged, and nothing fires when the finger lifts. So after a touch or pen gesture began inside `root`,
 * the reader learns about the selection from `selectionchange`, once it has held still for
 * TOUCH_SELECTION_SETTLE_MS. Mouse selections are left to the renderers' mouseup handlers, so desktop
 * behaviour (and timing) is unchanged and nothing is reported twice.
 */
export const TOUCH_SELECTION_SETTLE_MS = 400;

const isTouchLike = (e: PointerEvent): boolean => e.pointerType === 'touch' || e.pointerType === 'pen';

/** Calls `onSettled` when a touch selection in `root` settles (or is cleared). Returns the cleanup. */
export function watchTouchSelection(root: HTMLElement, onSettled: () => void, settleMs = TOUCH_SELECTION_SETTLE_MS): () => void {
  const doc = root.ownerDocument;
  const win = doc.defaultView ?? window;
  let touch = false;
  let timer: number | undefined;

  const onPointerDown = (e: PointerEvent) => {
    touch = isTouchLike(e);
  };
  const onSelectionChange = () => {
    if (!touch) return;
    // A selection made somewhere else (a note editor, the notebook) is not the book's; a collapsing
    // selection still counts, so tapping away hides the popover.
    const sel = doc.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && !root.contains(sel.anchorNode)) return;
    win.clearTimeout(timer);
    timer = win.setTimeout(() => {
      timer = undefined;
      onSettled();
    }, settleMs);
  };

  root.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('selectionchange', onSelectionChange);
  return () => {
    win.clearTimeout(timer);
    root.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('selectionchange', onSelectionChange);
  };
}
