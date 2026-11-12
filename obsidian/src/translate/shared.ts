// One running job per key, shared by everyone who asks for it while it runs.
//
//  - `join(key, start, { signal, onProgress })` starts the job, or joins the one already running for
//    `key`. A joiner gets the latest progress at once, then every update.
//  - A joiner's own abort rejects only that joiner (AbortError). The job itself is cancelled when the
//    last joiner leaves, and a later join starts a fresh job only after the cancelled one has
//    finished cleaning up (so two jobs never write the same files at once).
//  - A job that fails is forgotten before its joiners hear about it, so a retry starts afresh.

export interface JoinOptions<P> {
  signal?: AbortSignal;
  onProgress?: (p: P) => void;
}

type Start<T, P> = (signal: AbortSignal, emit: (p: P) => void) => Promise<T>;

interface Run<T, P> {
  ctl: AbortController;
  promise: Promise<T>;
  subs: Set<JoinOptions<P>>;
  last: P | undefined;
}

const abortError = (): DOMException => new DOMException('The download was cancelled', 'AbortError');

export class SharedJobs<T, P> {
  private readonly running = new Map<string, Run<T, P>>();
  /** The last job per key, settled or not, so a new one can wait for it to finish. */
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Whether a job for `key` is running and still has joiners. */
  has(key: string): boolean {
    return this.running.has(key);
  }

  keys(): string[] {
    return [...this.running.keys()];
  }

  join(key: string, start: Start<T, P>, opts: JoinOptions<P> = {}): Promise<T> {
    if (opts.signal?.aborted) return Promise.reject(abortError());
    let run = this.running.get(key);
    if (!run) run = this.begin(key, start);
    const job = run;
    const sub: JoinOptions<P> = { onProgress: opts.onProgress };
    job.subs.add(sub);
    if (job.last !== undefined) sub.onProgress?.(job.last);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const leave = () => {
        settled = true;
        job.subs.delete(sub);
        opts.signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (settled) return;
        leave();
        reject(abortError());
        if (job.subs.size === 0) {
          // Nobody is waiting any more: cancel, and let the next join start a fresh job.
          if (this.running.get(key) === job) this.running.delete(key);
          job.ctl.abort();
        }
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      job.promise.then(
        (v) => {
          if (settled) return;
          leave();
          resolve(v);
        },
        (e) => {
          if (settled) return;
          leave();
          reject(e);
        },
      );
    });
  }

  /** Cancels every job (their joiners reject with an AbortError). */
  abortAll(): void {
    for (const [key, run] of [...this.running]) {
      this.running.delete(key);
      run.ctl.abort();
    }
  }

  private begin(key: string, start: Start<T, P>): Run<T, P> {
    const ctl = new AbortController();
    const before = this.tails.get(key) ?? Promise.resolve();
    const run: Run<T, P> = { ctl, promise: null as unknown as Promise<T>, subs: new Set(), last: undefined };
    const emit = (p: P) => {
      if (ctl.signal.aborted) return;
      run.last = p;
      for (const s of [...run.subs]) s.onProgress?.(p);
    };
    run.promise = before
      .catch(() => {})
      .then(() => {
        if (ctl.signal.aborted) throw abortError();
        return start(ctl.signal, emit);
      })
      .catch((e) => {
        throw ctl.signal.aborted ? abortError() : e;
      })
      .finally(() => {
        if (this.running.get(key) === run) this.running.delete(key);
      });
    const tail = run.promise.catch(() => {});
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    this.running.set(key, run);
    return run;
  }
}
