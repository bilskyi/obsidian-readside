/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A small runtime stand-in for the `obsidian` module (the npm package is types only). It covers what
 * the plugin and its tests use, with Obsidian's observable behaviour: adapter.rename refuses an
 * existing destination, vault events fire, leaves create registered views and FileView loads files.
 */

type Handler = (...args: any[]) => any;
export interface EventRef {
  source: Events;
  name: string;
  fn: Handler;
}

export class Events {
  private handlers = new Map<string, Set<Handler>>();
  on(name: string, fn: Handler, _ctx?: unknown): EventRef {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(fn);
    return { source: this, name, fn };
  }
  off(name: string, fn: Handler): void {
    this.handlers.get(name)?.delete(fn);
  }
  offref(ref: EventRef): void {
    this.off(ref.name, ref.fn);
  }
  trigger(name: string, ...args: unknown[]): void {
    for (const fn of [...(this.handlers.get(name) ?? [])]) fn(...args);
  }
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '') || '/';
}

export abstract class TAbstractFile {
  vault!: Vault;
  path = '';
  name = '';
  parent: TFolder | null = null;
}
export class TFile extends TAbstractFile {
  basename = '';
  extension = '';
  stat = { ctime: 0, mtime: 0, size: 0 };
}
export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot(): boolean {
    return this.path === '/';
  }
}

type Op = 'exists' | 'read' | 'readBinary' | 'write' | 'writeBinary' | 'remove' | 'rename' | 'mkdir' | 'list' | 'copy';
interface Failure {
  op: Op;
  match: (path: string) => boolean;
  times: number;
  error: unknown;
}

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const toBuffer = (s: string): ArrayBuffer => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out.buffer;
};

/** In-memory DataAdapter keyed by vault path. Writes need the parent folder, like the real one. */
export class MemoryAdapter {
  files = new Map<string, string | ArrayBuffer>();
  folders = new Set<string>();
  /** `"<op> <path>"` for every call, in order. */
  calls: string[] = [];
  private failures: Failure[] = [];

  getName(): string {
    return 'memory';
  }
  /** The next `times` calls of `op` on a matching path reject with `error`. */
  failOn(op: Op, match: string | RegExp | ((p: string) => boolean) = () => true, times = 1, error: unknown = new Error(`${op} failed`)): void {
    const m = typeof match === 'string' ? (p: string) => p === match : match instanceof RegExp ? (p: string) => match.test(p) : match;
    this.failures.push({ op, match: m, times, error });
  }
  private hit(op: Op, path: string): void {
    this.calls.push(`${op} ${path}`);
    const f = this.failures.find((x) => x.op === op && x.times > 0 && x.match(path));
    if (f) {
      f.times--;
      throw f.error;
    }
  }
  private needParent(path: string): void {
    const dir = dirOf(path);
    if (dir && !this.folders.has(dir)) throw new Error(`ENOENT: no folder ${dir}`);
  }
  async exists(path: string): Promise<boolean> {
    this.hit('exists', path);
    return this.files.has(path) || this.folders.has(path);
  }
  async stat(path: string) {
    const v = this.files.get(path);
    if (v !== undefined) return { type: 'file', ctime: 0, mtime: this.mtimes.get(path) ?? 0, size: typeof v === 'string' ? v.length : v.byteLength };
    return this.folders.has(path) ? { type: 'folder', ctime: 0, mtime: 0, size: 0 } : null;
  }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    this.hit('list', path);
    const direct = (p: string) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/');
    return { files: [...this.files.keys()].filter(direct).sort(), folders: [...this.folders].filter(direct).sort() };
  }
  async read(path: string): Promise<string> {
    this.hit('read', path);
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return typeof v === 'string' ? v : new TextDecoder().decode(v);
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    this.hit('readBinary', path);
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return typeof v === 'string' ? toBuffer(v) : v.slice(0);
  }
  async write(path: string, data: string): Promise<void> {
    this.hit('write', path);
    this.needParent(path);
    this.files.set(path, data);
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.hit('writeBinary', path);
    this.needParent(path);
    this.files.set(path, data.slice(0));
    this.mtimes.set(path, Date.now());
    this.versions.set(path, (this.versions.get(path) ?? 0) + 1);
  }
  async remove(path: string): Promise<void> {
    this.hit('remove', path);
    if (!this.files.delete(path)) throw new Error(`ENOENT: ${path}`);
  }
  async rename(path: string, newPath: string): Promise<void> {
    this.hit('rename', path);
    if (this.files.has(newPath) || this.folders.has(newPath)) throw new Error('Destination file already exists!');
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    this.needParent(newPath);
    this.files.delete(path);
    this.files.set(newPath, v);
    if (this.mtimes.has(path)) this.mtimes.set(newPath, this.mtimes.get(path)!);
    this.mtimes.delete(path);
  }
  async copy(path: string, newPath: string): Promise<void> {
    this.hit('copy', path);
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    if (this.files.has(newPath)) throw new Error('Destination file already exists!');
    this.files.set(newPath, v);
  }
  /** Like Obsidian's: an app:// URL for the file, with its modification counter as the query. */
  getResourcePath(path: string): string {
    return `app://local/${encodeURI(path)}?${this.versions.get(path) ?? 0}`;
  }
  private versions = new Map<string, number>();
  /** Modification times of binary files written through the adapter (others: 0, i.e. old). */
  mtimes = new Map<string, number>();
  async mkdir(path: string): Promise<void> {
    this.hit('mkdir', path);
    let p = '';
    for (const part of path.split('/')) {
      p = p ? `${p}/${part}` : part;
      this.folders.add(p);
    }
  }
}

export class Vault extends Events {
  adapter = new MemoryAdapter();
  configDir = '.obsidian';
  private byPath = new Map<string, TAbstractFile>();
  private vaultName: string;

  constructor(name = 'Test Vault') {
    super();
    this.vaultName = name;
    this.adapter.folders.add('.obsidian');
    this.adapter.folders.add('.obsidian/plugins');
    this.adapter.folders.add('.obsidian/plugins/margin-reader');
  }
  getName(): string {
    return this.vaultName;
  }
  getFiles(): TFile[] {
    return [...this.byPath.values()].filter((f): f is TFile => f instanceof TFile);
  }
  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((f) => f.extension === 'md');
  }
  /** Test helper: how many times cachedRead ran, per path. */
  cachedReads = new Map<string, number>();
  getFileByPath(path: string): TFile | null {
    const f = this.byPath.get(normalizePath(path));
    return f instanceof TFile ? f : null;
  }
  getFolderByPath(path: string): TFolder | null {
    const f = this.byPath.get(normalizePath(path));
    return f instanceof TFolder ? f : null;
  }
  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.byPath.get(normalizePath(path)) ?? null;
  }
  private place(f: TAbstractFile, path: string): void {
    f.vault = this;
    f.path = path;
    f.name = path.slice(path.lastIndexOf('/') + 1);
    if (f instanceof TFile) {
      const dot = f.name.lastIndexOf('.');
      f.basename = dot > 0 ? f.name.slice(0, dot) : f.name;
      f.extension = dot > 0 ? f.name.slice(dot + 1) : '';
    }
    this.byPath.set(path, f);
  }
  private ensureFolders(dir: string): void {
    let p = '';
    for (const part of dir.split('/').filter(Boolean)) {
      p = p ? `${p}/${part}` : part;
      this.adapter.folders.add(p);
      if (!this.byPath.has(p)) this.place(new TFolder(), p);
    }
  }
  /** Test helper: a binary file (a PDF) already in the vault, without a create event. */
  addBinary(path: string, data: ArrayBuffer): TFile {
    path = normalizePath(path);
    this.ensureFolders(dirOf(path));
    this.adapter.files.set(path, data);
    const f = new TFile();
    this.place(f, path);
    f.stat.size = data.byteLength;
    return f;
  }
  async create(path: string, data: string): Promise<TFile> {
    path = normalizePath(path);
    if (this.byPath.has(path)) throw new Error('File already exists.');
    await this.adapter.write(path, data);
    const f = new TFile();
    this.place(f, path);
    f.stat.size = data.length;
    this.trigger('create', f);
    return f;
  }
  async createFolder(path: string): Promise<TFolder> {
    path = normalizePath(path);
    if (this.byPath.has(path)) throw new Error('Folder already exists.');
    await this.adapter.mkdir(path);
    this.ensureFolders(path);
    return this.byPath.get(path) as TFolder;
  }
  async read(file: TFile): Promise<string> {
    return this.adapter.read(file.path);
  }
  async cachedRead(file: TFile): Promise<string> {
    this.cachedReads.set(file.path, (this.cachedReads.get(file.path) ?? 0) + 1);
    return this.read(file);
  }
  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return this.adapter.readBinary(file.path);
  }
  getResourcePath(file: TFile): string {
    return this.adapter.getResourcePath(file.path);
  }
  async modify(file: TFile, data: string): Promise<void> {
    await this.adapter.write(file.path, data);
    file.stat.size = data.length;
    this.trigger('modify', file);
  }
  /** Read, transform, write, as one step (Obsidian's atomic read-modify-write); returns what was written. */
  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const data = fn(await this.adapter.read(file.path));
    await this.adapter.write(file.path, data);
    file.stat.size = data.length;
    this.trigger('modify', file);
    return data;
  }
  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    newPath = normalizePath(newPath);
    if (this.byPath.has(newPath)) throw new Error('Destination file already exists!');
    const old = file.path;
    this.ensureFolders(dirOf(newPath));
    const moves = [...this.byPath.keys()].filter((p) => p === old || p.startsWith(`${old}/`));
    for (const p of moves) {
      const f = this.byPath.get(p)!;
      const to = newPath + p.slice(old.length);
      this.byPath.delete(p);
      if (f instanceof TFile) {
        const v = this.adapter.files.get(p);
        this.adapter.files.delete(p);
        if (v !== undefined) this.adapter.files.set(to, v);
      } else {
        this.adapter.folders.delete(p);
        this.adapter.folders.add(to);
      }
      this.place(f, to);
    }
    // Like Obsidian, one event for the moved item (a folder's children are not announced one by one).
    this.trigger('rename', file, old);
  }
  async delete(file: TAbstractFile): Promise<void> {
    if (file instanceof TFile) this.adapter.files.delete(file.path);
    this.byPath.delete(file.path);
    this.trigger('delete', file);
  }
}

export class FileManager {
  constructor(private vault: Vault) {}
  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    await this.vault.rename(file, newPath);
  }
}

export interface MockLinkCache {
  link: string;
  original: string;
  displayText?: string;
  position: { start: { line: number; col: number; offset: number }; end: { line: number; col: number; offset: number } };
}
/** `key: value` lines between leading `---` fences; values JSON-parsed when they can be. */
function frontmatterOf(text: string): Record<string, unknown> | null {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!m) return null;
  const out: Record<string, unknown> = {};
  for (const line of m[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const raw = line.slice(colon + 1).trim();
    try {
      out[line.slice(0, colon).trim()] = JSON.parse(raw);
    } catch {
      out[line.slice(0, colon).trim()] = raw;
    }
  }
  return out;
}
export class MetadataCache extends Events {
  resolvedLinks: Record<string, Record<string, number>> = {};
  unresolvedLinks: Record<string, Record<string, number>> = {};
  private caches = new Map<string, { links?: MockLinkCache[]; embeds?: MockLinkCache[] }>();
  constructor(private vault: Vault) {
    super();
  }
  /**
   * The links set with setCache, plus the note's frontmatter read from its current text (like Obsidian's
   * cache once it has caught up), so a note Margin writes carries its `margin-book` key here too.
   */
  getFileCache(file: TFile): { links?: MockLinkCache[]; embeds?: MockLinkCache[]; frontmatter?: Record<string, unknown> } | null {
    const cached = this.caches.get(file.path);
    const text = this.vault.adapter.files.get(file.path);
    const fm = typeof text === 'string' ? frontmatterOf(text) : null;
    if (!cached && !fm) return null;
    return { ...cached, ...(fm ? { frontmatter: fm } : {}) };
  }
  /** Test helper: sets a note's cached links (and its resolvedLinks entry from the ones that resolve). */
  setCache(path: string, cache: { links?: MockLinkCache[]; embeds?: MockLinkCache[] }): void {
    this.caches.set(path, cache);
    const resolved: Record<string, number> = {};
    for (const l of [...(cache.links ?? []), ...(cache.embeds ?? [])]) {
      const dest = this.getFirstLinkpathDest(l.link.split('#')[0], path);
      if (dest) resolved[dest.path] = (resolved[dest.path] ?? 0) + 1;
    }
    this.resolvedLinks[path] = resolved;
  }
  /** The shortest unambiguous link text: the basename when no other file has it, else the path. */
  fileToLinktext(file: TFile, _sourcePath: string, omitMdExtension = true): string {
    const unique = this.vault.getFiles().filter((f) => f.basename === file.basename).length === 1;
    const path = omitMdExtension && file.extension === 'md' ? file.path.slice(0, -3) : file.path;
    return unique ? (omitMdExtension && file.extension === 'md' ? file.basename : file.name) : path;
  }
  /** Resolves a link path the simple way: an exact vault path, else the first file with that name. */
  getFirstLinkpathDest(linkpath: string, _sourcePath: string): TFile | null {
    return this.vault.getFileByPath(linkpath) ?? this.vault.getFiles().find((f) => f.name === linkpath || f.basename === linkpath) ?? null;
  }
}

export class Component {
  private cleanups: (() => void)[] = [];
  private children: Component[] = [];
  load(): void {
    this.onload();
  }
  onload(): void {}
  /** Like Obsidian: children unload first (last added first), then the registered cleanups (last first), then onunload(). */
  unload(): void {
    while (this.children.length) this.children.pop()!.unload();
    while (this.cleanups.length) this.cleanups.pop()!();
    this.onunload();
  }
  onunload(): void {}
  register(cb: () => void): void {
    this.cleanups.push(cb);
  }
  registerEvent(ref: EventRef): void {
    this.register(() => ref.source.offref(ref));
  }
  registerDomEvent(el: EventTarget, type: string, cb: (ev: any) => any, options?: boolean | AddEventListenerOptions): void {
    el.addEventListener(type, cb, options);
    this.register(() => el.removeEventListener(type, cb, options));
  }
  registerInterval(id: number): number {
    this.register(() => clearInterval(id));
    return id;
  }
  addChild<T extends Component>(child: T): T {
    child.load();
    this.children.push(child);
    return child;
  }
}

export class View extends Component {
  app: App;
  leaf: WorkspaceLeaf;
  containerEl: HTMLElement;
  icon = '';
  navigation = false;
  scope: Scope | null = null;
  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = document.createElement('div');
    this.containerEl.className = 'workspace-leaf-content';
    // Obsidian's HTMLElement.isShown(): on screen. Unless a test says (`shown`), only the active leaf is.
    (this.containerEl as HTMLElement & { isShown: () => boolean }).isShown = () => this.shown ?? this.app.workspace.activeLeaf === this.leaf;
  }
  /** Test helper: overrides isShown() (a leaf in a split beside the active one is still shown). */
  shown: boolean | null = null;
  getViewType(): string {
    return '';
  }
  getDisplayText(): string {
    return '';
  }
  getIcon(): string {
    return this.icon;
  }
  getState(): Record<string, unknown> {
    return {};
  }
  async setState(_state: unknown, _result: unknown): Promise<void> {}
  getEphemeralState(): Record<string, unknown> {
    return {};
  }
  setEphemeralState(_state: unknown): void {}
  /** Like Obsidian's View.onPaneMenu: adds the core items (here, one marker item a subclass must keep). */
  onPaneMenu(menu: Menu, _source: string): void {
    menu.addItem((item) => item.setTitle('Close').setIcon('x').setSection('close'));
  }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
  /** Like Obsidian's View.close: detach the container, unload the component, then await onClose(). onClose starts synchronously. */
  async close(): Promise<void> {
    this.containerEl.remove();
    this.unload();
    await this.onClose();
  }
}

class EmptyView extends View {
  getViewType(): string {
    return 'empty';
  }
}

/** What a leaf shows while its view type is not registered (a plugin turned off or updating); it keeps the state. */
export class PlaceholderView extends View {
  constructor(leaf: WorkspaceLeaf, readonly type: string, readonly state: Record<string, unknown>) {
    super(leaf);
  }
  getViewType(): string {
    return 'placeholder';
  }
}

/**
 * Like Obsidian's DeferredView (1.7.2+): a background tab restored at startup holds this instead of its real
 * view until it is shown; the leaf's view state is the saved one. revealLeaf / loadIfDeferred load it.
 */
export class DeferredView extends View {
  constructor(leaf: WorkspaceLeaf, readonly type: string, readonly state: Record<string, unknown>) {
    super(leaf);
  }
  getViewType(): string {
    return this.type;
  }
}

export class ItemView extends View {
  contentEl: HTMLElement;
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    const header = document.createElement('div');
    header.className = 'view-header';
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'view-content';
    this.containerEl.append(header, this.contentEl);
  }
  /** Like Obsidian: an icon button in the view header's actions, named by `title`. `data-icon`: the icon asked for. */
  addAction(icon: string, title: string, callback: (evt: MouseEvent) => any): HTMLElement {
    const header = this.containerEl.querySelector('.view-header')!;
    let actions = header.querySelector('.view-actions');
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'view-actions';
      header.appendChild(actions);
    }
    const el = document.createElement('a');
    el.className = 'clickable-icon view-action';
    el.setAttribute('aria-label', title);
    el.dataset.icon = icon;
    el.addEventListener('click', callback);
    actions.appendChild(el);
    return el;
  }
}

export class FileView extends ItemView {
  file: TFile | null = null;
  allowNoFile = false;
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.navigation = true;
  }
  getDisplayText(): string {
    return this.file?.basename ?? '';
  }
  getState(): Record<string, unknown> {
    return this.file ? { file: this.file.path } : {};
  }
  /** Like Obsidian: `state.file` loads that file (unloading the previous one); the same file is not reloaded. */
  async setState(state: any, _result: unknown): Promise<void> {
    const path = state?.file;
    if (typeof path !== 'string') return;
    const f = this.app.vault.getFileByPath(path);
    if (!f || f === this.file) return;
    if (this.file) {
      const old = this.file;
      this.file = null;
      await this.onUnloadFile(old);
    }
    this.file = f;
    await this.onLoadFile(f);
  }
  /** Like Obsidian's FileView.onClose: empty contentEl, then loadFile(null), which unloads the open file. */
  async onClose(): Promise<void> {
    this.contentEl.replaceChildren();
    if (this.file) {
      const old = this.file;
      this.file = null;
      await this.onUnloadFile(old);
    }
  }
  async onLoadFile(_file: TFile): Promise<void> {}
  async onUnloadFile(_file: TFile): Promise<void> {}
  async onRename(_file: TFile): Promise<void> {}
  canAcceptExtension(_extension: string): boolean {
    return false;
  }
}

export class WorkspaceLeaf extends Events {
  app: App;
  view: View;
  containerEl: HTMLElement;
  constructor(app: App) {
    super();
    this.app = app;
    this.containerEl = document.createElement('div');
    document.body.appendChild(this.containerEl);
    this.view = new EmptyView(this);
  }
  /** Test helper: the leaf is pinned (reported by getViewState). */
  pinned = false;
  getViewState(): { type: string; state: Record<string, unknown>; pinned?: boolean } {
    const pin = this.pinned ? { pinned: true } : {};
    if (this.view instanceof DeferredView) return { type: this.view.type, state: this.view.state, ...pin };
    return { type: this.view.getViewType(), state: this.view.getState(), ...pin };
  }
  get isDeferred(): boolean {
    return this.view instanceof DeferredView;
  }
  async loadIfDeferred(): Promise<void> {
    const v = this.view;
    if (!(v instanceof DeferredView)) return;
    this.view = new EmptyView(this);
    await this.setViewState({ type: v.type, state: v.state });
  }
  getEphemeralState(): Record<string, unknown> {
    return this.view.getEphemeralState();
  }
  /** Like Obsidian: hands the state to the view (openFile passes `{ focus: true }` after setViewState). */
  setEphemeralState(state: unknown): void {
    this.view.setEphemeralState(state);
  }
  /**
   * Its view type was unregistered (view-unregistered): Obsidian captures the view state and opens a
   * placeholder in the leaf, and leaf.open closes the old view synchronously. Returns that close.
   */
  toPlaceholder(type: string): Promise<void> {
    const old = this.view;
    const state = old.getState();
    this.view = new PlaceholderView(this, type, state);
    this.containerEl.appendChild(this.view.containerEl);
    return old.close();
  }
  /** Like leaf.open: the old view's close() starts synchronously; the new view opens once it has finished. */
  async setViewState(vs: { type: string; state?: Record<string, unknown>; active?: boolean }): Promise<void> {
    if (this.view.getViewType() !== vs.type) {
      const creator = this.app.workspace.viewCreators.get(vs.type);
      if (!creator) throw new Error(`no view registered for ${vs.type}`);
      await this.view.close();
      this.view = creator(this);
      this.containerEl.appendChild(this.view.containerEl);
      await this.view.onOpen();
    }
    await this.view.setState(vs.state ?? {}, { history: false });
    if (vs.active) this.app.workspace.setActiveLeaf(this);
  }
  /** Leaves the workspace synchronously and closes its view (close starts synchronously). Returns the close in the mock (void in Obsidian). */
  detach(): Promise<void> {
    const old = this.view;
    this.view = new EmptyView(this);
    this.app.workspace.removeLeaf(this);
    this.containerEl.remove();
    return old.close();
  }
  getDisplayText(): string {
    return this.view.getDisplayText();
  }
  /** Test helper: the file openFile was last asked to show (the mock registers no Markdown view). */
  openedFile: TFile | null = null;
  /** Test helper: the OpenViewState openFile was last given. */
  openedState: unknown = undefined;
  async openFile(file: TFile, state?: unknown): Promise<void> {
    this.openedFile = file;
    this.openedState = state;
  }
}

export class Workspace extends Events {
  leaves: WorkspaceLeaf[] = [];
  activeLeaf: WorkspaceLeaf | null = null;
  viewCreators = new Map<string, (leaf: WorkspaceLeaf) => View>();
  /** Test helper: settles once the views of a view type unregistered last have closed. */
  viewsClosing: Promise<void> = Promise.resolve();
  /** Test helper: settles once placeholder leaves of a view type registered last have reopened as that type. */
  viewsReopening: Promise<void> = Promise.resolve();
  constructor(private app: App) {
    super();
  }
  /** false/undefined: the active leaf (a new one if none); anything else: a new leaf. */
  getLeaf(newLeaf?: boolean | string): WorkspaceLeaf {
    if (!newLeaf && this.activeLeaf) return this.activeLeaf;
    const leaf = new WorkspaceLeaf(this.app);
    this.leaves.push(leaf);
    if (!this.activeLeaf) this.activeLeaf = leaf;
    return leaf;
  }
  /** Test helper: the (leaf, direction) pairs createLeafBySplit was asked for. */
  splits: Array<{ of: WorkspaceLeaf; direction?: string }> = [];
  createLeafBySplit(leaf: WorkspaceLeaf, direction?: string): WorkspaceLeaf {
    this.splits.push({ of: leaf, direction });
    const made = new WorkspaceLeaf(this.app);
    this.leaves.push(made);
    return made;
  }
  getLeavesOfType(type: string): WorkspaceLeaf[] {
    return this.leaves.filter((l) => l.view.getViewType() === type);
  }
  async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
    this.setActiveLeaf(leaf);
    await leaf.loadIfDeferred();
  }
  iterateAllLeaves(callback: (leaf: WorkspaceLeaf) => unknown): void {
    for (const leaf of [...this.leaves]) callback(leaf);
  }
  /** Test helper: a background tab restored at startup, still deferred (not active). */
  addDeferredLeaf(type: string, state: Record<string, unknown>): WorkspaceLeaf {
    const leaf = new WorkspaceLeaf(this.app);
    leaf.view = new DeferredView(leaf, type, state);
    leaf.containerEl.appendChild(leaf.view.containerEl);
    this.leaves.push(leaf);
    return leaf;
  }
  getMostRecentLeaf(): WorkspaceLeaf | null {
    return this.activeLeaf;
  }
  setActiveLeaf(leaf: WorkspaceLeaf): void {
    this.activeLeaf = leaf;
    this.trigger('active-leaf-change', leaf);
  }
  getActiveViewOfType<T extends View>(type: new (...args: any[]) => T): T | null {
    const v = this.activeLeaf?.view;
    return v instanceof type ? v : null;
  }
  getActiveFile(): TFile | null {
    const v = this.activeLeaf?.view;
    return v instanceof FileView ? v.file : null;
  }
  removeLeaf(leaf: WorkspaceLeaf): void {
    this.leaves = this.leaves.filter((l) => l !== leaf);
    if (this.activeLeaf === leaf) this.activeLeaf = this.leaves[0] ?? null;
  }
}

/** Obsidian's internal view registry (app.viewRegistry): which view type opens each file extension. */
export class ViewRegistry {
  typeByExtension: Record<string, string> = { pdf: 'pdf', md: 'markdown' };
  registerExtensions(extensions: string[], viewType: string): void {
    for (const e of extensions) {
      if (Object.prototype.hasOwnProperty.call(this.typeByExtension, e)) throw new Error(`Attempting to register an existing file extension "${e}"`);
    }
    for (const e of extensions) this.typeByExtension[e] = viewType;
  }
  unregisterExtensions(extensions: string[]): void {
    for (const e of extensions) delete this.typeByExtension[e];
  }
  getTypeByExtension(extension: string): string | undefined {
    return this.typeByExtension[extension];
  }
}

export class App {
  viewRegistry: ViewRegistry = new ViewRegistry();
  vault: Vault;
  workspace: Workspace;
  fileManager: FileManager;
  metadataCache: MetadataCache;
  /** The hotkey scope (Obsidian's hotkey manager registers here). */
  scope: Scope = new Scope();
  constructor() {
    this.vault = new Vault();
    this.workspace = new Workspace(this);
    this.fileManager = new FileManager(this.vault);
    this.metadataCache = new MetadataCache(this.vault);
  }
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
  isDesktopOnly?: boolean;
}
export interface Command {
  id: string;
  name: string;
  callback?: () => any;
  checkCallback?: (checking: boolean) => boolean | void;
}

export class Plugin extends Component {
  app: App;
  manifest: PluginManifest;
  commands: Command[] = [];
  protocolHandlers = new Map<string, (params: Record<string, string>) => any>();
  ribbonIcons: { icon: string; title: string; callback: (evt: MouseEvent) => any; el: HTMLElement }[] = [];
  settingTabs: PluginSettingTab[] = [];
  /** What loadData() returns; saveData() replaces it. */
  savedData: unknown = null;
  /** Obsidian sets this when the user turns the plugin off (not on an update): its leaves are detached on unload. */
  _userDisabled = false;
  constructor(app: App, manifest: PluginManifest) {
    super();
    this.app = app;
    this.manifest = manifest;
  }
  addCommand(command: Command): Command {
    this.commands.push(command);
    return command;
  }
  /** Test helper: the command registered with this id. */
  command(id: string): Command {
    const c = this.commands.find((x) => x.id === id);
    if (!c) throw new Error(`no command ${id}`);
    return c;
  }
  /**
   * Like Obsidian. Registering reopens placeholder leaves of this type (left by an earlier unload)
   * as this type, asynchronously. The cleanup (run on unload, before onunload) unregisters the type:
   * every leaf of it gets a placeholder and its view's close() starts synchronously (unawaited); then,
   * if the user turned the plugin off, the leaves are detached synchronously.
   */
  registerView(type: string, creator: (leaf: WorkspaceLeaf) => View): void {
    const ws = this.app.workspace;
    ws.viewCreators.set(type, creator);
    const waiting = ws.leaves.filter((l) => l.view instanceof PlaceholderView && l.view.type === type);
    if (waiting.length) {
      ws.viewsReopening = Promise.all(
        waiting.map((l) => {
          const state = (l.view as PlaceholderView).state;
          return Promise.resolve().then(() => l.setViewState({ type, state }));
        }),
      ).then(() => undefined);
    }
    this.register(() => {
      ws.viewCreators.delete(type);
      const leaves = ws.getLeavesOfType(type);
      const closing = leaves.map((l) => l.toPlaceholder(type));
      if (this._userDisabled) for (const l of leaves) void l.detach();
      ws.viewsClosing = Promise.all(closing).then(() => undefined);
    });
  }
  registerExtensions(_extensions: string[], _viewType: string): void {}
  /** Test helper: the hover link sources registered (for the Page preview core plugin). */
  hoverLinkSources = new Map<string, { display: string; defaultMod: boolean }>();
  registerHoverLinkSource(id: string, info: { display: string; defaultMod: boolean }): void {
    this.hoverLinkSources.set(id, info);
  }
  registerObsidianProtocolHandler(action: string, handler: (params: Record<string, string>) => any): void {
    this.protocolHandlers.set(action, handler);
  }
  addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => any): HTMLElement {
    const el = document.createElement('div');
    el.setAttribute('aria-label', title);
    el.addEventListener('click', callback);
    this.ribbonIcons.push({ icon, title, callback, el });
    return el;
  }
  addSettingTab(tab: PluginSettingTab): void {
    this.settingTabs.push(tab);
  }
  async loadData(): Promise<any> {
    return this.savedData;
  }
  async saveData(data: unknown): Promise<void> {
    this.savedData = JSON.parse(JSON.stringify(data));
  }
}

export class Modal {
  static opened: Modal[] = [];
  app: App;
  containerEl = document.createElement('div');
  modalEl = document.createElement('div');
  titleEl = document.createElement('div');
  contentEl = document.createElement('div');
  scope = new Scope();
  constructor(app: App) {
    this.app = app;
    this.modalEl.append(this.titleEl, this.contentEl);
    this.containerEl.appendChild(this.modalEl);
  }
  open(): void {
    document.body.appendChild(this.containerEl);
    Modal.opened.push(this);
    this.onOpen();
  }
  close(): void {
    const i = Modal.opened.indexOf(this);
    if (i >= 0) Modal.opened.splice(i, 1);
    this.containerEl.remove();
    this.onClose();
  }
  setTitle(title: string): this {
    this.titleEl.textContent = title;
    return this;
  }
  onOpen(): void {}
  onClose(): void {}
}

export abstract class FuzzySuggestModal<T> extends Modal {
  placeholder = '';
  setPlaceholder(placeholder: string): void {
    this.placeholder = placeholder;
  }
  abstract getItems(): T[];
  abstract getItemText(item: T): string;
  abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;
}

export class Notice {
  static messages: string[] = [];
  /** The duration of each Notice, in the order of `messages` (0 = stays until dismissed). */
  static durations: (number | undefined)[] = [];
  noticeEl = document.createElement('div');
  constructor(message: string | DocumentFragment, duration?: number) {
    Notice.messages.push(typeof message === 'string' ? message : (message.textContent ?? ''));
    Notice.durations.push(duration);
  }
  setMessage(message: string): this {
    Notice.messages.push(message);
    return this;
  }
  hide(): void {}
}

export class PluginSettingTab {
  app: App;
  plugin: Plugin;
  containerEl = document.createElement('div');
  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
  }
  display(): void {}
  hide(): void {}
}

export class TextComponent {
  inputEl = document.createElement('input');
  value = '';
  placeholder = '';
  private listeners: ((v: string) => any)[] = [];
  setValue(v: string): this {
    this.value = v;
    return this;
  }
  getValue(): string {
    return this.value;
  }
  setPlaceholder(p: string): this {
    this.placeholder = p;
    return this;
  }
  onChange(cb: (v: string) => any): this {
    this.listeners.push(cb);
    return this;
  }
  /** Test helper: the user types `v`. */
  async type(v: string): Promise<void> {
    this.value = v;
    for (const cb of this.listeners) await cb(v);
  }
}

export class ToggleComponent {
  value = false;
  private listeners: ((v: boolean) => any)[] = [];
  setValue(v: boolean): this {
    this.value = v;
    return this;
  }
  getValue(): boolean {
    return this.value;
  }
  onChange(cb: (v: boolean) => any): this {
    this.listeners.push(cb);
    return this;
  }
  /** Test helper: the user flips the toggle to `v`. */
  async toggle(v: boolean): Promise<void> {
    this.value = v;
    for (const cb of this.listeners) await cb(v);
  }
}

export class DropdownComponent {
  value = '';
  options: { value: string; label: string }[] = [];
  private listeners: ((v: string) => any)[] = [];
  addOption(value: string, label: string): this {
    this.options.push({ value, label });
    return this;
  }
  setValue(v: string): this {
    this.value = v;
    return this;
  }
  getValue(): string {
    return this.value;
  }
  onChange(cb: (v: string) => any): this {
    this.listeners.push(cb);
    return this;
  }
  /** Test helper: the user picks `v`. */
  async choose(v: string): Promise<void> {
    this.value = v;
    for (const cb of this.listeners) await cb(v);
  }
}

export class ButtonComponent {
  buttonEl = document.createElement('button');
  text = '';
  disabled = false;
  warning = false;
  private listeners: ((e: MouseEvent) => any)[] = [];
  setButtonText(t: string): this {
    this.text = t;
    this.buttonEl.textContent = t;
    return this;
  }
  setDisabled(d: boolean): this {
    this.disabled = d;
    this.buttonEl.disabled = d;
    return this;
  }
  setWarning(): this {
    this.warning = true;
    return this;
  }
  setCta(): this {
    return this;
  }
  onClick(cb: (e: MouseEvent) => any): this {
    this.listeners.push(cb);
    return this;
  }
  /** Test helper: the user clicks it (nothing happens while disabled). */
  async click(): Promise<void> {
    if (this.disabled) return;
    for (const cb of this.listeners) await cb(new MouseEvent('click'));
  }
}

export class Setting {
  static all: Setting[] = [];
  settingEl = document.createElement('div');
  name = '';
  desc = '';
  components: (TextComponent | ToggleComponent | DropdownComponent | ButtonComponent)[] = [];
  /** Whether setHeading() was called. */
  heading = false;
  constructor(containerEl: HTMLElement) {
    containerEl.appendChild(this.settingEl);
    Setting.all.push(this);
  }
  setName(name: string): this {
    this.name = name;
    return this;
  }
  setDesc(desc: string): this {
    this.desc = desc;
    return this;
  }
  setHeading(): this {
    this.heading = true;
    return this;
  }
  addDropdown(cb: (c: DropdownComponent) => any): this {
    const c = new DropdownComponent();
    this.components.push(c);
    cb(c);
    return this;
  }
  addButton(cb: (c: ButtonComponent) => any): this {
    const c = new ButtonComponent();
    this.components.push(c);
    cb(c);
    return this;
  }
  addText(cb: (c: TextComponent) => any): this {
    const c = new TextComponent();
    this.components.push(c);
    cb(c);
    return this;
  }
  addToggle(cb: (c: ToggleComponent) => any): this {
    const c = new ToggleComponent();
    this.components.push(c);
    cb(c);
    return this;
  }
}

export class MenuItem {
  title = '';
  icon = '';
  section = '';
  checked: boolean | null = null;
  setChecked(checked: boolean | null): this {
    this.checked = checked;
    return this;
  }
  handler: ((evt?: unknown) => any) | null = null;
  setTitle(title: string): this {
    this.title = title;
    return this;
  }
  setIcon(icon: string): this {
    this.icon = icon;
    return this;
  }
  setSection(section: string): this {
    this.section = section;
    return this;
  }
  onClick(cb: (evt?: unknown) => any): this {
    this.handler = cb;
    return this;
  }
}

export class Menu {
  /** Test helper: every menu shown, in order. */
  static shown: Menu[] = [];
  items: MenuItem[] = [];
  /** Where it was shown: the mouse event, or the position. */
  shownAt: MouseEvent | { x: number; y: number } | null = null;
  addItem(cb: (item: MenuItem) => any): this {
    const item = new MenuItem();
    cb(item);
    this.items.push(item);
    return this;
  }
  addSeparator(): this {
    return this;
  }
  private hideHandlers: (() => any)[] = [];
  onHide(cb: () => any): void {
    this.hideHandlers.push(cb);
  }
  /** Test helper: hides the menu like Obsidian does (runs the onHide callbacks). */
  hide(): this {
    for (const cb of this.hideHandlers) cb();
    return this;
  }
  showAtMouseEvent(evt: MouseEvent): this {
    this.shownAt = evt;
    Menu.shown.push(this);
    return this;
  }
  showAtPosition(position: { x: number; y: number }): this {
    this.shownAt = position;
    Menu.shown.push(this);
    return this;
  }
  /** Test helper: the item titled `title`. */
  item(title: string): MenuItem {
    const found = this.items.find((i) => i.title === title);
    if (!found) throw new Error(`no menu item ${title}`);
    return found;
  }
}

/**
 * Test helper: a 2D canvas for jsdom (which has none). `getContext('2d')` records what was drawn, and
 * `toBlob` hands back `type` (default: the type asked for) with bytes naming the canvas size. Returns the undo.
 */
export function __installCanvas(opts: { type?: string | null; noContext?: boolean } = {}): () => void {
  const proto = HTMLCanvasElement.prototype as any;
  const saved = { getContext: proto.getContext, toBlob: proto.toBlob };
  proto.getContext = function (this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d' || opts.noContext) return null;
    return { fillStyle: '', fillRect: () => {}, canvas: this };
  };
  proto.toBlob = function (this: HTMLCanvasElement, cb: (b: Blob | null) => void, type?: string, quality?: number) {
    const t = opts.type === undefined ? (type ?? 'image/png') : opts.type;
    const w = this.width;
    const h = this.height;
    setTimeout(() => cb(t === null ? null : new Blob([`${w}x${h}@${quality}`], { type: t })), 0);
  };
  return () => {
    proto.getContext = saved.getContext;
    proto.toBlob = saved.toBlob;
  };
}

type ScopeFn = (evt: KeyboardEvent, info: { modifiers: string | null; key: string | null }) => false | any;
interface ScopeHandler {
  scope: Scope;
  modifiers: string[] | null;
  key: string | null;
  func: ScopeFn;
}
/**
 * Like Obsidian's Scope: handlers run in registration order; `null` modifiers or key match anything.
 * The first handler returning anything but undefined ends the search (false: preventDefault and
 * stopPropagation); if none does, the parent scope gets the key.
 */
export class Scope {
  readonly parent: Scope | undefined;
  readonly handlers: ScopeHandler[] = [];
  constructor(parent?: Scope) {
    this.parent = parent;
  }
  register(modifiers: string[] | null, key: string | null, func: ScopeFn): ScopeHandler {
    const h = { scope: this, modifiers, key, func };
    this.handlers.push(h);
    return h;
  }
  unregister(handler: ScopeHandler): void {
    const i = this.handlers.indexOf(handler);
    if (i >= 0) this.handlers.splice(i, 1);
  }
  handleKey(evt: KeyboardEvent): unknown {
    const held = [evt.metaKey && 'Meta', evt.ctrlKey && 'Ctrl', evt.altKey && 'Alt', evt.shiftKey && 'Shift'].filter(Boolean).sort().join(',');
    for (const h of [...this.handlers]) {
      // macOS (Platform.isMacOS): Mod is Meta.
      const mods = h.modifiers?.map((m) => (m === 'Mod' ? 'Meta' : m)).sort().join(',');
      if (mods !== undefined && mods !== held) continue;
      if (h.key !== null && h.key.toLowerCase() !== evt.key.toLowerCase()) continue;
      const r = h.func(evt, { modifiers: held || null, key: evt.key });
      // Like Obsidian: only a catch-all (null, null) registration that returns undefined passes the key
      // on; a keyed or modifier registration ends the lookup, whatever it returns.
      if (r === undefined && h.key === null && h.modifiers === null) continue;
      if (r === false) {
        evt.preventDefault();
        evt.stopPropagation();
      }
      return r;
    }
    return this.parent?.handleKey(evt);
  }
}

export const Platform = { isDesktop: true, isDesktopApp: true, isMobile: false, isMacOS: true };

let pdfjsLib: unknown = { fake: 'pdfjs' };
let pdfjsError: unknown = null;
export async function loadPdfJs(): Promise<any> {
  if (pdfjsError) throw pdfjsError;
  return pdfjsLib;
}
/** Test helper: loadPdfJs() rejects with `e` (null: it resolves again). */
export function __failPdfJs(e: unknown): void {
  pdfjsError = e;
}

/** The quit event's task list: Obsidian waits for every task before it closes. */
export class Tasks {
  private tasks: (() => Promise<any>)[] = [];
  private promises: Promise<any>[] = [];
  add(callback: () => Promise<any>): void {
    this.tasks.push(callback);
  }
  addPromise(promise: Promise<any>): void {
    this.promises.push(promise);
  }
  isEmpty(): boolean {
    return this.tasks.length === 0 && this.promises.length === 0;
  }
  /** Test helper: runs the tasks and waits for everything, as Obsidian does before quitting. */
  async run(): Promise<void> {
    await Promise.all([...this.tasks.map((t) => t()), ...this.promises]);
  }
}
/** Test helper: what loadPdfJs() resolves to. */
export function __setPdfJs(lib: unknown): void {
  pdfjsLib = lib;
}

/** A simple stand-in for Obsidian's fuzzy search: the query's characters in order, case-insensitive; tighter and earlier is better. */
export function prepareFuzzySearch(query: string): (text: string) => { score: number; matches: [number, number][] } | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  return (text: string) => {
    const t = text.toLowerCase();
    let at = -1;
    let first = -1;
    for (const c of q) {
      at = t.indexOf(c, at + 1);
      if (at < 0) return null;
      if (first < 0) first = at;
    }
    return { score: -(at - first) - first * 0.1, matches: [] };
  };
}

export function setIcon(_el: HTMLElement, _icon: string): void {}

/** Like Obsidian's Keymap.isModEvent: Mod (⌘ on macOS, Ctrl elsewhere; both here) → 'tab', +Alt → 'split', +Alt+Shift → 'window'. */
export class Keymap {
  static isModEvent(evt?: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean } | null): 'tab' | 'split' | 'window' | boolean {
    if (!evt || !(evt.metaKey || evt.ctrlKey)) return false;
    if (evt.altKey) return evt.shiftKey ? 'window' : 'split';
    return 'tab';
  }
}
