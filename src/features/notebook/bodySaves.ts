import { backend } from '../../lib/backend';
import type { Thought } from '../../lib/types';
import { register } from './editorRegistry';

/**
 * App-lifetime store for thought body saves. It outlives the reader, so a body whose save failed
 * keeps being retried after the user leaves the book (or the editor that typed it unmounts), stays
 * covered by the ⌘Q / close flush, and is handed back to the book's useThoughts when it reopens.
 *
 * Saves are serialized per thought id: at most one call in flight, later requests coalesce into
 * the newest body, so a retry can never send older text than a newer queued or in-flight one.
 */

interface Waiter {
  resolve: (t: Thought) => void;
  reject: (e: unknown) => void;
}
/** One body save to send: the latest requested body, plus everyone waiting for it or an older one. */
interface BodyJob {
  body: string;
  epoch: number;
  waiters: Waiter[];
}
/** Per-id body save queue: at most one call in flight; later requests coalesce into `next`. */
interface BodyQueue {
  current: BodyJob | null;
  next: BodyJob | null;
}

/** A failed body save is retried after 2 s, then 4 s, 8 s … at most 30 s apart, until it lands. */
export const RETRY_BASE_MS = 2000;
export const RETRY_MAX_MS = 30000;

const isNotFound = (e: unknown) => String(e).startsWith('not found');

const queues = new Map<string, BodyQueue>();
/** The newest body requested per id, kept while it is queued, in flight or failed. */
const latestBody = new Map<string, string>();
/** Ids whose latest body save failed (value: that save's epoch). Their text is not in the DB. */
const failed = new Map<string, number>();
/** Per-id count of body saves started (never reset, so it stays monotonic across reader mounts). */
const epochs = new Map<string, number>();
/** Per-id epoch of the newest body save the backend confirmed. */
const savedEpochs = new Map<string, number>();

const savedListeners = new Set<(t: Thought) => void>();
const changeListeners = new Set<() => void>();
const notifyChange = () => changeListeners.forEach((l) => l());

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = RETRY_BASE_MS;
/** Set by stopRetries() (the Obsidian plugin unloading); the desktop app never sets it. */
let stopped = false;

function scheduleRetry() {
  if (stopped || retryTimer || failed.size === 0) return;
  const delay = retryDelay;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryDelay = Math.min(delay * 2, RETRY_MAX_MS);
    void retryFailed();
  }, delay);
}

/** Every failed body has landed: drop the pending retry and start the backoff over. */
function retriesDone() {
  if (failed.size > 0) return;
  retryDelay = RETRY_BASE_MS;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

/** The text in the DB is current for `id` (nothing queued, in flight or failed): forget the copy. */
function settle(id: string) {
  if (!queues.has(id) && !failed.has(id)) latestBody.delete(id);
}

function setFailed(id: string, epoch: number | null) {
  const had = failed.size;
  if (epoch === null) failed.delete(id);
  else failed.set(id, epoch);
  if (failed.size !== had) notifyChange();
}

/** Sends the queued body for `id` if nothing is in flight; repeats until the queue is empty. */
function pump(id: string) {
  const q = queues.get(id);
  if (!q || q.current || !q.next) return;
  const job = q.next;
  q.next = null;
  q.current = job;
  backend().updateThought(id, { body: job.body }).then(
    (t) => {
      savedEpochs.set(id, Math.max(savedEpochs.get(id) ?? 0, job.epoch));
      // A newer save that failed still owns the mark.
      if ((failed.get(id) ?? 0) <= job.epoch) setFailed(id, null);
      retriesDone();
      q.current = null;
      if (!q.next) queues.delete(id);
      settle(id);
      savedListeners.forEach((l) => l(t));
      job.waiters.forEach((w) => w.resolve(t));
      if (q.next) pump(id);
    },
    (e) => {
      q.current = null;
      if (q.next) {
        // A newer body is queued: it carries this one's text too, so its outcome decides.
        q.next.waiters.push(...job.waiters);
        pump(id);
        return;
      }
      queues.delete(id);
      // NotFound: the thought is gone, there is nothing to retry. Otherwise, unless a newer body
      // already reached the DB, the store's copy is now the only one.
      if (!isNotFound(e) && (savedEpochs.get(id) ?? 0) < job.epoch) {
        setFailed(id, Math.max(failed.get(id) ?? 0, job.epoch));
        scheduleRetry();
      }
      settle(id);
      job.waiters.forEach((w) => w.reject(e));
    },
  );
}

/** Queues a body save. Resolves once this body or a newer one is persisted. */
export function saveBody(id: string, body: string): Promise<Thought> {
  latestBody.set(id, body);
  const epoch = (epochs.get(id) ?? 0) + 1;
  epochs.set(id, epoch);
  return new Promise<Thought>((resolve, reject) => {
    const waiter = { resolve, reject };
    let q = queues.get(id);
    if (!q) {
      q = { current: null, next: null };
      queues.set(id, q);
    }
    if (q.next) {
      q.next.body = body;
      q.next.epoch = epoch;
      q.next.waiters.push(waiter);
    } else if (q.current && q.current.body === body) {
      q.current.waiters.push(waiter); // already on its way
    } else {
      q.next = { body, epoch, waiters: [waiter] };
    }
    pump(id);
  });
}

/** Re-sends every failed body (newest requested text) through the queue. */
export function retryFailed() {
  return Promise.allSettled(
    [...failed.keys()].flatMap((id) => {
      const body = latestBody.get(id);
      return body === undefined ? [] : [saveBody(id, body)];
    }),
  );
}

/** Text that is not in the DB yet (queued, in flight or failed); it wins over a DB read. */
export function unsavedBody(id: string): string | undefined {
  return latestBody.get(id);
}

/** True while the body for `id` is queued, in flight or failed. */
export function hasUnsaved(id: string): boolean {
  return queues.has(id) || failed.has(id);
}

/** Per-id save counters, to tell whether a save started after a list was requested. */
export function snapshotEpochs(): ReadonlyMap<string, number> {
  return new Map(epochs);
}
export function epochOf(id: string): number {
  return epochs.get(id) ?? 0;
}

/** The thought was deleted: nothing of it is left to save. */
export function forget(id: string) {
  setFailed(id, null);
  latestBody.delete(id);
  retriesDone();
}

/** Called with every confirmed body save, including retries no reader asked for. */
export function onSaved(listener: (t: Thought) => void): () => void {
  savedListeners.add(listener);
  return () => {
    savedListeners.delete(listener);
  };
}

/** For useSyncExternalStore: how many thoughts have text that failed to save. */
export function failedCount(): number {
  return failed.size;
}
export function subscribe(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/**
 * The host is going away (the Obsidian plugin unloads): no more timed retries, for good. Failed
 * bodies stay failed (failedCount still reports them); a later failure schedules nothing. Only an
 * explicit retryFailed() / flush still sends. The desktop app never calls this.
 */
export function stopRetries() {
  stopped = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = RETRY_BASE_MS;
}

/** True once stopRetries() has run (never in the desktop app). */
export function retriesStopped(): boolean {
  return stopped;
}

/**
 * ⌘Q / close / leaving the reader: retry every failed body. It waits a microtask first, so live
 * editors (which register later and send synchronously) hand over their newer text before the
 * retry reads `latestBody` — the retry then joins that save instead of sending older text first.
 */
const flushFailed = async () => {
  await Promise.resolve();
  return retryFailed();
};
register(flushFailed);

/** Tests only: forget everything (module state outlives a test's render). */
export function resetBodySavesForTests() {
  queues.clear();
  latestBody.clear();
  failed.clear();
  epochs.clear();
  savedEpochs.clear();
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = RETRY_BASE_MS;
  stopped = false;
  savedListeners.clear();
  changeListeners.clear();
}
