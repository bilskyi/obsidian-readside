import { createEvent, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderers/pdf/PdfRenderer', async () => ({ PdfRenderer: (await import('./fakeRenderer')).FakePdfRenderer }));
vi.mock('../../src/renderers/epub/EpubRenderer', async () => ({ EpubRenderer: (await import('./fakeRenderer')).FakeEpubRenderer }));

import type { App, TFile } from 'obsidian';
import * as bodySaves from '../../src/features/notebook/bodySaves';
import { setBackend } from '../../src/lib/backend';
import { VaultBackend } from '../src/backend/vaultBackend';
import { BookStore } from '../src/store/bookStore';
import { fingerprint } from '../src/store/hash';
import { MarginView, VIEW_TYPE } from '../src/view/MarginView';
import { makeApp, pdfBytes, ROOT } from './helpers';
import type { Scope } from './obsidian-mock';
import { epubFake, fake } from './fakeRenderer';
import { makeEpub } from '../../src/renderers/epub/testEpub';

let app: App;

beforeEach(async () => {
  app = makeApp();
  app.vault.addBinary('Books/Walden.pdf', pdfBytes('walden'));
  const store = new BookStore(app.vault.adapter, ROOT, { coalesceMs: 0 });
  await store.load();
  setBackend(new VaultBackend(store, { readBytes: (p) => app.vault.adapter.readBinary(p), confirm: async () => true }));
  app.workspace.viewCreators.set(
    VIEW_TYPE,
    (leaf) =>
      new MarginView(leaf, {
        openBook: async (f: TFile, bytes: ArrayBuffer) => (await store.openPath(f.path, await fingerprint(bytes), f.basename)).book,
        book: (id: string) => store.peek(id)?.book ?? null,
        closed: async () => {},
      }),
  );
});

afterEach(() => {
  setBackend(null);
  bodySaves.resetBodySavesForTests();
  document.body.replaceChildren();
  // The notebook remembers being open (per device): each test starts with it closed.
  localStorage.clear();
});

async function openView(): Promise<{ view: MarginView; root: HTMLElement }> {
  const leaf = app.workspace.getLeaf(true);
  await leaf.setViewState({ type: VIEW_TYPE, state: { file: 'Books/Walden.pdf' }, active: true });
  await screen.findByRole('heading', { name: 'Walden' });
  const view = leaf.view as MarginView;
  return { view, root: view.contentEl.querySelector<HTMLElement>('.margin-app')! };
}

/** Obsidian's Keymap: a window capture listener asking the active view's scope, else app.scope. */
function installKeymap(): { results: unknown[]; remove: () => void } {
  const results: unknown[] = [];
  const onKey = (evt: KeyboardEvent) => {
    const scope = (app.workspace.activeLeaf?.view.scope ?? app.scope) as unknown as Scope;
    results.push(scope.handleKey(evt));
  };
  window.addEventListener('keydown', onKey, true);
  return { results, remove: () => window.removeEventListener('keydown', onKey, true) };
}

const notebook = () => screen.queryByRole('complementary', { name: 'Notebook' });

async function openRoot(): Promise<HTMLElement> {
  const leaf = app.workspace.getLeaf(true);
  await leaf.setViewState({ type: VIEW_TYPE, state: { file: 'Books/Walden.pdf' }, active: true });
  await screen.findByRole('heading', { name: 'Walden' });
  return (leaf.view as MarginView).contentEl.querySelector<HTMLElement>('.margin-app')!;
}

describe('reader keys on the view root', () => {
  it('the reader root can take focus and marks itself as the page area', async () => {
    const root = await openRoot();
    // A plain div reports tabIndex -1 anyway; the attribute is what makes it focusable.
    expect(root.getAttribute('tabindex')).toBe('-1');
    expect(root.hasAttribute('data-margin-root')).toBe(true);
  });

  it('⌘\\ on the root toggles the notebook and does not bubble on to window listeners; on the window it does nothing', async () => {
    const root = await openRoot();
    fireEvent.keyDown(window, { key: '\\', metaKey: true });
    expect(screen.queryByRole('complementary', { name: 'Notebook' })).toBeNull();
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    try {
      fireEvent.keyDown(root, { key: '\\', metaKey: true });
      expect(await screen.findByRole('complementary', { name: 'Notebook' })).toBeTruthy();
      expect(seen).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', seen);
    }
  });
});

describe('reader keys through the view scope (Obsidian’s Keymap)', () => {
  it('the view has its own scope, a child of app.scope', async () => {
    const { view } = await openView();
    const scope = view.scope as unknown as Scope;
    expect(scope).toBeTruthy();
    expect(scope.parent).toBe(app.scope);
  });

  it('opening the leaf gives the reader root the keyboard', async () => {
    const { root } = await openView();
    expect(document.activeElement).toBe(root);
  });

  it('a file opened in the already active leaf (eState focus, no active-leaf-change) gives the reader the keyboard', async () => {
    const { view, root } = await openView();
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    const changes = vi.fn();
    app.workspace.on('active-leaf-change', changes);
    view.leaf.setEphemeralState({ subpath: '#page=2' });
    expect(document.activeElement).toBe(field);
    const focus = vi.spyOn(root, 'focus');
    view.leaf.setEphemeralState({ focus: true });
    expect(document.activeElement).toBe(root);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(changes).not.toHaveBeenCalled();
  });

  it('focus on body: ⌘\\ opens the notebook through the scope, which returns false (Obsidian stops the key)', async () => {
    await openView();
    const km = installKeymap();
    try {
      const evt = createEvent.keyDown(document.body, { key: '\\', code: 'Backslash', metaKey: true });
      fireEvent(document.body, evt);
      expect(km.results).toEqual([false]);
      expect(evt.defaultPrevented).toBe(true);
      expect(await screen.findByRole('complementary', { name: 'Notebook' })).toBeTruthy();
    } finally {
      km.remove();
    }
  });

  it('focus in the file explorer: a bare PageDown is still the page’s (claimed, false)', async () => {
    await openView();
    const explorer = document.createElement('div');
    explorer.className = 'nav-file-title';
    explorer.tabIndex = 0;
    document.body.appendChild(explorer);
    const km = installKeymap();
    try {
      fireEvent.keyDown(explorer, { key: 'PageDown' });
      fireEvent.keyDown(explorer, { key: 'ArrowLeft', altKey: true });
      expect(km.results).toEqual([false, false]);
    } finally {
      km.remove();
    }
  });

  it('⌘P is not the reader’s: the view handler returns undefined and the app hotkey runs', async () => {
    const { view } = await openView();
    const palette = vi.fn(() => false);
    app.scope.register(['Mod'], 'p', palette);
    const handler = (view.scope as unknown as Scope).handlers[0];
    const evt = new KeyboardEvent('keydown', { key: 'p', metaKey: true });
    Object.defineProperty(evt, 'target', { value: document.body });
    expect(handler.func(evt, { modifiers: 'Meta', key: 'p' })).toBeUndefined();
    const km = installKeymap();
    try {
      fireEvent.keyDown(document.body, { key: 'p', metaKey: true });
      expect(km.results).toEqual([false]);
      expect(palette).toHaveBeenCalledTimes(1);
    } finally {
      km.remove();
    }
  });

  it('target inside the root: the scope returns true and the root listener toggles exactly once', async () => {
    const { root } = await openView();
    const km = installKeymap();
    try {
      const evt = createEvent.keyDown(root, { key: '\\', code: 'Backslash', metaKey: true });
      fireEvent(root, evt);
      expect(km.results).toEqual([true]);
      expect(await screen.findByRole('complementary', { name: 'Notebook' })).toBeTruthy();
      // A second run anywhere would have closed it again.
      await new Promise((r) => setTimeout(r, 20));
      expect(notebook()).toBeTruthy();
      fireEvent.keyDown(root, { key: '\\', code: 'Backslash', metaKey: true });
      expect(km.results).toEqual([true, true]);
      await waitFor(() => expect(notebook()).toBeNull());
    } finally {
      km.remove();
    }
  });

  it('a bare PageDown with focus in a text field elsewhere is not the reader’s (undefined)', async () => {
    const { view } = await openView();
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    const km = installKeymap();
    try {
      const evt = createEvent.keyDown(input, { key: 'PageDown' });
      fireEvent(input, evt);
      expect(km.results).toEqual([undefined]);
      expect(evt.defaultPrevented).toBe(false);
      // ⌘\ from a field that isn't the reader's is not taken either.
      fireEvent.keyDown(input, { key: '\\', code: 'Backslash', metaKey: true });
      expect(km.results).toEqual([undefined, undefined]);
      expect(notebook()).toBeNull();
      expect(view.scope).toBeTruthy();
    } finally {
      km.remove();
    }
  });
});

describe('held keys with focus outside the root', () => {
  afterEach(() => vi.useRealTimers());

  /** The view's scope handler, with the runner counting what it really runs (and running nothing). */
  async function scopeKeys(): Promise<{ press: (init: KeyboardEventInit) => unknown; ran: string[] }> {
    const { view } = await openView();
    const real = view.commands.current!;
    const ran: string[] = [];
    view.commands.current = (cmd, checking) => {
      if (!checking) ran.push(cmd);
      return real(cmd, true);
    };
    const handler = (view.scope as unknown as Scope).handlers[0];
    const press = (init: KeyboardEventInit) => {
      const evt = new KeyboardEvent('keydown', init);
      Object.defineProperty(evt, 'target', { value: document.body });
      return handler.func(evt, { modifiers: null, key: init.key ?? null });
    };
    return { press, ran };
  }

  it('held ⌘= re-zooms at the root listener’s rate (REPEAT_THROTTLE_MS), not on every repeat', async () => {
    const { REPEAT_THROTTLE_MS } = await import('../../src/features/reader/useReaderShortcuts');
    const { press, ran } = await scopeKeys();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);
    expect(press({ key: '=', metaKey: true })).toBe(false);
    expect(ran).toEqual(['zoomIn']);
    for (const dt of [30, 30, 30]) {
      vi.setSystemTime(Date.now() + dt);
      // Claimed (false) even when skipped: Obsidian must not run a hotkey on it either.
      expect(press({ key: '=', metaKey: true, repeat: true })).toBe(false);
    }
    expect(ran).toEqual(['zoomIn']);
    vi.setSystemTime(10_000 + REPEAT_THROTTLE_MS);
    press({ key: '=', metaKey: true, repeat: true });
    expect(ran).toEqual(['zoomIn', 'zoomIn']);
    // ⌘- keeps its own clock.
    press({ key: '-', metaKey: true, repeat: true });
    expect(ran).toEqual(['zoomIn', 'zoomIn', 'zoomOut']);
    // A fresh press is never throttled.
    vi.setSystemTime(Date.now() + 1);
    press({ key: '=', metaKey: true });
    expect(ran).toEqual(['zoomIn', 'zoomIn', 'zoomOut', 'zoomIn']);
  });

  it('held PageDown still steps on every repeat, and a held ⌘\\ runs once', async () => {
    const { press, ran } = await scopeKeys();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10_000);
    press({ key: 'PageDown' });
    press({ key: 'PageDown', repeat: true });
    press({ key: 'PageDown', repeat: true });
    expect(ran).toEqual(['nextPage', 'nextPage', 'nextPage']);
    press({ key: '\\', code: 'Backslash', metaKey: true });
    expect(press({ key: '\\', code: 'Backslash', metaKey: true, repeat: true })).toBe(false);
    expect(ran).toEqual(['nextPage', 'nextPage', 'nextPage', 'toggleNotebook']);
  });
});

describe('focus mode in the Obsidian view', () => {
  const pill = () => screen.queryByRole('group', { name: 'Reader controls' });

  it('⌘. on the root: the scope returns true and the root listener toggles focus mode once; Esc on the root leaves it', async () => {
    const root = await openRoot();
    root.focus();
    const km = installKeymap();
    try {
      fireEvent.keyDown(root, { key: '.', code: 'Period', metaKey: true });
      expect(km.results).toEqual([true]);
      await waitFor(() => expect(pill()).toBeTruthy());
      expect(root.querySelector('.reader-bar')).toBeNull();
      // Esc isn't a reader command: the scope leaves it to Obsidian (undefined), the root listener uses it.
      fireEvent.keyDown(root, { key: 'Escape' });
      expect(km.results).toEqual([true, undefined]);
      expect(pill()).toBeNull();
      expect(root.querySelector('.reader-bar')).not.toBeNull();
    } finally {
      km.remove();
    }
  });

  it('focus on body: ⌘. runs through the scope (false, Obsidian stops it)', async () => {
    await openView();
    const km = installKeymap();
    try {
      (document.activeElement as HTMLElement | null)?.blur();
      fireEvent.keyDown(document.body, { key: '.', code: 'Period', metaKey: true });
      expect(km.results).toEqual([false]);
      await waitFor(() => expect(pill()).toBeTruthy());
    } finally {
      km.remove();
    }
  });

  it('Esc with focus outside the root leaves focus mode through the scope (false); otherwise Esc stays Obsidian’s (undefined)', async () => {
    await openView();
    const km = installKeymap();
    try {
      (document.activeElement as HTMLElement | null)?.blur();
      // Not in focus mode: Obsidian's.
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(km.results).toEqual([undefined]);
      fireEvent.keyDown(document.body, { key: '.', code: 'Period', metaKey: true });
      await waitFor(() => expect(pill()).toBeTruthy());
      (document.activeElement as HTMLElement | null)?.blur();
      // A modified Esc, or one in a text field elsewhere, is not the reader's.
      fireEvent.keyDown(document.body, { key: 'Escape', shiftKey: true });
      const field = document.body.appendChild(document.createElement('input'));
      fireEvent.keyDown(field, { key: 'Escape' });
      field.remove();
      expect(km.results.slice(2)).toEqual([undefined, undefined]);
      expect(pill()).toBeTruthy();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(km.results.slice(4)).toEqual([false]);
      await waitFor(() => expect(pill()).toBeNull());
    } finally {
      km.remove();
    }
  });

  it('Esc outside the root while the search bar is open is not claimed: the bar takes Esc first, focus mode stays', async () => {
    const root = await openRoot();
    root.focus();
    const km = installKeymap();
    try {
      fireEvent.keyDown(root, { key: '.', code: 'Period', metaKey: true });
      await waitFor(() => expect(pill()).toBeTruthy());
      fireEvent.keyDown(root, { key: 'f', code: 'KeyF', metaKey: true });
      await screen.findByRole('search');
      (document.activeElement as HTMLElement | null)?.blur();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(km.results.at(-1)).toBeUndefined();
      expect(pill()).toBeTruthy();
    } finally {
      km.remove();
    }
  });

  it('⌘⇧F stays Obsidian’s (search in all files): the scope returns undefined', async () => {
    const { root } = await openView();
    const km = installKeymap();
    try {
      fireEvent.keyDown(root, { key: 'F', code: 'KeyF', metaKey: true, shiftKey: true });
      expect(km.results).toEqual([undefined]);
      expect(pill()).toBeNull();
    } finally {
      km.remove();
    }
  });

  it('remembers focus mode under the same key as the desktop app; each host keeps its own', async () => {
    const root = await openRoot();
    fireEvent.keyDown(root, { key: '.', code: 'Period', metaKey: true });
    await waitFor(() => expect(pill()).toBeTruthy());
    expect(localStorage.getItem('margin.focus')).toBe('true');
  });
});

describe('an EPUB: PageUp/PageDown with focus outside the reader root (view scope)', () => {
  async function openMoby(): Promise<MarginView> {
    app.vault.addBinary('Books/Moby.epub', makeEpub({ title: 'Moby-Dick', sections: [{ name: 'a.xhtml', html: '<p>Call me Ishmael.</p>' }] }));
    const leaf = app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: 'Books/Moby.epub' }, active: true });
    const view = leaf.view as MarginView;
    await waitFor(() => expect(view.commands.current).not.toBeNull());
    await waitFor(() => expect(view.contentEl.querySelector('.pdf-scroller')).not.toBeNull());
    return view;
  }

  it('focus on body: PageDown scrolls one screen (the key reaches the reader) and never steps a section', async () => {
    await openMoby();
    fake.goTo.mockClear();
    epubFake.scrollBy.mockClear();
    const km = installKeymap();
    try {
      (document.activeElement as HTMLElement | null)?.blur();
      fireEvent.keyDown(document.body, { key: 'PageDown', code: 'PageDown' });
      fireEvent.keyDown(document.body, { key: 'PageUp', code: 'PageUp' });
      expect(km.results).toEqual([false, false]);
    } finally {
      km.remove();
    }
    expect(epubFake.scrollBy).toHaveBeenCalledTimes(2);
    expect(epubFake.scrollBy.mock.calls[0][0].top).toBeGreaterThan(0);
    expect(epubFake.scrollBy.mock.calls[1][0].top).toBeLessThan(0);
    expect(fake.goTo).not.toHaveBeenCalled();
  });

  it('⌥→ from the body still steps a section (no scroll)', async () => {
    await openMoby();
    epubFake.scrollBy.mockClear();
    const km = installKeymap();
    try {
      fireEvent.keyDown(document.body, { key: 'ArrowRight', code: 'ArrowRight', altKey: true });
      expect(km.results).toEqual([false]);
    } finally {
      km.remove();
    }
    expect(epubFake.scrollBy).not.toHaveBeenCalled();
  });
});
