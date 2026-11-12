// Stands in for the build-time virtual module `margin:worker-assets` (see obsidian/vitest.config.ts).
export const WORKER_JS = 'self.onmessage = () => {};';
export const GLUE_JS = 'function loadBergamot() {}';
