import { createContext } from 'react';

/** A new thought's editor says how to finish (Esc removes an empty one, keeps one with text). */
export const NEW_THOUGHT_PLACEHOLDER = 'Write a thought — Esc when done';

/**
 * What the reader tells every thought editor (margin notes, cards, the notebook) about the thoughts made
 * in this session. Its answers are read through refs; the object changes only when a thought starts or
 * stops being removed (so its editors turn read-only, then back).
 */
export interface ThoughtSession {
  /** Created in this session and nothing written in it yet: its editor shows NEW_THOUGHT_PLACEHOLDER. */
  isNew(id: string): boolean;
  /** An empty new thought whose delete is on its way: its editors are read-only meanwhile. */
  isRemoving(id: string): boolean;
  /** Text was typed into the thought: it is no longer an empty new thought, for good. */
  wrote(id: string): void;
  /**
   * Done writing (Esc, ⌘Enter): the editor lets go and the page takes the keyboard. With `from`, focus goes
   * to `returnTo` instead (the notebook entry's name), unless that thought is an empty new one about to go.
   */
  finish(from?: { id: string; returnTo: HTMLElement | null | undefined }): void;
}

/** Without a reader (a surface rendered on its own): nothing is new, and finishing just lets go of focus. */
export const ThoughtSessionContext = createContext<ThoughtSession>({
  isNew: () => false,
  isRemoving: () => false,
  wrote: () => {},
  finish: (from) => {
    if (from?.returnTo?.isConnected) {
      from.returnTo.focus({ preventScroll: true });
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  },
});
