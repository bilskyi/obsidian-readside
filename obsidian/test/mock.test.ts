import { describe, expect, it, vi } from 'vitest';
import { App, Component, FileView, MemoryAdapter, PlaceholderView, Plugin, Scope, type TFile } from 'obsidian';
import { manifest, pdfBytes } from './helpers';

describe('obsidian mock', () => {
  it('Scope.handleKey: a keyed or modifier registration ends the lookup even when it returns undefined; a catch-all passes it on', () => {
    const parent = new Scope();
    const fromParent = vi.fn(() => false);
    parent.register(null, null, fromParent);
    const scope = new Scope(parent);
    const catchAll = vi.fn(() => undefined);
    const keyed = vi.fn(() => undefined);
    const after = vi.fn(() => true);
    scope.register(null, null, catchAll);
    scope.register(['Mod'], 'k', keyed);
    scope.register(null, null, after);
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { cancelable: true, ...init });
    // ⌘K: the catch-all passes it on; the keyed registration answers undefined and ends it there.
    expect(scope.handleKey(key({ key: 'k', metaKey: true }))).toBeUndefined();
    expect(catchAll).toHaveBeenCalledTimes(1);
    expect(keyed).toHaveBeenCalledTimes(1);
    expect(after).not.toHaveBeenCalled();
    expect(fromParent).not.toHaveBeenCalled();
    // A key nobody registered: the catch-alls run in order; `after` answers.
    expect(scope.handleKey(key({ key: 'j' }))).toBe(true);
    expect(after).toHaveBeenCalledTimes(1);
    expect(fromParent).not.toHaveBeenCalled();
    // A modifier-only registration (any key) also ends the lookup.
    const mods = new Scope(parent);
    const shift = vi.fn(() => undefined);
    mods.register(['Shift'], null, shift);
    expect(mods.handleKey(key({ key: 'x', shiftKey: true }))).toBeUndefined();
    expect(shift).toHaveBeenCalledTimes(1);
    expect(fromParent).not.toHaveBeenCalled();
    // Nothing matched in the child: the parent is asked.
    const evt = key({ key: 'x' });
    expect(mods.handleKey(evt)).toBe(false);
    expect(evt.defaultPrevented).toBe(true);
  });

  it('MemoryAdapter reads, writes and lists; rename refuses an existing destination; writes need the folder', async () => {
    const a = new MemoryAdapter();
    await a.mkdir('p/books');
    await a.write('p/books/x.json', '1');
    await a.write('p/books/y.json', '2');
    expect(await a.read('p/books/x.json')).toBe('1');
    expect((await a.list('p/books')).files).toEqual(['p/books/x.json', 'p/books/y.json']);
    await expect(a.rename('p/books/x.json', 'p/books/y.json')).rejects.toThrow('already exists');
    await expect(a.write('nowhere/z.json', '3')).rejects.toThrow('ENOENT');
  });

  it('failOn makes the next matching call reject, once', async () => {
    const a = new MemoryAdapter();
    a.folders.add('p');
    a.failOn('write', /\.tmp$/);
    await expect(a.write('p/a.tmp', 'x')).rejects.toThrow('write failed');
    await a.write('p/a.tmp', 'x');
    expect(a.calls).toEqual(['write p/a.tmp', 'write p/a.tmp']);
  });

  it('vault rename and fileManager.renameFile fire rename with the old path', async () => {
    const app = new App();
    const file = app.vault.addBinary('Books/a.pdf', pdfBytes());
    const seen: [string, string][] = [];
    app.vault.on('rename', (f: TFile, old: string) => seen.push([f.path, old]));
    await app.fileManager.renameFile(file, 'Library/b.pdf');
    expect(seen).toEqual([['Library/b.pdf', 'Books/a.pdf']]);
    expect(app.vault.getFileByPath('Library/b.pdf')).toBe(file);
    expect(file.basename).toBe('b');
  });

  it('a leaf creates the registered view and a FileView loads its file', async () => {
    const app = new App();
    app.vault.addBinary('Books/a.pdf', pdfBytes());
    const loaded: string[] = [];
    class V extends FileView {
      getViewType() {
        return 'v';
      }
      async onLoadFile(f: TFile) {
        loaded.push(f.path);
      }
    }
    app.workspace.viewCreators.set('v', (leaf) => new V(leaf));
    const leaf = app.workspace.getLeaf(true);
    await leaf.setViewState({ type: 'v', state: { file: 'Books/a.pdf' }, active: true });
    expect(loaded).toEqual(['Books/a.pdf']);
    expect(app.workspace.getLeavesOfType('v')).toEqual([leaf]);
    expect(app.workspace.getActiveFile()?.path).toBe('Books/a.pdf');
  });

  it('Component.unload: children first (last added first), then the cleanups last-registered first, then onunload', () => {
    const order: string[] = [];
    class C extends Component {
      onunload() {
        order.push('onunload');
      }
    }
    const c = new C();
    c.register(() => order.push('cleanup 1'));
    const child1 = new Component();
    child1.register(() => order.push('child 1'));
    const child2 = new Component();
    child2.register(() => order.push('child 2'));
    c.addChild(child1);
    c.addChild(child2);
    c.register(() => order.push('cleanup 2'));
    c.unload();
    expect(order).toEqual(['child 2', 'child 1', 'cleanup 2', 'cleanup 1', 'onunload']);
  });

  class V extends FileView {
    static order: string[] = [];
    getViewType() {
      return 'v';
    }
    async onClose() {
      V.order.push('close started');
      await Promise.resolve();
      await super.onClose();
      V.order.push('closed');
    }
    async onUnloadFile(f: TFile) {
      V.order.push(`unload ${f.path}`);
    }
  }
  class P extends Plugin {
    onunload() {
      V.order.push(`onunload, v leaves: ${this.app.workspace.getLeavesOfType('v').length}, leaves: ${this.app.workspace.leaves.length}`);
    }
  }

  it('unregistering a view type (update): each view closes synchronously before onunload; the leaf keeps a placeholder that reopens on the next registerView', async () => {
    const app = new App();
    app.vault.addBinary('Books/a.pdf', pdfBytes());
    V.order = [];
    const p = new P(app, manifest);
    p.registerView('v', (leaf) => new V(leaf));
    const leaf = app.workspace.getLeaf(true);
    await leaf.setViewState({ type: 'v', state: { file: 'Books/a.pdf' } });
    const old = leaf.view;
    p.unload();
    expect(V.order).toEqual(['close started', 'onunload, v leaves: 0, leaves: 1']);
    expect(leaf.view).toBeInstanceOf(PlaceholderView);
    expect((leaf.view as PlaceholderView).state).toEqual({ file: 'Books/a.pdf' });
    expect(old.containerEl.isConnected).toBe(false);
    await app.workspace.viewsClosing;
    expect(V.order.slice(2)).toEqual(['unload Books/a.pdf', 'closed']);
    const q = new P(app, manifest);
    q.registerView('v', (l) => new V(l));
    await app.workspace.viewsReopening;
    expect(leaf.view).toBeInstanceOf(V);
    expect(leaf.view).not.toBe(old);
    expect((leaf.view as V).file?.path).toBe('Books/a.pdf');
  });

  it('unregistering a view type the user turned off: views close and leaves detach synchronously, before onunload', async () => {
    const app = new App();
    app.vault.addBinary('Books/a.pdf', pdfBytes());
    V.order = [];
    const p = new P(app, manifest);
    p.registerView('v', (leaf) => new V(leaf));
    await app.workspace.getLeaf(true).setViewState({ type: 'v', state: { file: 'Books/a.pdf' } });
    p._userDisabled = true;
    p.unload();
    expect(V.order).toEqual(['close started', 'onunload, v leaves: 0, leaves: 0']);
    await app.workspace.viewsClosing;
    expect(V.order.slice(2)).toEqual(['unload Books/a.pdf', 'closed']);
  });

  it('View.close unloads the component and awaits onClose; FileView.onClose unloads the file', async () => {
    const app = new App();
    app.vault.addBinary('Books/a.pdf', pdfBytes());
    V.order = [];
    app.workspace.viewCreators.set('v', (leaf) => new V(leaf));
    const leaf = app.workspace.getLeaf(true);
    await leaf.setViewState({ type: 'v', state: { file: 'Books/a.pdf' } });
    const view = leaf.view as V;
    const off = vi.fn();
    view.register(off);
    const closing = leaf.detach();
    expect(off).toHaveBeenCalledTimes(1);
    expect(app.workspace.leaves).toEqual([]);
    await closing;
    expect(V.order).toEqual(['close started', 'unload Books/a.pdf', 'closed']);
    expect(view.file).toBeNull();
  });
});
