// Runs inside the translation Worker (bundled to an IIFE string and started from a blob: URL).
// It follows Firefox's translations-engine.worker.js: the vendored Emscripten glue arrives as text
// and runs via importScripts(blob:), the wasm and model bytes arrive as transferred ArrayBuffers,
// models live in AlignedMemory, and one BlockingService translates (directly or via a pivot).
// Requests are handled strictly one after another, so replies come back in request order.
// Once the engine aborts after startup (onAbort, or a WebAssembly.RuntimeError such as an OOM while
// loading a model) it is unusable: that reply and every later one carry `fatal: true`, and the client
// replaces the worker.
// Imports: protocol types only (this file must bundle to a self-contained script).

import type { FromWorker, ModelFile, ToWorker } from './protocol';

/** The part of a dedicated worker's global scope used here (the DOM lib has no worker types). */
export interface WorkerScope {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(message: FromWorker): void;
  importScripts(...urls: string[]): void;
  loadBergamot?: (module: Record<string, unknown>) => unknown;
}

// Embind handles: every object created here is freed with .delete().
interface Deletable {
  delete(): void;
}
interface AlignedMemory extends Deletable {
  getByteArrayView(): Uint8Array;
}
interface Vector<T> extends Deletable {
  push_back(v: T): void;
  size(): number;
  get(i: number): unknown;
}
interface Response extends Deletable {
  getTranslatedText(): string;
}
type Model = Deletable;
interface Service extends Deletable {
  translate(model: Model, texts: Vector<string>, options: Vector<object>): Vector<Response>;
  translateViaPivoting(first: Model, second: Model, texts: Vector<string>, options: Vector<object>): Vector<Response>;
}
export interface BergamotModule {
  AlignedMemory: new (size: number, alignment: number) => AlignedMemory;
  AlignedMemoryList: new () => Vector<AlignedMemory>;
  VectorString: new () => Vector<string>;
  VectorResponseOptions: new () => Vector<object>;
  TranslationModel: new (
    from: string,
    to: string,
    config: string,
    model: AlignedMemory,
    lex: AlignedMemory | null,
    vocabs: Vector<AlignedMemory>,
    qualityModel: null,
  ) => Model;
  BlockingService: new (opts: { cacheSize: number }) => Service;
}

export const INITIAL_MEMORY = 40 * 1024 * 1024;
const ALIGNMENT: Record<string, number> = { model: 256 };
const DEFAULT_ALIGNMENT = 64;

/** Firefox's model config (translations-engine.worker.js), as the YAML text the engine parses. */
export function modelConfig(modelFileName: string): string {
  const config: [string, string][] = [
    ['beam-size', '1'],
    ['normalize', '1.0'],
    ['word-penalty', '0'],
    ['max-length-break', '128'],
    ['mini-batch-words', '1024'],
    ['workspace', '128'],
    ['max-length-factor', '2.0'],
    ['skip-cost', 'true'],
    ['cpu-threads', '0'],
    ['quiet', 'true'],
    ['quiet-translation', 'true'],
    ['gemm-precision', modelFileName.includes('intgemm8') ? 'int8shiftAll' : 'int8shiftAlphaAll'],
    ['alignment', 'soft'],
  ];
  return `\n${config.map(([k, v]) => `${k}: ${v}\n`).join('')}`;
}

interface Loaded {
  model: Model;
  /** Freed after the model (the model may own their contents). */
  handles: Deletable[];
}

export function startWorker(scope: WorkerScope): void {
  let engine: BergamotModule | null = null;
  let service: Service | null = null;
  const models = new Map<string, Loaded>();
  let queue: Promise<void> = Promise.resolve();
  /** Set once the running engine has aborted: the message every later request fails with. */
  let fatal: string | null = null;

  const ready = (): BergamotModule => {
    if (!engine) throw new Error('the engine is not initialised');
    return engine;
  };

  async function init(glue: string, wasm: ArrayBuffer): Promise<void> {
    if (engine) return;
    const url = URL.createObjectURL(new Blob([glue], { type: 'text/javascript' }));
    try {
      scope.importScripts(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const load = scope.loadBergamot;
    if (typeof load !== 'function') throw new Error('the engine glue did not define loadBergamot');
    const module = await new Promise<BergamotModule>((resolve, reject) => {
      const m: Record<string, unknown> = {
        wasmBinary: wasm,
        INITIAL_MEMORY,
        print: () => {},
        printErr: () => {},
        onAbort: (why: unknown) => {
          const message = `the engine aborted: ${String(why)}`;
          // Before startup this fails init (the client drops a worker whose init failed); after it,
          // the engine is broken for good.
          if (engine) fatal ??= message;
          reject(new Error(message));
        },
        onRuntimeInitialized: () => resolve(m as unknown as BergamotModule),
      };
      load(m);
    });
    // The module object lives as long as the engine: don't let it pin the (multi-MB) wasm bytes too.
    delete (module as unknown as Record<string, unknown>).wasmBinary;
    service = new module.BlockingService({ cacheSize: 0 });
    engine = module;
  }

  function loadModel(key: string, from: string, to: string, files: ModelFile[]): void {
    const m = ready();
    if (models.has(key)) return;
    const handles: Deletable[] = [];
    try {
      const mem = new Map<string, AlignedMemory>();
      for (const f of files) {
        const aligned = new m.AlignedMemory(f.bytes.byteLength, ALIGNMENT[f.type] ?? DEFAULT_ALIGNMENT);
        handles.push(aligned);
        aligned.getByteArrayView().set(new Uint8Array(f.bytes));
        mem.set(f.type, aligned);
      }
      const modelFile = files.find((f) => f.type === 'model');
      const model = mem.get('model');
      if (!modelFile || !model) throw new Error(`${key}: no model file`);
      const vocabs = new m.AlignedMemoryList();
      handles.push(vocabs);
      const vocabTypes = mem.has('vocab') ? ['vocab'] : ['srcvocab', 'trgvocab'];
      for (const t of vocabTypes) {
        const v = mem.get(t);
        if (!v) throw new Error(`${key}: no ${t} file`);
        vocabs.push_back(v);
      }
      const built = new m.TranslationModel(from, to, modelConfig(modelFile.name), model, mem.get('lex') ?? null, vocabs, null);
      models.set(key, { model: built, handles });
    } catch (e) {
      for (const h of handles) h.delete();
      throw e;
    }
  }

  function unload(key: string): void {
    const loaded = models.get(key);
    if (!loaded) return;
    models.delete(key);
    loaded.model.delete();
    for (const h of loaded.handles) h.delete();
  }

  function translate(legs: string[], texts: string[]): string[] {
    const m = ready();
    if (!service) throw new Error('the engine is not initialised');
    if (legs.length !== 1 && legs.length !== 2) throw new Error(`a translation takes 1 or 2 models, got ${legs.length}`);
    const chosen = legs.map((k) => {
      const loaded = models.get(k);
      if (!loaded) throw new Error(`model ${k} is not loaded`);
      return loaded.model;
    });
    const messages = new m.VectorString();
    const options = new m.VectorResponseOptions();
    let responses: Vector<Response> | null = null;
    try {
      for (const t of texts) {
        messages.push_back(t);
        options.push_back({ qualityScores: false, alignment: true, html: false });
      }
      responses =
        chosen.length === 1
          ? service.translate(chosen[0], messages, options)
          : service.translateViaPivoting(chosen[0], chosen[1], messages, options);
      const out: string[] = [];
      for (let i = 0; i < responses.size(); i++) {
        const r = responses.get(i) as Response;
        try {
          out.push(r.getTranslatedText());
        } finally {
          r.delete();
        }
      }
      return out;
    } finally {
      messages.delete();
      options.delete();
      responses?.delete();
    }
  }

  async function run(msg: ToWorker): Promise<unknown> {
    switch (msg.type) {
      case 'init':
        return init(msg.glue, msg.wasm);
      case 'load':
        return loadModel(msg.key, msg.from, msg.to, msg.files);
      case 'translate':
        return translate(msg.legs, msg.texts);
      case 'unload':
        return unload(msg.key);
      default:
        throw new Error(`unknown request ${(msg as { type?: unknown }).type as string}`);
    }
  }

  async function handle(data: unknown): Promise<void> {
    const msg = data as ToWorker;
    const id = typeof msg?.id === 'number' ? msg.id : -1;
    if (fatal !== null) {
      scope.postMessage({ id, ok: false, error: fatal, fatal: true });
      return;
    }
    try {
      const result = await run(msg);
      scope.postMessage(result === undefined ? { id, ok: true } : { id, ok: true, result });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (e instanceof WebAssembly.RuntimeError) fatal ??= error;
      scope.postMessage(fatal === null ? { id, ok: false, error } : { id, ok: false, error, fatal: true });
    }
  }

  scope.onmessage = (e) => {
    // A reply that cannot be posted must not stall every later request behind a rejected chain.
    queue = queue.then(() => handle(e.data)).catch(() => {});
  };
}

// In a real worker (importScripts exists and there is no `window`), start listening.
const g = globalThis as unknown as Partial<WorkerScope> & { window?: unknown };
if (typeof g.importScripts === 'function' && typeof g.window === 'undefined') startWorker(g as WorkerScope);
