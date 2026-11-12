import { ItemView, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Location } from '../../../src/lib/types';
import { Shelf, ShelfBoundary, type OpenIn, type ShelfSource, type ShelfState, type ShelfVisibility } from './Shelf';

/** Kept from before the rename to Readside: workspace.json names it (see identity.ts). */
export const SHELF_VIEW_TYPE = 'margin-shelf';
export const SHELF_TITLE = 'Readside shelf';

/** What the shelf needs from the plugin. */
export interface ShelfHost {
  source: ShelfSource;
  /** Resolves once the store has loaded. */
  ready: () => Promise<void>;
  /** `openIn` false: in the shelf's own tab; a pane type: a new one. */
  openBook(path: string, location: Location | null, openIn?: OpenIn): void;
  pickPdf(): void;
}

const readState = (state: unknown): ShelfState => {
  const s = (state ?? {}) as { query?: unknown; scroll?: unknown };
  const query = typeof s.query === 'string' ? s.query : '';
  const scroll = typeof s.scroll === 'number' && Number.isFinite(s.scroll) && s.scroll > 0 ? s.scroll : 0;
  return { query, scroll };
};

/** Every book Margin knows, with search and what you wrote lately (plugin only). */
export class ShelfView extends ItemView {
  private readonly host: ShelfHost;
  private root: Root | null = null;
  /** The search and scroll, for Back (getState / setState). */
  private shelfState: ShelfState = { query: '', scroll: 0 };
  /** Bumped when setState restores a different state: the shelf starts again from it. */
  private restored = 0;
  private ready: Promise<void> | null = null;
  /** The first render waits a tick, so a state restored right after onOpen is the one it starts from (one mount). */
  private firstRender: ReturnType<typeof setTimeout> | null = null;
  private readonly showListeners = new Set<() => void>();
  /** On screen: the active leaf, or (in Obsidian) a leaf whose container is shown, as a tab beside another. */
  private readonly visibility: ShelfVisibility = {
    visible: () => {
      if (this.app.workspace.getActiveViewOfType(ShelfView) === this) return true;
      const el = this.containerEl as HTMLElement & { isShown?: () => boolean };
      return typeof el.isShown === 'function' && el.isConnected && el.isShown();
    },
    onShow: (listener) => {
      this.showListeners.add(listener);
      return () => void this.showListeners.delete(listener);
    },
  };

  constructor(leaf: WorkspaceLeaf, host: ShelfHost) {
    super(leaf);
    this.host = host;
    // Opening a book replaces the shelf in its tab; Back comes back to it, with its search and scroll.
    this.navigation = true;
  }

  getViewType(): string {
    return SHELF_VIEW_TYPE;
  }
  getDisplayText(): string {
    return SHELF_TITLE;
  }
  getIcon(): string {
    return 'book-open';
  }

  getState(): Record<string, unknown> {
    return { ...super.getState(), query: this.shelfState.query, scroll: this.shelfState.scroll };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const next = readState(state);
    if (next.query !== this.shelfState.query || next.scroll !== this.shelfState.scroll) {
      this.shelfState = next;
      // Before the first render the state is simply what it starts from; after it, the shelf starts again.
      if (this.firstRender === null) {
        this.restored++;
        this.render();
      }
    }
    await super.setState(state, result);
  }

  async onOpen(): Promise<void> {
    const el = document.createElement('div');
    el.className = 'margin-app';
    el.setAttribute('data-margin-shelf', '');
    this.contentEl.replaceChildren(el);
    this.root = createRoot(el);
    this.ready = this.host.ready();
    const announce = () => {
      for (const l of [...this.showListeners]) l();
    };
    // A tab switch or a layout change may bring the shelf on screen: a refresh it postponed runs then.
    this.registerEvent(this.app.workspace.on('active-leaf-change', announce));
    this.registerEvent(this.app.workspace.on('layout-change', announce));
    this.firstRender = setTimeout(() => {
      this.firstRender = null;
      this.render();
    }, 0);
  }

  private render(): void {
    if (!this.root || !this.ready) return;
    const { source } = this.host;
    this.root.render(
      <StrictMode>
        <ShelfBoundary>
          <Shelf
            key={this.restored}
            source={source}
            ready={this.ready}
            visibility={this.visibility}
            initialState={this.shelfState}
            onStateChange={(s) => void (this.shelfState = s)}
            onOpen={(path, loc, openIn) => this.host.openBook(path, loc, openIn)}
            onPick={() => this.host.pickPdf()}
          />
        </ShelfBoundary>
      </StrictMode>,
    );
  }

  async onClose(): Promise<void> {
    if (this.firstRender !== null) clearTimeout(this.firstRender);
    this.firstRender = null;
    this.root?.unmount();
    this.root = null;
    this.showListeners.clear();
    this.contentEl.replaceChildren();
  }
}
