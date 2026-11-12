// Downloads one pinned catalog file into the translation folder: fetched (streamed when Node's https
// is available), size- and sha256-verified, written as `<dest>.part`, then renamed to `<dest>`.
//
//  - Only files that are in the generated catalog (exact url, size and sha256) on its https host are
//    fetched; anything else is refused before a request is made. Redirects are followed only to
//    https on that same host, at most 3.
//  - The renderer's fetch is blocked by the CDN's CORS policy, so the fetch goes through Node's https
//    (Obsidian desktop exposes `window.require`). Fallback: Obsidian's requestUrl (no progress).
//  - Every failure says why ("The download failed: <reason>", "Checksum mismatch, the file was
//    discarded", or an AbortError) and leaves no `.part` file and no `<dest>` behind.
//  - The vault adapter has no append, so the body is assembled in memory (the largest catalog file
//    is 59.5 MB) and written with one writeBinary.
import { requestUrl, type DataAdapter, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';
import { ENGINE, PAIRS, type CatalogFile } from '../../../src/translate/catalog';

export const PINNED_HOST = 'firefox-settings-attachments.cdn.mozilla.net';
export const MAX_REDIRECTS = 3;
/** No bytes for this long ends the download. */
export const STALL_TIMEOUT_MS = 30_000;
/** requestUrl gives no progress and can't be cancelled; this bounds the whole request. */
export const REQUEST_URL_TIMEOUT_MS = 10 * 60_000;

export const CHECKSUM_MISMATCH = 'Checksum mismatch, the file was discarded';
export const downloadFailed = (reason: string): string => `The download failed: ${reason}`;

export interface Fetcher {
  /**
   * GETs `url`, calling `onChunk` with the body of a 200 response as it arrives (nothing for any
   * other status), and resolves with the final status once the body has ended. Rejects with an
   * AbortError when `signal` aborts, and with an Error saying why on a network failure.
   */
  get(url: string, onChunk: (chunk: Uint8Array) => void, signal?: AbortSignal): Promise<{ status: number }>;
}

export interface DownloadDeps {
  adapter: DataAdapter;
  /** `<configDir>/plugins/margin-reader/translation`; every `dest` must be inside it. */
  root: string;
  fetcher: Fetcher;
  sha256: (b: ArrayBuffer) => Promise<string>;
}

export const abortError = (): DOMException => new DOMException('The download was cancelled', 'AbortError');
export const isAbortError = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';

/** Lowercase hex sha256 of the buffer, without copying it. */
export async function sha256Hex(b: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', b);
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
}

const pinKey = (f: Pick<CatalogFile, 'url' | 'size' | 'sha256'>) => `${f.url}\n${f.size}\n${f.sha256}`;
const PINNED = new Set([ENGINE.file, ...PAIRS.flatMap((p) => p.files)].map(pinKey));

/** True when `url` is https on the pinned host. */
export function onPinnedHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === PINNED_HOST && (u.port === '' || u.port === '443') && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** True when `file` is exactly a catalog file (url, size and sha256) on the pinned host. */
export function isPinned(file: CatalogFile): boolean {
  return onPinnedHost(file.url) && PINNED.has(pinKey(file));
}

function insideRoot(root: string, path: string): boolean {
  return path.startsWith(`${root}/`) && !path.slice(root.length + 1).split('/').some((s) => s === '' || s === '.' || s === '..');
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'));
export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function removeIfThere(adapter: DataAdapter, path: string): Promise<void> {
  try {
    if (await adapter.exists(path)) await adapter.remove(path);
  } catch {
    // best effort: the caller is already failing with the real reason
  }
}

/**
 * Downloads `file` to `dest` (inside `deps.root`), calling `onBytes(n)` for each `n` bytes received.
 * Resolves once `<dest>` holds the verified bytes. Rejects with `The download failed: …`,
 * `Checksum mismatch, the file was discarded` or an AbortError; on any rejection neither
 * `<dest>.part` nor a new `<dest>` is left.
 */
export async function downloadFile(
  deps: DownloadDeps,
  file: CatalogFile,
  dest: string,
  onBytes: (n: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!isPinned(file)) throw new Error(downloadFailed(`${file.name} is not a pinned catalog file`));
  if (!insideRoot(deps.root, dest)) throw new Error(downloadFailed(`${dest} is outside the translation folder`));
  if (signal?.aborted) throw abortError();

  const { adapter } = deps;
  const part = `${dest}.part`;
  // Our own controller: a body larger than the catalog says is cut off without reading the rest.
  const ctl = new AbortController();
  const forward = () => ctl.abort();
  signal?.addEventListener('abort', forward, { once: true });
  let tooBig = false;
  let wrote = false;
  try {
    const body = new Uint8Array(file.size);
    let received = 0;
    let status: number;
    try {
      ({ status } = await deps.fetcher.get(
        file.url,
        (chunk) => {
          if (tooBig || ctl.signal.aborted) return;
          if (received + chunk.byteLength > file.size) {
            tooBig = true;
            ctl.abort();
            return;
          }
          body.set(chunk, received);
          received += chunk.byteLength;
          onBytes(chunk.byteLength);
        },
        ctl.signal,
      ));
    } catch (e) {
      if (signal?.aborted) throw abortError();
      if (tooBig) throw new Error(downloadFailed(`${file.name} is larger than the expected ${file.size} bytes`));
      if (isAbortError(e)) throw abortError();
      throw new Error(downloadFailed(messageOf(e)));
    }
    if (signal?.aborted) throw abortError();
    if (tooBig) throw new Error(downloadFailed(`${file.name} is larger than the expected ${file.size} bytes`));
    if (status !== 200) throw new Error(downloadFailed(`HTTP ${status}`));
    if (received !== file.size) {
      throw new Error(downloadFailed(`${file.name} ended early (${received} of ${file.size} bytes)`));
    }

    try {
      const dir = dirOf(dest);
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
      wrote = true;
      await adapter.writeBinary(part, body.buffer);
    } catch (e) {
      throw new Error(downloadFailed(`could not save ${file.name} (${messageOf(e)})`));
    }
    if ((await deps.sha256(body.buffer)) !== file.sha256) throw new Error(CHECKSUM_MISMATCH);
    if (signal?.aborted) throw abortError();
    try {
      if (await adapter.exists(dest)) await adapter.remove(dest);
      await adapter.rename(part, dest);
    } catch (e) {
      throw new Error(downloadFailed(`could not save ${file.name} (${messageOf(e)})`));
    }
  } catch (e) {
    if (wrote) await removeIfThere(adapter, part);
    throw e;
  } finally {
    signal?.removeEventListener('abort', forward);
  }
}

// ---------------------------------------------------------------------------------------------
// Fetchers

/** The parts of Node's `https` module nodeFetcher uses (tests pass a fake). */
export interface HttpsLike {
  get(url: string, options: Record<string, unknown>, callback: (res: IncomingLike) => void): RequestLike;
}
export interface IncomingLike {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  complete?: boolean;
  on(event: 'data', cb: (chunk: Uint8Array) => void): unknown;
  on(event: 'end', cb: () => void): unknown;
  on(event: 'error' | 'aborted', cb: (e?: unknown) => void): unknown;
  resume(): unknown;
  destroy(e?: unknown): unknown;
}
export interface RequestLike {
  on(event: 'error', cb: (e: unknown) => void): unknown;
  on(event: 'timeout', cb: () => void): unknown;
  setTimeout(ms: number, cb: () => void): unknown;
  destroy(e?: unknown): unknown;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** A short, plain reason for a Node network error. */
export function networkReason(e: unknown, host = PINNED_HOST): string {
  const code = typeof e === 'object' && e !== null ? String((e as { code?: unknown }).code ?? '') : '';
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `you seem to be offline (could not look up ${host})`;
    case 'ECONNREFUSED':
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
    case 'ENETDOWN':
      return `could not connect to ${host}`;
    case 'ECONNRESET':
    case 'EPIPE':
      return 'the connection was interrupted';
    case 'ETIMEDOUT':
      return 'the connection timed out';
    default:
      if (/CERT|SSL|TLS|UNABLE_TO_VERIFY|SELF_SIGNED/.test(code)) return `the certificate of ${host} could not be verified`;
      return messageOf(e) || 'unknown network error';
  }
}

type WindowRequire = (id: string) => unknown;

function loadHttps(): HttpsLike | null {
  try {
    const req = (globalThis as { require?: WindowRequire }).require;
    const https = typeof req === 'function' ? (req('https') as HttpsLike | undefined) : undefined;
    return https && typeof https.get === 'function' ? https : null;
  } catch {
    return null;
  }
}

/**
 * A streaming fetcher over Node's https (Obsidian desktop), or null when it isn't available.
 * Follows at most 3 redirects, only to https on the pinned host; no data for `stallMs` fails.
 */
export function nodeFetcher(https: HttpsLike | null = loadHttps(), opts: { stallMs?: number } = {}): Fetcher | null {
  if (!https) return null;
  const stallMs = opts.stallMs ?? STALL_TIMEOUT_MS;
  return {
    get(url, onChunk, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        let done = false;
        let current: RequestLike | null = null;
        const finish = (fn: () => void) => {
          if (done) return;
          done = true;
          signal?.removeEventListener('abort', onAbort);
          fn();
        };
        const fail = (e: unknown) => finish(() => reject(e));
        function onAbort() {
          const req = current;
          fail(abortError());
          req?.destroy();
        }
        signal?.addEventListener('abort', onAbort, { once: true });

        const attempt = (target: string, hops: number) => {
          if (!onPinnedHost(target)) {
            fail(new Error(`refused a redirect to ${safeHost(target)}, which is not the pinned download host`));
            return;
          }
          let req: RequestLike;
          try {
            // `timeout` arms the socket timeout before it connects too (a stalled connect or TLS
            // handshake), reported through the request's 'timeout' event.
            req = https.get(target, { timeout: stallMs, rejectUnauthorized: true }, (res) => {
              if (done) {
                res.destroy();
                return;
              }
              const status = res.statusCode ?? 0;
              const location = res.headers.location;
              if (REDIRECTS.has(status) && typeof location === 'string' && location) {
                res.resume();
                if (hops >= MAX_REDIRECTS) {
                  fail(new Error(`too many redirects (more than ${MAX_REDIRECTS})`));
                  return;
                }
                let next: string;
                try {
                  next = new URL(location, target).href;
                } catch {
                  fail(new Error('the server sent an unreadable redirect'));
                  return;
                }
                attempt(next, hops + 1);
                return;
              }
              if (status !== 200) {
                res.resume(); // drain and drop the error body
                finish(() => resolve({ status }));
                return;
              }
              res.on('data', (chunk) => {
                if (done) return;
                try {
                  onChunk(chunk);
                } catch (e) {
                  fail(e);
                  req.destroy();
                }
              });
              res.on('end', () => {
                if (res.complete === false) fail(new Error('the connection was interrupted'));
                else finish(() => resolve({ status }));
              });
              res.on('aborted', () => fail(new Error('the connection was interrupted')));
              res.on('error', (e) => fail(new Error(networkReason(e))));
            });
          } catch (e) {
            fail(new Error(networkReason(e)));
            return;
          }
          current = req;
          req.on('error', (e) => fail(new Error(networkReason(e))));
          const stalled = () => {
            if (done) return;
            fail(new Error(`the connection timed out (no data for ${Math.round(stallMs / 1000)} s)`));
            req.destroy();
          };
          req.on('timeout', stalled);
          req.setTimeout(stallMs, stalled);
        };
        attempt(url, 0);
      });
    },
  };
}

function safeHost(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'an unreadable address';
  }
}

type RequestUrlFn = (req: RequestUrlParam) => Promise<RequestUrlResponse>;

/**
 * A fetcher over Obsidian's requestUrl: the whole body arrives as one chunk at the end, and an abort
 * only stops waiting (the request itself can't be cancelled). Redirects are Electron's own; the
 * sha256 check still pins the bytes.
 */
export function requestUrlFetcher(
  request: RequestUrlFn = requestUrl as unknown as RequestUrlFn,
  opts: { timeoutMs?: number } = {},
): Fetcher {
  const timeoutMs = opts.timeoutMs ?? REQUEST_URL_TIMEOUT_MS;
  return {
    get(url, onChunk, signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      if (!onPinnedHost(url)) return Promise.reject(new Error(`refused ${safeHost(url)}, which is not the pinned download host`));
      return new Promise((resolve, reject) => {
        let done = false;
        const settle = (fn: () => void) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          fn();
        };
        const onAbort = () => settle(() => reject(abortError()));
        const timer = setTimeout(
          () => settle(() => reject(new Error(`the server did not answer within ${Math.round(timeoutMs / 1000)} s`))),
          timeoutMs,
        );
        signal?.addEventListener('abort', onAbort, { once: true });
        request({ url, method: 'GET', throw: false }).then(
          (res) =>
            settle(() => {
              try {
                if (res.status === 200) onChunk(new Uint8Array(res.arrayBuffer));
                resolve({ status: res.status });
              } catch (e) {
                reject(e);
              }
            }),
          (e) => settle(() => reject(new Error(networkReason(e)))),
        );
      });
    },
  };
}
