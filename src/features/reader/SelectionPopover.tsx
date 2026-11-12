import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { fixedOrigin, floatBounds, placeOver } from '../../lib/floating';
import { inPageArea, isEditable, shortcutKey } from '../../lib/keys';
import { COLORS, type Annotation, type Color } from '../../lib/types';

export type PopoverMode = { kind: 'new' } | { kind: 'existing'; annotation: Annotation };

interface Props {
  rect: DOMRect;
  mode: PopoverMode;
  onColor: (c: Color) => void;
  onNote: (text: string) => void;
  onThought: () => void;
  /** Translates the selection (or the highlight's quote). None (no translation host, as on desktop): no button, and L is free. */
  onTranslate?: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onClose: () => void;
}

const GAP = 8;

export function SelectionPopover({ rect, mode, onColor, onNote, onThought, onTranslate, onCopy, onDelete, onClose }: Props) {
  const existing = mode.kind === 'existing' ? mode.annotation : null;
  const isExisting = existing !== null;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(existing?.note ?? '');

  useEffect(() => {
    if (editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      // ⌘C on a clicked highlight (no live text selection) copies its quote; ⌘⇧C (Contents) and other
      // chords on C are not copy. With a live selection, the native copy handles it.
      const copyChord = e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'c';
      if (isExisting && !e.repeat && copyChord && !window.getSelection()?.toString()) {
        e.preventDefault();
        onCopy();
        return;
      }
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      // Bare keys belong to the page (or this popover): not to a focused search result, notebook or toolbar button.
      if (!inPageArea(e.target) && !(e.target instanceof Element && e.target.closest('.popover'))) return;
      // A non-Latin layout (Ukrainian) reads the key's QWERTY place.
      const k = shortcutKey(e);
      const i = ['1', '2', '3', '4', '5'].indexOf(k);
      if (i >= 0) {
        e.preventDefault();
        onColor(COLORS[i]);
      } else if (k === 'n' || k === 'N') {
        e.preventDefault();
        setEditing(true);
      } else if (k === 't' || k === 'T' || k === 'm' || k === 'M') {
        // T is the key shown; M (the M3 key) still works.
        e.preventDefault();
        onThought();
      } else if ((k === 'l' || k === 'L') && onTranslate) {
        e.preventDefault();
        onTranslate();
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, isExisting, onColor, onThought, onTranslate, onCopy, onClose]);

  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; below: boolean } | null>(null);

  // Measure after mount (and whenever the content changes size), then place: above the selection if it
  // fits, otherwise below; always inside the reader (its root's box within the window: in Obsidian the
  // reader is one pane and clips what overflows it).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Layout size: getBoundingClientRect is scaled by the entry animation's transform.
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const placed = placeOver(rect, { width, height }, floatBounds(el), GAP);
    // placeOver works in viewport coordinates; a fixed box is placed from its containing block's corner,
    // which in Obsidian is the leaf (contain: strict), not the viewport.
    const origin = fixedOrigin(el);
    const top = placed.top - origin.y;
    const left = placed.left - origin.x;
    const below = placed.below;
    setPos((p) => (p && p.top === top && p.left === left && p.below === below ? p : { top, left, below }));
  }, [rect, editing, existing?.note]);

  const style: CSSProperties = pos
    ? { position: 'fixed', top: pos.top, left: pos.left }
    : { position: 'fixed', top: rect.bottom + GAP, left: rect.left, visibility: 'hidden' };

  return (
    <div
      ref={ref}
      className={pos?.below ? 'popover below' : 'popover'}
      style={style}
      role="dialog"
      aria-label="Annotation actions"
      // keep the text selection alive when clicking buttons
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLTextAreaElement)) e.preventDefault();
      }}
    >
      {editing ? (
        <>
          <textarea
            autoFocus
            aria-label="Note"
            aria-describedby="popover-note-hint"
            value={text}
            placeholder="Add a note"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onNote(text);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <p id="popover-note-hint" className="popover-hint">
            Enter to save · Shift+Enter for a new line · Esc to cancel
          </p>
        </>
      ) : (
        <div className="popover-row">
          <span className="dot-wrap">
            {COLORS.map((c, i) => (
              <button
                key={c}
                type="button"
                className={`dot dot-${c}`}
                aria-label={`Highlight ${c} (${i + 1})`}
                aria-keyshortcuts={String(i + 1)}
                aria-pressed={existing ? existing.color === c : undefined}
                onClick={() => onColor(c)}
              />
            ))}
          </span>
          <span className="key-hint popover-keys" aria-hidden="true">
            1–5
          </span>
          <span className="popover-sep" aria-hidden="true" />
          <button type="button" className="popover-btn" aria-keyshortcuts="N" onClick={() => setEditing(true)}>
            {existing?.note ? 'Edit Note' : 'Note'}
            <span className="key-hint" aria-hidden="true">N</span>
          </button>
          <button type="button" className="popover-btn" aria-keyshortcuts="T" onClick={onThought}>
            Thought
            <span className="key-hint" aria-hidden="true">T</span>
          </button>
          {onTranslate && (
            <button type="button" className="popover-btn" aria-keyshortcuts="L" onClick={onTranslate}>
              Translate
              <span className="key-hint" aria-hidden="true">L</span>
            </button>
          )}
          <button type="button" className="popover-btn" aria-keyshortcuts="Meta+C" onClick={onCopy}>
            Copy
            <span className="key-hint" aria-hidden="true">⌘C</span>
          </button>
          {existing && (
            <>
              <span className="popover-sep" aria-hidden="true" />
              <button type="button" className="popover-btn danger" onClick={onDelete}>
                Delete
              </button>
            </>
          )}
        </div>
      )}
      {!editing && existing?.note && <p className="popover-note">{existing.note}</p>}
    </div>
  );
}
