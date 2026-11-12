/**
 * Flush functions of everything holding unsaved thought text: each live ThoughtEditor, plus
 * useThoughts for saves that failed. Quit, window close and page hide call `flushAll` so text
 * typed in the last 500 ms (or a save that failed) still reaches the database.
 */
export type Flusher = () => Promise<unknown> | void;

const flushers = new Set<Flusher>();

/** Adds a flusher; the returned function removes it. */
export function register(flush: Flusher): () => void {
  flushers.add(flush);
  return () => {
    flushers.delete(flush);
  };
}

/** Runs every flusher at once and resolves when all have settled. Never rejects. */
export async function flushAll(): Promise<void> {
  await Promise.allSettled(
    [...flushers].map((f) => {
      try {
        return Promise.resolve(f());
      } catch (e) {
        return Promise.reject(e);
      }
    }),
  );
}

/** A save that hangs must not trap the user; quit, close and leaving the reader share this budget. */
export const FLUSH_TIMEOUT_MS = 1500;

/** flushAll, but resolves after FLUSH_TIMEOUT_MS at the latest. */
export function flushAllBounded(): Promise<void> {
  return Promise.race([flushAll(), new Promise<void>((r) => setTimeout(r, FLUSH_TIMEOUT_MS))]);
}
