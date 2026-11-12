import type { Ref } from 'react';

/** How much of the body the accessible name carries. */
const NAME_CHARS = 60;
const EMPTY = 'Write a thought…';

/** The body on one line, cut to its first 60 characters with "…"; the placeholder when empty. */
function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (!flat) return EMPTY;
  const chars = Array.from(flat);
  return chars.length > NAME_CHARS ? `${chars.slice(0, NAME_CHARS).join('').trimEnd()}…` : flat;
}

/**
 * A thought's text, read-only, shown where another surface holds its editor (one editor per thought,
 * see editorOwners.ts). The whole preview is a button that takes the reader to the editor. Its visible
 * cue ("Write in the margin ›") names the action, and its accessible name starts with that cue, then the
 * opening of the text: "Write in the margin: <first 60 characters>…" (label in name).
 */
export function ThoughtPreview({
  body,
  action,
  onActivate,
  buttonRef,
}: {
  body: string;
  /** The visible cue and the start of the accessible name ("Write in the margin"). */
  action: string;
  onActivate: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="thought-preview"
      aria-label={`${action}: ${excerpt(body)}`}
      onClick={onActivate}
    >
      {body.trim() ? body : <span className="thought-preview-empty">{EMPTY}</span>}
      <span className="thought-preview-hint" aria-hidden="true">
        {action} ›
      </span>
    </button>
  );
}
