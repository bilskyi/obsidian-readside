// Which translation models the engine keeps loaded. Each loaded pair costs wasm heap (T1 measured
// ~40 MiB at start and ~300 MiB with two models), and a WebAssembly.Memory never shrinks, so:
//  - at most `max` models are kept; loading another first unloads the least recently used one
//    (`unload(key)`), letting the engine reuse that heap instead of growing further. A model some
//    request has acquired and not yet released is pinned: it is never the one unloaded, and when
//    every resident model is pinned there is no room (`ResidencyBusyError`; retry after a release);
//  - after `idleMs` with no request in flight, `idle()` is called and every model is forgotten.
//    The host should terminate the worker there: that is the only way to hand the heap back.
// Keys are pair keys ('uk-en'). Pure bookkeeping: the engine client (T3) does the actual work.

import { Lru } from './lru';

export interface ResidencyOptions {
  /** Most models kept loaded at once; at least 2 so a pivot (two legs) fits. */
  max: number;
  /** Idle time before `idle()`; 0 or Infinity disables it. */
  idleMs: number;
  /** A model left the set to make room: free it in the engine. */
  unload: (key: string) => void;
  /** Nothing used for idleMs: release the whole engine (terminate the worker). */
  idle: () => void;
}

export interface Acquired {
  /** Keys not yet loaded: the caller loads these before translating. */
  load: string[];
  /** Keys unloaded to make room (already passed to `unload`). */
  evicted: string[];
  /** Ends this use; idempotent. The idle clock starts when nothing is in flight. */
  release(): void;
}

/** Thrown by `acquire` when making room would unload a model another request is still using. */
export class ResidencyBusyError extends Error {
  constructor(needed: number, max: number) {
    super(`no room for ${needed} more model(s): all ${max} loaded models are in use`);
    this.name = 'ResidencyBusyError';
  }
}

export const DEFAULT_MAX_MODELS = 2;
export const DEFAULT_IDLE_MS = 5 * 60_000;

export class ModelResidency {
  private readonly lru: Lru<string, true>;
  private readonly opts: ResidencyOptions;
  private inFlight = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private evicting: string[] | null = null;
  /** Acquired-and-not-released count per key; a key above 0 is never evicted. */
  private readonly pins = new Map<string, number>();
  private disposed = false;

  constructor(opts: ResidencyOptions) {
    this.opts = opts;
    this.lru = new Lru<string, true>(opts.max, {
      onEvict: (key) => {
        if (this.evicting) {
          this.evicting.push(key);
          this.opts.unload(key);
        }
      },
    });
  }

  /** Marks `keys` (one request's legs) as in use, unloading LRU models to make room. */
  acquire(keys: readonly string[]): Acquired {
    if (this.disposed) throw new Error('model residency is disposed');
    const unique = [...new Set(keys)];
    if (unique.length > this.opts.max) {
      throw new Error(`a request needs ${unique.length} models but at most ${this.opts.max} may be loaded`);
    }
    this.clearTimer();
    // Refresh the resident ones first, so adding the missing ones never evicts a leg of this request.
    for (const k of unique) if (this.lru.has(k)) this.lru.get(k);
    const load = unique.filter((k) => !this.lru.has(k));
    // Room comes only from models nobody holds (this request's own resident legs are excluded too).
    const evictable = this.lru.keys().filter((k) => !this.pinned(k) && !unique.includes(k));
    const excess = this.lru.size + load.length - this.opts.max;
    if (excess > evictable.length) throw new ResidencyBusyError(load.length, this.opts.max);
    const evicted: string[] = [];
    this.evicting = evicted;
    try {
      for (const k of evictable.slice(0, Math.max(0, excess))) this.lru.delete(k);
      for (const k of load) this.lru.set(k, true);
    } finally {
      this.evicting = null;
    }
    for (const k of unique) this.pins.set(k, (this.pins.get(k) ?? 0) + 1);
    this.inFlight++;
    let released = false;
    return {
      load,
      evicted,
      release: () => {
        if (released) return;
        released = true;
        for (const k of unique) {
          const n = (this.pins.get(k) ?? 0) - 1;
          if (n > 0) this.pins.set(k, n);
          else this.pins.delete(k);
        }
        this.inFlight--;
        if (this.inFlight === 0) this.startTimer();
      },
    };
  }

  /** Drops `key` without calling unload: its load failed, so the engine never had it. */
  forget(key: string): void {
    this.lru.delete(key); // evicting is null: onEvict does nothing
  }

  private pinned(key: string): boolean {
    return (this.pins.get(key) ?? 0) > 0;
  }

  /** Loaded keys, least recently used first. */
  resident(): string[] {
    return this.lru.keys();
  }

  /** Forget every model without calling unload/idle (e.g. the worker crashed and restarts empty). */
  reset(): void {
    this.lru.clear(); // evicting is null: onEvict does nothing
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.reset();
  }

  private startTimer(): void {
    this.clearTimer();
    if (this.disposed) return;
    const ms = this.opts.idleMs;
    if (!(ms > 0) || !Number.isFinite(ms)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.inFlight > 0) return; // dispose() cleared this timer; startTimer refuses after it
      this.reset();
      this.opts.idle();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
