import { useEffect, useState } from 'react';
import type { OpenError } from './openError';

/** The opening state shows only after this long, so a fast open never flashes it. */
export const OPENING_DELAY_MS = 200;

/**
 * True once `on` has stayed true for `ms`; false again as soon as it turns false. `ms <= 0`: true at once
 * (the host already showed the opening state, so it carries on without a gap).
 */
export function useShownAfter(on: boolean, ms: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) {
      setShown(false);
      return;
    }
    if (ms <= 0) return;
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return on && (ms <= 0 || shown);
}

/** What the status region says while a book opens, and once it has (after the opening state showed). */
export const openingAnnouncement = (title: string) => `Opening ${title}…`;
export const openedAnnouncement = (title: string) => `${title} opened`;

/**
 * The polite live region for the opening state: mounted before its text changes (a region that appears
 * with its text is often not announced), empty when there is nothing to say.
 */
export function StatusRegion({ text }: { text: string }) {
  return (
    <div role="status" aria-live="polite" className="visually-hidden">
      {text}
    </div>
  );
}

/**
 * The page area while the book is read and its pages set up: its title, "Opening…" and a quiet moving line.
 * Visual only: a persistent StatusRegion says it to screen readers.
 */
export function ReaderOpening({ title }: { title: string }) {
  return (
    <div className="reader-state is-opening" aria-hidden="true">
      <p className="reader-state-title">{title}</p>
      <p className="reader-state-text">Opening…</p>
      <div className="reader-state-line" aria-hidden="true" />
    </div>
  );
}

export interface ReaderOpenFailedProps {
  title: string;
  error: OpenError;
  /** The host's way out (Obsidian: its own PDF viewer), with its button label. */
  openElsewhere?: { label: string; onOpen: () => void };
  /** The host can load the file again (Obsidian: "Try again" in the same leaf). */
  retry?: { label: string; onRetry: () => void };
}

/** The page area when the book couldn't be opened: what went wrong, the raw message behind "Details". */
export function ReaderOpenFailed({ title, error, openElsewhere, retry }: ReaderOpenFailedProps) {
  return (
    <div className="reader-state is-failed" role="alert">
      <p className="reader-state-title">{title}</p>
      <p className="reader-state-text">{error.message}</p>
      {retry && (
        <button type="button" className="reader-state-action" onClick={retry.onRetry}>
          {retry.label}
        </button>
      )}
      {openElsewhere && (
        <button type="button" className="reader-state-action" onClick={openElsewhere.onOpen}>
          {openElsewhere.label}
        </button>
      )}
      <details className="reader-state-details">
        <summary>Details</summary>
        <pre>{error.detail}</pre>
      </details>
    </div>
  );
}
