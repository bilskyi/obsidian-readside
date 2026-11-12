import { App, MemoryAdapter } from 'obsidian';

export const ROOT = '.obsidian/plugins/readside';

export const manifest = {
  id: 'readside',
  name: 'Readside',
  version: '0.1.0',
  minAppVersion: '1.8.0',
  description: 'test',
  author: 'Margin',
  isDesktopOnly: true,
};

export function makeApp(): App {
  return new App();
}

/** A bare adapter with the plugin folder in place, as Obsidian has it for an installed plugin. */
export function pluginAdapter(): MemoryAdapter {
  const a = new MemoryAdapter();
  for (const f of ['.obsidian', '.obsidian/plugins', ROOT]) a.folders.add(f);
  return a;
}

/** Bytes standing in for a PDF: `%PDF-1.4 <text>`, padded with spaces to `size` when given. */
export function pdfBytes(text = 'sample', size?: number): ArrayBuffer {
  const head = `%PDF-1.4 ${text}`;
  const out = new Uint8Array(Math.max(size ?? 0, head.length)).fill(32);
  for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i);
  return out.buffer;
}

export const tick = () => new Promise<void>((r) => setTimeout(r, 0));
