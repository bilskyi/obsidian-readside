import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { Backlink, BacklinkMarker } from './backlinks';

/** A marker's height in the margin layout. */
export const BACKLINK_HEIGHT = 22;

const notesText = (n: number) => (n === 1 ? '1 note' : `${n} notes`);

/**
 * Where a marker's list may sit (scroller content coordinates), decided by the column: `below` is its top
 * when it hangs under (or level with) the chip, `above` where it ends when it is flipped over the chip,
 * `limit` the content bottom it should not pass.
 */
export interface BacklinkPopPlace {
  x: number;
  below: number;
  above: number;
  limit: number;
  width: number;
}

/**
 * Notes that link to one place in the book (Obsidian: vault notes): a small "↩ 2" chip in the margin,
 * stacked with the notes by the margin layout. Clicking it opens a small list of those notes, each with
 * the line that holds its link; choosing one opens the note (⌘ or Ctrl: in a new tab). The list closes on
 * Escape, a press outside, or focus leaving both the chip and the list; ↑ ↓ Home End move between its rows.
 */
export function MarginBacklink({
  marker,
  open,
  style,
  pop,
  onToggle,
  onClose,
  onOpen,
  onHover,
}: {
  marker: BacklinkMarker;
  open: boolean;
  style: CSSProperties;
  pop: BacklinkPopPlace;
  onToggle: () => void;
  onClose: () => void;
  onOpen: (link: Backlink, newTab: boolean) => void;
  onHover?: (link: Backlink, event: globalThis.MouseEvent, targetEl: HTMLElement) => void;
}) {
  const popId = useId();
  const chipRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const label = `Linked from ${notesText(marker.notes)}`;
  // Spoken words, not the § glyph: a screen reader says "section 3".
  const chipLabel = `${label}, ${marker.location.kind === 'epub' ? `section ${marker.page}` : `page ${marker.page}`}`;
  /** The row that holds the Tab stop (roving focus). */
  const [active, setActive] = useState(0);
  /** The list's measured height: it flips above the chip when it would run past the content. */
  const [height, setHeight] = useState(0);

  // Opened: the first note takes focus, so the list is reachable from the keyboard at once.
  useEffect(() => {
    if (!open) return;
    setActive(0);
    popRef.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }, [open]);
  useLayoutEffect(() => {
    if (open) setHeight(popRef.current?.offsetHeight ?? 0);
  }, [open, marker.links.length]);
  // A press outside the chip and its list closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      const t = e.target instanceof Node ? e.target : null;
      if (t && (chipRef.current?.contains(t) || popRef.current?.contains(t))) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open, onClose]);

  const inside = (n: EventTarget | null) => n instanceof Node && (!!chipRef.current?.contains(n) || !!popRef.current?.contains(n));
  // Focus left both the chip and the list (Tab out, a click on something focusable elsewhere): closed.
  const onBlur = (e: FocusEvent) => {
    if (open && !inside(e.relatedTarget)) onClose();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !open) return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
    chipRef.current?.focus();
  };
  const onListKeyDown = (e: KeyboardEvent) => {
    const rows = Array.from(popRef.current?.querySelectorAll<HTMLButtonElement>('.margin-backlink-item') ?? []);
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const n = rows.length;
    const next =
      e.key === 'ArrowDown' ? (at + 1) % n : e.key === 'ArrowUp' ? (at - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
    if (next === null || n === 0) return onKeyDown(e);
    e.preventDefault();
    e.stopPropagation();
    setActive(next);
    rows[next].focus();
  };
  const choose = (link: Backlink, newTab: boolean) => {
    onClose();
    onOpen(link, newTab);
  };

  const flip = height > 0 && pop.below + height > pop.limit && pop.above - height >= 0;
  const popStyle: CSSProperties = {
    transform: `translate(${pop.x}px, ${flip ? pop.above - height : pop.below}px)`,
    width: pop.width,
  };

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className="margin-backlink"
        style={style}
        aria-label={chipLabel}
        title={chipLabel}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-haspopup="dialog"
        data-backlink={marker.key}
        onClick={onToggle}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      >
        <span className="margin-backlink-glyph" aria-hidden="true">
          ↩
        </span>
        <span aria-hidden="true">{marker.notes}</span>
      </button>
      {open && (
        <div
          ref={popRef}
          id={popId}
          className="margin-backlink-pop"
          role="dialog"
          aria-label={label}
          data-flipped={flip ? '' : undefined}
          style={popStyle}
          onKeyDown={onListKeyDown}
          onBlur={onBlur}
        >
          <ul className="margin-backlink-list">
            {marker.links.map((link, i) => (
              <li key={link.id}>
                <button
                  type="button"
                  className="margin-backlink-item"
                  tabIndex={i === active ? 0 : -1}
                  onFocus={() => setActive(i)}
                  onClick={(e: MouseEvent) => choose(link, e.metaKey || e.ctrlKey)}
                  onAuxClick={(e: MouseEvent) => {
                    if (e.button === 1) choose(link, true);
                  }}
                  onMouseOver={(e: MouseEvent<HTMLButtonElement>) => onHover?.(link, e.nativeEvent, e.currentTarget)}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      choose(link, true);
                    }
                  }}
                >
                  <span className="margin-backlink-title">{link.sourceTitle}</span>
                  {link.snippet && <span className="margin-backlink-snippet">{link.snippet}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
