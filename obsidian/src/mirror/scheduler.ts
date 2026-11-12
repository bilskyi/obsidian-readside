export const MIRROR_DELAY_MS = 1500;

/** Debounces notebook-note writes per book; runs for one book never overlap. */
export class MirrorScheduler {
  private readonly run: (bookId: string) => Promise<void>;
  private readonly delayMs: number;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Map<string, Promise<void>>();

  constructor(run: (bookId: string) => Promise<void>, delayMs = MIRROR_DELAY_MS) {
    this.run = run;
    this.delayMs = delayMs;
  }

  /** A change to the book: write its note `delayMs` after the last one. */
  touch(bookId: string): void {
    const t = this.timers.get(bookId);
    if (t) clearTimeout(t);
    this.timers.set(
      bookId,
      setTimeout(() => void this.flush(bookId), this.delayMs),
    );
  }

  /** A change to the book is waiting for its note, or the note is being written. */
  isPending(bookId: string): boolean {
    return this.timers.has(bookId) || this.running.has(bookId);
  }

  /** Writes the book's note now (view close), whether or not a change is pending. */
  flush(bookId: string): Promise<void> {
    const t = this.timers.get(bookId);
    if (t) clearTimeout(t);
    this.timers.delete(bookId);
    const next = (this.running.get(bookId) ?? Promise.resolve())
      .then(() => this.run(bookId))
      .catch((e) => console.error(`margin: could not write the notebook note for ${bookId}`, e));
    this.running.set(bookId, next);
    void next.then(() => {
      if (this.running.get(bookId) === next) this.running.delete(bookId);
    });
    return next;
  }

  /** Writes every pending note now and waits for writes in flight (plugin unload). */
  async flushAll(): Promise<void> {
    const pending = [...this.timers.keys()];
    await Promise.all([...pending.map((id) => this.flush(id)), ...this.running.values()]);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
