// Main-thread client of the Bergamot worker (worker.ts). Host-agnostic: the host supplies how to
// create the worker and where the glue, wasm and model bytes come from.
//
//  - Requests run one at a time (the engine is single-threaded anyway), so loading, evicting and
//    translating never interleave, and residency never meets a model pinned by another request
//    (so its ResidencyBusyError cannot happen here).
//  - The worker starts lazily on the first request: `init` (glue text + wasm, transferred), then
//    `load` for each model the request needs (bytes transferred), then `translate`.
//  - Residency (ModelResidency): at most `maxModels` models stay loaded; making room unloads the
//    least recently used one. After `idleMs` with nothing to do the worker is terminated, which is
//    the only way to hand the wasm heap back; the next request restarts it and reloads its models
//    through the `files()` callback each model was registered with.
//  - A crash (worker `onerror`), a reply that cannot be read (`onmessageerror`), a fatal reply (the
//    engine aborted, e.g. out of memory loading a model) or a reply that never comes (`timeoutMs`)
//    terminates the worker and fails what was in flight; the next request starts a fresh one.
//  - `signal` aborts a request: it rejects with an AbortError at once and its late reply is ignored.

import { DEFAULT_IDLE_MS, DEFAULT_MAX_MODELS, ModelResidency } from '../residency';
import { isFromWorker, transferablesOf, type FromWorker, type ModelFile, type ToWorker } from './protocol';

export interface WorkerLike {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessageerror?: ((e: unknown) => void) | null;
}

export interface ClientDeps {
  createWorker: () => WorkerLike;
  glue: () => string;
  /**
   * A fresh buffer on every call: it is transferred to the worker (and detaches here), and it is asked
   * for again whenever the worker restarts. An empty (e.g. already transferred) buffer is refused.
   */
  wasm: () => Promise<ArrayBuffer>;
  /** Longest wait for any one reply before the worker is presumed hung (default 60 s). */
  timeoutMs?: number;
  /** Most models loaded at once (default 2, the minimum for a pivot). */
  maxModels?: number;
  /** Idle time before the worker is terminated (default 5 min; 0 disables). */
  idleMs?: number;
  /**
   * Maps a failure to start the engine (creating the worker, reading the wasm, `init`) to the error the
   * request rejects with, e.g. to say plainly that the engine could not start. Default: unchanged.
   */
  startError?: (e: unknown) => unknown;
}

/**
 * The model's files, as fresh buffers on every call: they are transferred to the worker (and detach on
 * this side), and the callback runs again whenever the model is reloaded (after eviction, idle or a
 * restart). Returning cached buffers fails the second load: an empty buffer is refused.
 */
export type ModelFiles = () => Promise<ModelFile[]>;

export const ENGINE_STOPPED = 'The translation engine stopped';
export const ENGINE_CLOSED = 'The translation engine was shut down';

/** ENGINE_STOPPED, with a worker error event's message (`ENGINE_STOPPED: <message>`) when it carries one. */
export function stoppedBy(e: unknown): string {
  const m = e && typeof e === 'object' ? (e as { message?: unknown }).message : undefined;
  const cause = typeof m === 'string' ? m.trim().slice(0, 300) : '';
  return cause ? `${ENGINE_STOPPED}: ${cause}` : ENGINE_STOPPED;
}
export const DEFAULT_TIMEOUT_MS = 60_000;

export const engineTimeoutMessage = (ms: number): string =>
  `The translation engine did not respond within ${Math.round(ms / 1000)} s`;

const abortError = (): DOMException => new DOMException('The translation was aborted', 'AbortError');

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Registered {
  from: string;
  to: string;
  files: ModelFiles;
}

type ToWorkerBody = ToWorker extends infer M ? (M extends ToWorker ? Omit<M, 'id'> : never) : never;

export class BergamotClient {
  private readonly deps: ClientDeps;
  private readonly timeoutMs: number;
  private readonly residency: ModelResidency;
  private readonly registered = new Map<string, Registered>();
  private readonly pending = new Map<number, Pending>();
  /** Models loaded in the current worker. */
  private readonly loaded = new Set<string>();
  private worker: WorkerLike | null = null;
  private initialised = false;
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(deps: ClientDeps) {
    this.deps = deps;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.residency = new ModelResidency({
      max: deps.maxModels ?? DEFAULT_MAX_MODELS,
      idleMs: deps.idleMs ?? DEFAULT_IDLE_MS,
      unload: (key) => this.unload(key),
      idle: () => this.stopWorker(),
    });
  }

  /**
   * Registers `key`'s model and loads it now (once; concurrent calls share one load). `files` must
   * return fresh buffers on every call (see `ModelFiles`).
   */
  ensureModel(key: string, from: string, to: string, files: ModelFiles): Promise<void> {
    this.registered.set(key, { from, to, files }); // the latest bytes source wins for later reloads
    return this.enqueue(async () => {
      await this.withModels([key], async () => {});
    });
  }

  /** Translates `texts` through one model or two (a pivot); every key must be registered first. */
  translate(legKeys: readonly string[], texts: readonly string[], signal?: AbortSignal): Promise<string[]> {
    const legs = [...legKeys];
    if (legs.length !== 1 && legs.length !== 2) {
      return Promise.reject(new Error(`a translation takes 1 or 2 models, got ${legs.length}`));
    }
    const unknown = legs.find((k) => !this.registered.has(k));
    if (unknown !== undefined) return Promise.reject(new Error(`model ${unknown} was never loaded`));
    const list = [...texts];
    return this.enqueue(
      () =>
        this.withModels(legs, async () => {
          if (list.length === 0) return [];
          const result = await this.call({ type: 'translate', legs, texts: list, html: false });
          if (!Array.isArray(result) || result.length !== list.length || !result.every((s) => typeof s === 'string')) {
            throw new Error('The translation engine sent an unexpected reply');
          }
          return result as string[];
        }),
      signal,
    );
  }

  /** Terminates the worker and fails everything pending or queued; the client is unusable after. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.residency.dispose();
    this.stopWorker(new Error(ENGINE_CLOSED));
  }

  // ---- internals ----

  private enqueue<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.disposed) return Promise.reject(new Error(ENGINE_CLOSED));
    if (signal?.aborted) return Promise.reject(abortError());
    const job = this.queue.then(() => {
      if (this.disposed) throw new Error(ENGINE_CLOSED);
      if (signal?.aborted) throw abortError();
      return run();
    });
    this.queue = job.catch(() => {});
    if (!signal) return job;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      job.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  /** Marks `keys` in use (evicting LRU models), loads the missing ones, runs `body`. */
  private async withModels<T>(keys: string[], body: () => Promise<T>): Promise<T> {
    const use = this.residency.acquire(keys);
    try {
      await this.ensureEngine();
      for (const key of keys) {
        if (this.loaded.has(key)) continue;
        const reg = this.registered.get(key)!;
        try {
          const files = await reg.files();
          const empty = files.find((f) => f.bytes.byteLength === 0);
          if (empty) {
            throw new Error(`${key}: ${empty.name} is empty (model files must be fresh buffers on every call; a transferred one is detached)`);
          }
          await this.call({ type: 'load', key, from: reg.from, to: reg.to, files });
        } catch (e) {
          this.residency.forget(key); // never loaded: it must not hold a slot or look resident
          throw e;
        }
        this.loaded.add(key);
      }
      return await body();
    } finally {
      use.release();
    }
  }

  private async ensureEngine(): Promise<void> {
    if (this.worker && this.initialised) return;
    let worker: WorkerLike | null = null;
    try {
      this.startWorker(); // may throw (e.g. a CSP that forbids the worker): handled like a failed init
      worker = this.worker;
      const wasm = await this.deps.wasm();
      if (wasm.byteLength === 0) throw new Error('The translation engine wasm is empty (it must be a fresh buffer on every call)');
      await this.call({ type: 'init', glue: this.deps.glue(), wasm });
      if (this.worker === worker) this.initialised = true;
    } catch (e) {
      // A worker that failed to start is no use to the next request: drop it (no-op if it crashed).
      // With no worker at all this still resets residency, so the failed keys hold no slot.
      if (this.worker === worker) this.stopWorker(e instanceof Error ? e : new Error(String(e)));
      throw this.deps.startError ? this.deps.startError(e) : e;
    }
  }

  private startWorker(): void {
    if (this.worker) return;
    const worker = this.deps.createWorker();
    this.worker = worker;
    this.initialised = false;
    worker.onmessage = (e) => {
      if (this.worker === worker) this.onReply(e.data);
    };
    // An uncaught error in the worker (its script failing to load or run, a wasm that won't compile)
    // arrives as an ErrorEvent: its message is the cause, said after "stopped" when there is one.
    worker.onerror = (e) => {
      if (this.worker === worker) this.stopWorker(new Error(stoppedBy(e)));
    };
    // A reply that could not be deserialised is lost; its caller would only time out. Treat it as a crash.
    worker.onmessageerror = () => {
      if (this.worker === worker) this.stopWorker(new Error(ENGINE_STOPPED));
    };
  }

  /** Terminates the worker (if any), forgets its models and fails what is in flight with `reason`. */
  private stopWorker(reason: Error = new Error(ENGINE_STOPPED)): void {
    const worker = this.worker;
    this.worker = null;
    this.initialised = false;
    this.loaded.clear();
    this.residency.reset();
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
    const failed = [...this.pending.values()];
    this.pending.clear();
    for (const p of failed) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
  }

  private unload(key: string): void {
    if (!this.loaded.delete(key) || !this.worker) return;
    this.call({ type: 'unload', key }).catch(() => {}); // a failure here surfaces on the next request
  }

  private call(body: ToWorkerBody): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error(ENGINE_CLOSED));
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error(ENGINE_STOPPED));
    const id = this.nextId++;
    const msg = { ...body, id } as ToWorker;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(engineTimeoutMessage(this.timeoutMs)));
        // The worker handles requests in order: one stuck reply means it is hung. Restart it.
        if (this.worker === worker) this.stopWorker(new Error(ENGINE_STOPPED));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage(msg, transferablesOf(msg));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private onReply(data: unknown): void {
    if (!isFromWorker(data)) return;
    const reply: FromWorker = data;
    const p = this.pending.get(reply.id);
    if (!p) return; // timed out or the worker was replaced
    this.pending.delete(reply.id);
    clearTimeout(p.timer);
    if (reply.ok) p.resolve(reply.result);
    else p.reject(new Error(reply.error));
    // The engine aborted: this worker can do nothing more. Drop it now (an idle terminate may never
    // come, since every failing request restarts the idle clock); the next request starts a fresh one.
    if (!reply.ok && reply.fatal) this.stopWorker(new Error(ENGINE_STOPPED));
  }
}
