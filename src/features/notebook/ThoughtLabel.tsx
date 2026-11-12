import type { ThoughtLabel } from '../../lib/labels';

/** A thought's name: one custom line, or section (semibold) over snippet (italic). Spec §6. */
export function ThoughtLabelView({ label }: { label: ThoughtLabel }) {
  if (label.kind === 'none') return null;
  if (label.kind === 'custom') {
    return (
      <span className="thought-label">
        <span className="thought-label-custom">{label.text}</span>
      </span>
    );
  }
  return (
    <span className="thought-label">
      {label.section && <span className="thought-label-section">{label.section}</span>}
      <span className="thought-label-snippet">{label.snippet}</span>
    </span>
  );
}
