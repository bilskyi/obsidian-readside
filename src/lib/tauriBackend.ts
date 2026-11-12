// The standalone plugin repository has no desktop app: this is obsidian/src/stubs/tauriBackend.ts, which the
// plugin bundle uses in place of the desktop's Tauri backend. The plugin installs VaultBackend on load.
import type { Backend } from './backend';

const missing = () => Promise.reject(new Error('Margin: no backend installed (the plugin installs VaultBackend on load).'));

export const tauriBackend: Backend = new Proxy({} as Backend, { get: () => missing });
