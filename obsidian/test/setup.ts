import { webcrypto } from 'node:crypto';
import { beforeEach } from 'vitest';
import { Menu, Modal, Notice, Setting, __failPdfJs } from 'obsidian';

// jsdom has no crypto.subtle; the plugin hashes with it (fingerprints, mirror conflict checks).
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

beforeEach(() => {
  Modal.opened.length = 0;
  Menu.shown.length = 0;
  Notice.messages.length = 0;
  Notice.durations.length = 0;
  Setting.all.length = 0;
  __failPdfJs(null);
});
