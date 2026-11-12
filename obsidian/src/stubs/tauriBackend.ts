import type { Backend } from '../../../src/lib/backend';

const missing = () => Promise.reject(new Error('Margin: no backend installed (the plugin installs VaultBackend on load).'));

/** Stands in for src/lib/tauriBackend.ts in the plugin bundle, so no Tauri code is bundled. */
export const tauriBackend: Backend = new Proxy({} as Backend, { get: () => missing });
