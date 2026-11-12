import type { CSSProperties, Ref } from 'react';
import { labelText, thoughtLabel } from '../../lib/labels';
import { labelLine, type MarginEntry } from './marginModel';

const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

/**
 * A thought in focus mode's margin: an 8 px dot at its line, in its highlight's ink (blue ink for a pin).
 * Hovering or focusing it shows its note as a card; clicking puts the caret in that card's editor.
 */
export function MarginDot({
  entry,
  open,
  fresh,
  style,
  dotRef,
  onActivate,
  onHoverChange,
  onFocusChange,
}: {
  entry: MarginEntry;
  open: boolean;
  fresh: boolean;
  style: CSSProperties;
  dotRef: Ref<HTMLButtonElement>;
  onActivate: () => void;
  onHoverChange: (id: string, hovering: boolean) => void;
  onFocusChange: (id: string, focused: boolean) => void;
}) {
  const id = entry.thought.id;
  const label = thoughtLabel(entry.thought, { location: entry.location, quote: entry.anchor?.quote ?? null });
  const text = labelLine(label) || entry.location.label;
  return (
    <button
      ref={dotRef}
      type="button"
      className={cx('margin-dot', `note-${entry.color ?? 'pin'}`, open && 'is-open', fresh && 'is-new')}
      style={style}
      aria-label={`Thought: ${text}`}
      aria-expanded={open}
      title={labelText(label) || text}
      data-thought-id={id}
      onClick={onActivate}
      onMouseEnter={() => onHoverChange(id, true)}
      onMouseLeave={() => onHoverChange(id, false)}
      onFocus={() => onFocusChange(id, true)}
      onBlur={() => onFocusChange(id, false)}
    >
      <span className="margin-dot-mark" aria-hidden="true" />
    </button>
  );
}
