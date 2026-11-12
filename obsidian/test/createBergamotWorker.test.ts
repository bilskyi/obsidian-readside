import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBergamotWorker, GLUE_JS, WORKER_JS } from '../src/translate/workerAssets';

describe('createBergamotWorker', () => {
  const realWorker = globalThis.Worker;
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  afterEach(() => {
    globalThis.Worker = realWorker;
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  });

  it('starts WORKER_JS from a blob: URL and revokes it when terminated', async () => {
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:margin/worker';
    });
    URL.revokeObjectURL = vi.fn();
    const made: { url: string; opts: unknown; terminated: number }[] = [];
    globalThis.Worker = class {
      onmessage = null;
      onerror = null;
      rec: { url: string; opts: unknown; terminated: number };
      constructor(url: string, opts: unknown) {
        this.rec = { url, opts, terminated: 0 };
        made.push(this.rec);
      }
      postMessage() {}
      terminate() {
        this.rec.terminated++;
      }
    } as unknown as typeof Worker;

    const w = createBergamotWorker();
    expect(made).toEqual([{ url: 'blob:margin/worker', opts: { name: 'margin-translation' }, terminated: 0 }]);
    expect(blobs[0].type).toBe('text/javascript');
    expect(await blobs[0].text()).toBe(WORKER_JS);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    w.terminate();
    expect(made[0].terminated).toBe(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:margin/worker');
    expect(GLUE_JS).toBe('function loadBergamot() {}');
  });

  it('revokes the URL if the worker cannot be created (e.g. blocked by CSP)', () => {
    URL.createObjectURL = vi.fn(() => 'blob:margin/worker');
    URL.revokeObjectURL = vi.fn();
    globalThis.Worker = class {
      constructor() {
        throw new Error('blocked');
      }
    } as unknown as typeof Worker;
    expect(() => createBergamotWorker()).toThrow('blocked');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:margin/worker');
  });
});
