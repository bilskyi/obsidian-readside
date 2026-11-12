// The Bergamot worker script and the vendored engine glue, bundled into main.js as text by the
// esbuild plugin in obsidian/scripts/workerAssetsPlugin.mjs, and the factory that starts the
// worker from a blob: URL. (Tests mock this module: `margin:worker-assets` exists only at build.)
import { GLUE_JS, WORKER_JS } from 'margin:worker-assets';
import type { WorkerLike } from '../../../src/translate/bergamot/BergamotClient';

export { GLUE_JS, WORKER_JS };

/** A dedicated worker running WORKER_JS; its blob: URL is revoked when it is terminated. */
export function createBergamotWorker(): WorkerLike {
  const url = URL.createObjectURL(new Blob([WORKER_JS], { type: 'text/javascript' }));
  let worker: Worker;
  try {
    worker = new Worker(url, { name: 'margin-translation' });
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  const terminate = worker.terminate.bind(worker);
  worker.terminate = () => {
    terminate();
    URL.revokeObjectURL(url);
  };
  // A Worker is a WorkerLike; its handler properties are typed with the narrower MessageEvent.
  return worker as unknown as WorkerLike;
}
