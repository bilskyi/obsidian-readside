// Messages between BergamotClient (main thread) and the Bergamot worker (worker.ts).
// Every request carries an `id`; the worker answers each with exactly one FromWorker of that id,
// in the order the requests arrived (it handles them one at a time).
// The worker file imports only types from here, so this module must stay free of runtime imports.

export interface ModelFile {
  /** Catalog file type: 'model' | 'lex' | 'vocab' | 'srcvocab' | 'trgvocab'. */
  type: string;
  name: string;
  bytes: ArrayBuffer;
}

export type ToWorker =
  /** Start the engine: evaluate the glue, instantiate the wasm. */
  | { id: number; type: 'init'; glue: string; wasm: ArrayBuffer }
  /** Build the TranslationModel for `key` ('uk-en'). */
  | { id: number; type: 'load'; key: string; from: string; to: string; files: ModelFile[] }
  /** Translate through one model, or two (pivot through English). Result: string[] (one per text). */
  | { id: number; type: 'translate'; legs: string[]; texts: string[]; html: false }
  /** Free the model for `key` (a no-op when it isn't loaded). */
  | { id: number; type: 'unload'; key: string };

/**
 * `fatal`: the engine aborted (Emscripten `onAbort`, or a `WebAssembly.RuntimeError` such as running
 * out of memory). The worker is unusable from then on: the client terminates it, and the next request
 * starts a fresh one.
 */
export type FromWorker =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string; fatal?: true };

/**
 * The buffers a message hands over to the other side (zero-copy; the sender's copies detach). Each
 * buffer is listed once: a transfer list naming one twice makes postMessage throw a DataCloneError.
 */
export function transferablesOf(msg: ToWorker): ArrayBuffer[] {
  switch (msg.type) {
    case 'init':
      return [msg.wasm];
    case 'load':
      return [...new Set(msg.files.map((f) => f.bytes))];
    default:
      return [];
  }
}

export function isFromWorker(x: unknown): x is FromWorker {
  if (typeof x !== 'object' || x === null) return false;
  const m = x as Record<string, unknown>;
  if (typeof m.id !== 'number') return false;
  return m.ok === true || (m.ok === false && typeof m.error === 'string' && (m.fatal === undefined || m.fatal === true));
}
