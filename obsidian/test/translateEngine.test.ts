import { describe, expect, it, vi } from 'vitest';
import { ENGINE } from '../../src/translate/catalog';
import { ENGINE_CLOSED, ENGINE_STOPPED, type WorkerLike } from '../../src/translate/bergamot/BergamotClient';
import {
  ENGINE_START_FAILED,
  ENGINE_START_HINT,
  REQUEST_URL_WARNING,
  createTranslation,
  engineStartError,
} from '../src/translate/engine';
import { GLUE_JS } from '../src/translate/workerAssets';
import { FakeFetcher, TROOT, TestAdapter, fakeSha256, installOnDisk, pause } from './translateFakes';

const UK = 'Це книжка про історію України, її мову та культуру за останні сто років.';

/** A worker that records what it is sent and answers when told to. */
class RecWorker implements WorkerLike {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessageerror: ((e: unknown) => void) | null = null;
  sent: { m: { id: number; type: string } & Record<string, unknown>; t?: Transferable[] }[] = [];
  terminated = false;
  /** Answers every message at once (translate: `[out] <text>`). */
  auto = false;
  /** Fails `init` with this. */
  initError: string | null = null;
  postMessage(m: unknown, t?: Transferable[]): void {
    const msg = m as { id: number; type: string; texts?: string[] } & Record<string, unknown>;
    this.sent.push({ m: msg, t });
    if (msg.type === 'init' && this.initError) {
      const error = this.initError;
      queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, ok: false, error } }));
    } else if (this.auto) {
      const result = msg.type === 'translate' ? (msg.texts ?? []).map((x) => `[out] ${x}`) : undefined;
      queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, ok: true, result } }));
    }
  }
  terminate(): void {
    this.terminated = true;
  }
}

describe('engineStartError', () => {
  it('says the engine could not start, with why; an abort or a shutdown is left alone', () => {
    expect(String(engineStartError(new Error('blocked')))).toBe(`Error: ${ENGINE_START_FAILED}: blocked; ${ENGINE_START_HINT}`);
    expect(ENGINE_START_FAILED).toBe("Readside couldn't start the translation engine");
    expect(ENGINE_START_HINT).toBe('update Obsidian or report this');
    const abort = new DOMException('x', 'AbortError');
    expect(engineStartError(abort)).toBe(abort);
    const closed = new Error(ENGINE_CLOSED);
    expect(engineStartError(closed)).toBe(closed);
  });
});

function host(opts: { createWorker: () => WorkerLike; fetcher?: FakeFetcher | null; warn?: (m: string) => void }) {
  const adapter = new TestAdapter();
  const h = createTranslation({
    adapter: adapter as never,
    root: TROOT,
    settings: () => ({ target: 'en', hover: true }),
    saveTarget: () => {},
    notice: () => {},
    createWorker: opts.createWorker,
    ...(opts.fetcher === null ? {} : { fetcher: opts.fetcher ?? new FakeFetcher() }),
    warn: opts.warn,
    sha256: fakeSha256,
  });
  return { adapter, h };
}

describe('createTranslation', () => {
  it('starts no worker until a translation runs; then init gets the glue and the installed wasm, and the text is translated', async () => {
    const workers: RecWorker[] = [];
    const { adapter, h } = host({
      createWorker: () => {
        const w = new RecWorker();
        w.auto = true;
        workers.push(w);
        return w;
      },
    });
    installOnDisk(adapter, TROOT, [['uk', 'en']]);
    expect(workers).toHaveLength(0);
    expect(await h.translate({ text: UK, from: 'uk', to: 'en' })).toEqual({ kind: 'done', text: `[out] ${UK}`, from: 'uk', to: 'en' });
    expect(workers).toHaveLength(1);
    const [init] = workers[0].sent;
    expect(init.m.type).toBe('init');
    expect(init.m.glue).toBe(GLUE_JS);
    expect((init.m.wasm as ArrayBuffer).byteLength).toBe(ENGINE.file.size);
    expect(workers[0].sent.map((s) => s.m.type)).toEqual(['init', 'load', 'translate']);
    h.dispose();
    expect(workers[0].terminated).toBe(true);
  });

  it('a worker that cannot start reaches the caller as a plain "couldn’t start" error, not a hang', async () => {
    const { adapter, h } = host({
      createWorker: () => {
        throw new Error('Refused to create a worker from blob:');
      },
    });
    installOnDisk(adapter, TROOT, [['uk', 'en']]);
    await expect(h.translate({ text: UK, from: 'uk', to: 'en' })).rejects.toThrow(
      `${ENGINE_START_FAILED}: Refused to create a worker from blob:`,
    );
  });

  it('a wasm compile refused in the worker (init fails) says so the same way', async () => {
    const { adapter, h } = host({
      createWorker: () => {
        const w = new RecWorker();
        w.initError = "CompileError: WebAssembly.instantiate(): Refused to compile (no 'wasm-unsafe-eval')";
        return w;
      },
    });
    installOnDisk(adapter, TROOT, [['uk', 'en']]);
    await expect(h.translate({ text: UK, from: 'uk', to: 'en' })).rejects.toThrow(
      `${ENGINE_START_FAILED}: CompileError: WebAssembly.instantiate(): Refused to compile`,
    );
  });

  it('a worker that dies while starting says so too', async () => {
    const workers: RecWorker[] = [];
    const { adapter, h } = host({
      createWorker: () => {
        const w = new RecWorker();
        workers.push(w);
        return w;
      },
    });
    installOnDisk(adapter, TROOT, [['uk', 'en']]);
    const p = h.translate({ text: UK, from: 'uk', to: 'en' });
    await vi.waitFor(() => expect(workers[0]?.sent).toHaveLength(1));
    workers[0].onerror?.(new Event('error'));
    await expect(p).rejects.toThrow(`${ENGINE_START_FAILED}: ${ENGINE_STOPPED}`);
  });

  it('without Node https, downloads fall back to requestUrl, with a warning', () => {
    const warn = vi.fn();
    host({ createWorker: () => new RecWorker(), fetcher: null, warn });
    expect(warn).toHaveBeenCalledWith(REQUEST_URL_WARNING);
    const warn2 = vi.fn();
    host({ createWorker: () => new RecWorker(), warn: warn2 });
    expect(warn2).not.toHaveBeenCalled();
  });
});

describe('the blob: worker is the only worker (final review B1)', () => {
  it('a refused blob: worker fails the request with the cause and what to do; nothing is written to the plugin folder', async () => {
    const adapter = new TestAdapter();
    installOnDisk(adapter, TROOT, [['uk', 'en']]);
    const before = adapter.under(TROOT);
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('SecurityError: blob: workers are blocked');
        }
      },
    );
    try {
      const h = createTranslation({
        adapter: adapter as never,
        root: TROOT,
        settings: () => ({ target: 'en', hover: true }),
        saveTarget: () => {},
        notice: () => {},
        fetcher: new FakeFetcher(),
      });
      await expect(h.translate({ text: UK, from: 'uk', to: 'en' })).rejects.toThrow(
        `${ENGINE_START_FAILED}: SecurityError: blob: workers are blocked; ${ENGINE_START_HINT}`,
      );
      expect(adapter.under(TROOT)).toEqual(before);
      expect(adapter.under(TROOT).some((p) => p.endsWith('worker.js'))).toBe(false);
      h.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a worker that dies while starting names the cause its error event carries', async () => {
    const workers: RecWorker[] = [];
    const { adapter, h } = host({
      createWorker: () => {
        const w = new RecWorker();
        workers.push(w);
        return w;
      },
    });
    installOnDisk(adapter, TROOT, [['uk', 'en']]);
    const p = h.translate({ text: UK, from: 'uk', to: 'en' });
    await vi.waitFor(() => expect(workers[0]?.sent).toHaveLength(1));
    workers[0].onerror?.({ message: "Uncaught CompileError: WebAssembly.instantiate(): expected magic word" });
    await expect(p).rejects.toThrow(
      `${ENGINE_START_FAILED}: ${ENGINE_STOPPED}: Uncaught CompileError: WebAssembly.instantiate(): expected magic word; ${ENGINE_START_HINT}`,
    );
  });
});
