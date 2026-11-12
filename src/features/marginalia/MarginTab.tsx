import type { CSSProperties, Ref } from 'react';
import { labelText, thoughtLabel } from '../../lib/labels';
import { labelLine, type MarginEntry } from './marginModel';

const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

/** A thought in a narrow window's margin (spec §5.2): its label's first line; clicking opens its note as a card. */
export function MarginTab({
  entry,
  open,
  fresh,
  style,
  tabRef,
  onToggle,
  onHoverChange,
}: {
  entry: MarginEntry;
  open: boolean;
  fresh: boolean;
  style: CSSProperties;
  tabRef: Ref<HTMLButtonElement>;
  onToggle: () => void;
  onHoverChange: (id: string, hovering: boolean) => void;
}) {
  const id = entry.thought.id;
  const label = thoughtLabel(entry.thought, { location: entry.location, quote: entry.anchor?.quote ?? null });
  const text = labelLine(label) || entry.location.label;
  return (
    <button
      ref={tabRef}
      type="button"
      className={cx('margin-tab', `note-${entry.color ?? 'pin'}`, open && 'is-open', fresh && 'is-new')}
      style={style}
      aria-label={`Thought: ${text}`}
      aria-expanded={open}
      title={labelText(label) || text}
      data-thought-id={id}
      onClick={onToggle}
      onMouseEnter={() => onHoverChange(id, true)}
      onMouseLeave={() => onHoverChange(id, false)}
    >
      <span className="margin-tab-text">{text}</span>
    </button>
  );
}
