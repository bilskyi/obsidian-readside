// Puts the plugin's translation together: one BergamotClient (owned by the host, never shared) and
// one ObsidianTranslateHost, built lazily by main.ts.
//
//  - The worker starts on the first translation, never at load. It runs from a blob: URL. Obsidian's
//    only CSP is a meta `style-src` (no script-src, worker-src or default-src, no header CSP; checked
//    statically), so blob: workers and wasm compile are allowed and nothing else is tried.
//  - Any failure to start the engine (no worker, no wasm compile, a crash during init) reaches the
//    card as "Margin couldn't start the translation engine: <cause>; update Obsidian or report this",
//    never as a hang.
//  - Downloads go through Node's https (streamed, cancellable); without it, through requestUrl.
import { BergamotClient, ENGINE_CLOSED, type WorkerLike } from '../../../src/translate/bergamot/BergamotClient';
import { isAbortError, messageOf, nodeFetcher, requestUrlFetcher, type Fetcher } from './downloads';
import { ObsidianTranslateHost, readEngineWasm, type HostDeps } from './service';
import { GLUE_JS, createBergamotWorker } from './workerAssets';

export const ENGINE_START_FAILED = "Margin couldn't start the translation engine";
/** What to do about it, after the cause. */
export const ENGINE_START_HINT = 'update Obsidian or report this';
export const REQUEST_URL_WARNING =
  "margin: Node's https module is unavailable; translation downloads use requestUrl (no progress, and a cancel only stops waiting)";

/** The error a request gets when the engine could not start. A shutdown or an abort is left as it is. */
export function engineStartError(e: unknown): unknown {
  if (isAbortError(e) || messageOf(e) === ENGINE_CLOSED) return e;
  return new Error(`${ENGINE_START_FAILED}: ${messageOf(e)}; ${ENGINE_START_HINT}`);
}

export interface TranslationDeps extends Omit<HostDeps, 'client' | 'fetcher'> {
  /** Tests inject these; the defaults are the real ones. */
  fetcher?: Fetcher;
  createWorker?: () => WorkerLike;
  warn?: (message: string) => void;
}

/** The plugin's translate host, with its own client. Starts nothing: no worker, no request. */
export function createTranslation(d: TranslationDeps): ObsidianTranslateHost {
  const { fetcher: injected, createWorker, warn, ...host } = d;
  let fetcher = injected ?? nodeFetcher();
  if (!fetcher) {
    (warn ?? console.warn)(REQUEST_URL_WARNING);
    fetcher = requestUrlFetcher();
  }
  const client = new BergamotClient({
    createWorker: createWorker ?? createBergamotWorker,
    glue: () => GLUE_JS,
    wasm: () => readEngineWasm(d.adapter, d.root, d.sha256),
    startError: engineStartError,
  });
  return new ObsidianTranslateHost({ ...host, fetcher, client });
}
