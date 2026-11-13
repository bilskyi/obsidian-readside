import { FileView, Menu, Notice, Scope, type HoverParent, type HoverPopover, type TFile, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import { StrictMode, useLayoutEffect, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushAll, flushAllBounded } from '../../../src/features/notebook/editorRegistry';
import {
  OPENING_DELAY_MS,
  ReaderOpenFailed,
  ReaderOpening,
  StatusRegion,
  openingAnnouncement,
  useShownAfter,
} from '../../../src/features/reader/ReaderState';
import type { Backlink } from '../../../src/features/marginalia/backlinks';
import type { LinkSuggestSource } from '../../../src/features/notebook/linkSuggest';
import type { PageMenuItem } from '../../../src/features/reader/pageMenuItems';
import { ReaderView, type NavRequest, type ReaderCommandRunner } from '../../../src/features/reader/ReaderView';
import { REPEATABLE, REPEAT_THROTTLE_MS, THROTTLED } from '../../../src/features/reader/useReaderShortcuts';
import { isEditable, readerCommand, type ReaderCommand } from '../../../src/lib/keys';
import { pageLocation, parseLocation, placeName, serializeLocation, spotOf } from '../../../src/lib/location';
import { openEpub } from '../../../src/renderers/epub/epubPackage';
import { quoteWithLink } from '../../../src/lib/quote';
import { displayTitle, hasOwnTitle } from '../../../src/lib/titles';
import type { Book, Location } from '../../../src/lib/types';
import type { TranslateHost } from '../../../src/translate/types';
import { markdownLink } from '../links';
import { MarginError } from '../store/errors';

/** Kept from before the rename to Readside: workspace.json names it (see identity.ts). */
export const VIEW_TYPE = 'margin-reader';
/** Obsidian's own PDF view type (app.js: Fhe="pdf"). */
export const OBSIDIAN_PDF_VIEW = 'pdf';
export const OPEN_IN_OBSIDIAN = "Open in Obsidian's viewer";

/**
 * The page's right-click menu as Obsidian's own Menu: the reader's items, with their icons. Obsidian's
 * public Menu has no row of swatches, so "Highlight" is yellow here (the popover's 1–5 give the others).
 * The items are built from the live selection inside the `contextmenu` event, so the menu shows at once.
 */
export function showPageMenu(event: MouseEvent, items: readonly PageMenuItem[], onClose?: () => void): Menu {
  const menu = new Menu();
  for (const item of items) {
    menu.addItem((m) => m.setTitle(item.label).setIcon(item.icon).onClick(() => item.onSelect()));
  }
  // The reader keeps its selection popover away until the menu goes.
  if (onClose) menu.onHide(onClose);
  menu.showAtMouseEvent(event);
  return menu;
}

/** "Copy quote with link": the quote as a Markdown blockquote, then the obsidian:// link to it. */
export async function copyQuoteWithLink(file: TFile, location: Location, quote: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(quoteWithLink(quote, markdownLink(file.path, location, null)));
  } catch (e) {
    throw new MarginError(`Readside couldn't copy the quote: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** What a book file says about itself (an EPUB's OPF): kept on a new book only. */
export interface BookMeta {
  title?: string | null;
  author?: string | null;
}

const isEpubFile = (file: TFile) => file.extension.toLowerCase() === 'epub';

/** An EPUB's title and author from its OPF; null when it can't be read (the file name then names the book). */
export function epubMeta(bytes: ArrayBuffer): BookMeta | null {
  try {
    const pkg = openEpub(bytes);
    return { title: pkg.title, author: pkg.creator };
  } catch {
    return null;
  }
}

/** What the view needs from the plugin. */
export interface MarginHost {
  /**
   * The book for a vault PDF or EPUB (created on first open). `meta` names a new book; it is called only
   * when the book is new, so a reopen doesn't read the EPUB's OPF again.
   */
  openBook(file: TFile, bytes: ArrayBuffer, meta?: () => BookMeta | null): Promise<Book>;
  /** The current book record (after a rename, say). */
  book(bookId: string): Book | null;
  /** The view let go of the book: write what is pending. */
  closed(bookId: string): Promise<void>;
  /** Writes a Markdown link to the clipboard (O9). */
  copyLink?: (file: TFile, location: Location, quote: string | null) => Promise<void>;
  /** A view was constructed: the plugin keeps it until viewEnded, to release it on unload or quit. */
  viewStarted?: (view: MarginView) => void;
  /** The view has closed and everything its teardown started has finished. */
  viewEnded?: (view: MarginView) => void;
  /** Shows `file` in Obsidian's own PDF viewer in `leaf` (and keeps "Open PDFs in Margin" from taking it back). */
  openInObsidian?: (leaf: WorkspaceLeaf, file: TFile) => Promise<void>;
  /**
   * The book's notebook note, if it exists in the vault, and whether notebook notes are on. `moved`: a note
   * was written for the book once, but that file is no longer in the vault.
   */
  notebookNote?: (file: TFile) => Promise<{ path: string | null; enabled: boolean; moved?: boolean }>;
  /** Vault notes for a `[[` typed in a thought editor. */
  linkSuggest?: LinkSuggestSource;
  /** Calls `onChange` with the notes linking into `file` (soon, then on every change); returns the stop. */
  watchBacklinks?: (file: TFile, onChange: (links: Backlink[]) => void) => () => void;
  /** Opens a linking note (beside the reader; in a new tab with `newTab`). */
  openBacklink?: (view: MarginView, link: Backlink, newTab: boolean) => void;
  /** The pointer is over a linking note's row in `view`: Obsidian's page preview may show the note. */
  hoverBacklink?: (view: MarginView, link: Backlink, event: MouseEvent, targetEl: HTMLElement) => void;
  /** Shows Margin's shelf (the reader's Shelf button and the tab header's action). */
  openShelf?: () => void;
  /** The reader knows how many pages the book has (the shelf shows "p. N of M"). */
  pageCount?: (bookId: string, pageCount: number) => void;
  /**
   * The plugin's translate host: the same object on every call (the card's effects depend on its
   * identity), null once the plugin is unloading. Without it the reader has no Translate.
   */
  translate?: () => TranslateHost | null;
}

const NO_BACKLINKS: Backlink[] = [];

/** The text of the view's one status region: kept by the view, so it lives across Pending and the reader. */
class StatusText {
  private text = '';
  private listeners = new Set<() => void>();
  get = () => this.text;
  set = (text: string) => {
    if (text === this.text) return;
    this.text = text;
    for (const l of this.listeners) l();
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
}

function LiveStatus({ status }: { status: StatusText }) {
  return <StatusRegion text={useSyncExternalStore(status.subscribe, status.get)} />;
}

/**
 * The page area before the reader mounts (the store and pdf.js loading): after a moment, the title and
 * "Opening…", where the reader's own opening state will be (below a bar the size of its toolbar).
 */
function Pending({ title, onShown }: { title: string; onShown: () => void }) {
  const shown = useShownAfter(true, OPENING_DELAY_MS);
  useLayoutEffect(() => {
    if (shown) onShown();
  }, [shown, onShown]);
  if (!shown) return null;
  return (
    <div className="reader">
      <div className="reader-bar" aria-hidden="true" />
      <div className="reader-body">
        <div className="reader-column">
          <ReaderOpening title={title} />
        </div>
      </div>
    </div>
  );
}

/** True when `loc` is the location `stored` (Location JSON) holds. */
function sameLocation(loc: Location, stored: string | null): boolean {
  const s = stored ? parseLocation(stored) : null;
  return !!s && serializeLocation(s) === serializeLocation(loc);
}


const SHELF_TOOLTIP = 'Open Readside shelf';
/** The reader's back button goes to the shelf here: Obsidian has no Library screen. */
const SHELF_BUTTON = { label: 'Shelf', title: SHELF_TOOLTIP, icon: 'library' } as const;

/** A vault PDF in the Margin reader (spec §4). State: `{ file, loc? }`, `loc` being Location JSON. */
export class MarginView extends FileView implements HoverParent {
  readonly host: MarginHost;
  /** Obsidian's page preview keeps the popover it shows for a hovered backlink here. */
  hoverPopover: HoverPopover | null = null;
  /** Filled by ReaderView while mounted; the plugin's commands run through it. */
  readonly commands: { current: ReaderCommandRunner | null } = { current: null };
  private root: Root | null = null;
  private rootEl: HTMLDivElement | null = null;
  private book: Book | null = null;
  /** Bumped when the notes hub writes this book's thoughts: the reader reloads them. */
  private externalEdits = 0;
  private error: string | null = null;
  /** The page-level location on screen, kept by ReaderView while mounted ("Copy link to this page"). */
  readonly location: { current: Location | null } = { current: null };
  /** When each THROTTLED command last ran from outside the root (held keys step at the root's rate). */
  private lastRun = new Map<ReaderCommand, number>();
  private nav: NavRequest | null = null;
  private navSeq = 0;
  private pendingLoc: Location | null = null;
  /** pendingLoc came from navigate (a link, a command), not from a view state: it jumps even to the stored position. */
  private pendingExplicit = false;
  /** Bumped by every load, unmount and close: a load that finds it changed after an await is stale. */
  private loadSeq = 0;
  /** Unmounts waiting for their editor flush; release() finishes them at once. */
  private closings = new Set<{ root: Root; rootEl: HTMLDivElement | null; book: Book | null }>();
  /** Teardowns (and stale-load hand-backs) whose host.closed has not finished yet. */
  private teardowns = new Set<Promise<void>>();
  /** Set by the first onClose: later calls join it. */
  private ending: Promise<void> | null = null;
  /** release() ran: the plugin is going, nothing mounts again. */
  private released = false;
  /** The one status region's text ("Opening <title>…"), across Pending and the reader. */
  private readonly status = new StatusText();
  /** Pending's "Opening…" is on screen: the reader shows its own at once, so the hand-over doesn't blink. */
  private pendingShown = false;
  /** Notes linking into the open book; kept while the reader is mounted, empty otherwise. */
  private backlinks: Backlink[] = NO_BACKLINKS;
  /** Stops the backlink watch of the mounted book (null: none). */
  private stopBacklinks: (() => void) | null = null;
  private readonly onPendingShown = () => {
    this.pendingShown = true;
    this.status.set(openingAnnouncement(this.getDisplayText()));
  };

  constructor(leaf: WorkspaceLeaf, host: MarginHost) {
    super(leaf);
    this.host = host;
    this.navigation = true;
    // Obsidian's Keymap listens on window in the capture phase and asks the active leaf's view scope
    // first (then app.scope, the hotkeys). So the reader's keys are claimed here, before any hotkey runs,
    // and they work while this leaf is active even when DOM focus is elsewhere (body, file explorer).
    this.scope = new Scope(this.app.scope);
    this.scope.register(null, null, (evt) => this.onScopeKey(evt));
    // The way back to the shelf from the tab header: there in focus mode too, and before the book opens.
    const openShelf = host.openShelf;
    if (openShelf) this.addAction('library', SHELF_TOOLTIP, () => openShelf());
    host.viewStarted?.(this);
  }

  /**
   * undefined: not the reader's key, Obsidian's hotkeys proceed. true: the root's own listener (bubble
   * phase, with its repeat and throttle rules) handles it; Obsidian yields. false: run here (focus is
   * outside the root); Obsidian then preventDefaults and stops the event.
   */
  private onScopeKey(evt: KeyboardEvent): boolean | undefined {
    const run = this.commands.current;
    if (!run) return undefined;
    const inRoot = !!this.rootEl && this.rootEl.contains(evt.target as Node | null);
    // A bare Esc with focus outside the root (body, explorer) leaves focus mode: the root's own listener
    // never hears it there. Claimed (false) only when it does leave; otherwise it stays Obsidian's.
    if (evt.key === 'Escape') {
      if (inRoot || evt.defaultPrevented || evt.isComposing || isEditable(evt.target)) return undefined;
      if (evt.metaKey || evt.ctrlKey || evt.altKey || evt.shiftKey || !run('leaveFocus', true)) return undefined;
      run('leaveFocus');
      return false;
    }
    // Outside the root (body, explorer, a tab header) the active reader's page is the page area, but a
    // text field anywhere keeps its keys: an editable target goes to readerCommand as it is.
    const cmd = readerCommand(
      inRoot || isEditable(evt.target)
        ? evt
        : { key: evt.key, code: evt.code, metaKey: evt.metaKey, ctrlKey: evt.ctrlKey, altKey: evt.altKey, shiftKey: evt.shiftKey, target: null },
    );
    if (!cmd || !run(cmd, true)) return undefined;
    if (inRoot) return true;
    if (evt.repeat && !REPEATABLE.has(cmd)) return false;
    if (THROTTLED.has(cmd)) {
      const now = Date.now();
      if (evt.repeat && now - (this.lastRun.get(cmd) ?? -Infinity) < REPEAT_THROTTLE_MS) return false;
      this.lastRun.set(cmd, now);
    }
    // With the key: an EPUB's PageDown then scrolls a screen, as it does with focus in the root.
    run(cmd, false, evt);
    return false;
  }

  /**
   * Obsidian hands `{ focus: true }` here when it opens a file in a leaf (the explorer, the quick
   * switcher, a link), including the leaf that is already active, where no active-leaf-change follows.
   */
  setEphemeralState(state: unknown): void {
    super.setEphemeralState(state);
    if (!(state && typeof state === 'object' && (state as { focus?: unknown }).focus)) return;
    const el = this.rootEl;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  }

  async onOpen(): Promise<void> {
    await super.onOpen();
    // Opened from the explorer or the quick switcher, focus stays there: give the reader the keyboard.
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        const el = this.rootEl;
        if (leaf !== this.leaf || !el || el.contains(document.activeElement)) return;
        el.focus({ preventScroll: true });
      }),
    );
  }

  getViewType(): string {
    return VIEW_TYPE;
  }
  getIcon(): string {
    return 'book-open';
  }
  getDisplayText(): string {
    // A title of the book's own wins; otherwise the file's name made readable, read from the file so the
    // header is right at once after a rename (before refreshBook re-reads the book).
    if (this.book && hasOwnTitle(this.book)) return this.book.title!.trim();
    return this.file ? displayTitle(this.file.basename) || this.file.basename : 'Readside';
  }
  canAcceptExtension(extension: string): boolean {
    const ext = extension.toLowerCase();
    return ext === 'pdf' || ext === 'epub';
  }

  /** Obsidian's own viewer can show this file (it has none for EPUB). */
  private hasObsidianViewer(): boolean {
    return !!this.file && !isEpubFile(this.file);
  }

  // Only `{ file }`: Obsidian saves this on layout changes (and before closing views in a plugin update),
  // not on scroll, so a `loc` here would be stale. The book's own lastLocation is where a reopened view starts.
  // setState still accepts `loc` for explicit jumps (links, takeOver, navigate).
  getState(): Record<string, unknown> {
    return super.getState();
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const raw = state && typeof state === 'object' ? (state as { loc?: unknown }).loc : undefined;
    const location = typeof raw === 'string' ? parseLocation(raw) : null;
    if (location) {
      this.pendingLoc = location;
      this.pendingExplicit = false;
    }
    await super.setState(state, result);
    // The same file was already open, so nothing reloaded: jump now.
    if (this.pendingLoc && this.book) {
      const loc = this.pendingLoc;
      this.pendingLoc = null;
      this.navigate(loc);
    }
  }

  async onLoadFile(file: TFile): Promise<void> {
    const seq = ++this.loadSeq;
    this.unwatchBacklinks();
    // Closed, or switched to another file, while this load was waiting: let go of what it opened.
    const stale = () => seq !== this.loadSeq || this.file !== file;
    this.error = null;
    // The page area shows a quiet "Opening…" (after a moment) while the store and pdf.js load.
    if (!this.book) this.mount();
    let book: Book | null = null;
    let error: string | null = null;
    try {
      const bytes = await this.app.vault.readBinary(file);
      if (stale()) return;
      // An EPUB names itself (OPF title and author), read only for a new book; a failure falls back to the file name.
      book = isEpubFile(file) ? await this.host.openBook(file, bytes, () => epubMeta(bytes)) : await this.host.openBook(file, bytes);
    } catch (e) {
      error = String(e);
    }
    if (stale()) {
      if (book) this.track(this.host.closed(book.id));
      return;
    }
    this.book = book;
    this.error = error;
    // A restored workspace hands back the book's own last location: the reader opens there anyway, no jump.
    // An explicit jump (navigate) always goes, with its flash.
    if (book && this.pendingLoc && (this.pendingExplicit || !sameLocation(this.pendingLoc, book.lastLocation))) {
      this.nav = { id: ++this.navSeq, location: this.pendingLoc };
    }
    // Cleared on the error path too: a jump into a file that failed to open is dropped, not carried into the next load.
    this.pendingLoc = null;
    this.pendingExplicit = false;
    if (book) this.watchBacklinks(file);
    this.mount();
  }

  /** Follows the notes linking into `file` while its book is mounted; never holds up the opening. */
  private watchBacklinks(file: TFile): void {
    this.unwatchBacklinks();
    const watch = this.host.watchBacklinks;
    if (!watch || this.released || this.ending) return;
    let live = true;
    const stop = watch(file, (links) => {
      if (!live || this.stopBacklinks !== stopRef) return;
      this.backlinks = links.length ? links : NO_BACKLINKS;
      this.render();
    });
    const stopRef = () => {
      live = false;
      stop();
    };
    this.stopBacklinks = stopRef;
  }

  private unwatchBacklinks(): void {
    const stop = this.stopBacklinks;
    this.stopBacklinks = null;
    this.backlinks = NO_BACKLINKS;
    stop?.();
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    await this.unmount();
  }

  /**
   * Obsidian calls this from View.close (the leaf detaches, switches type, or the view type is
   * unregistered). The reader's own teardown runs first; FileView.onClose then unloads the file, and
   * that onUnloadFile finds nothing mounted. A second call joins the first.
   */
  async onClose(): Promise<void> {
    if (!this.ending) {
      this.ending = (async () => {
        this.loadSeq++;
        await this.unmount();
        await this.settled();
        this.host.viewEnded?.(this);
      })();
    }
    await this.ending;
    await super.onClose();
  }

  /**
   * The plugin is unloading (or Obsidian quitting): tear down now, synchronously, while the vault
   * backend is still installed. Unsent thought text is sent (flushAll), and unmounting runs the
   * reader's cleanups, which write the reading position and zoom; the host then writes the book. An
   * unmount already waiting on its flush (a close in flight) is finished here, not run twice. Resolves
   * once every host.closed this view started has finished; the plugin waits for that before it writes
   * the store and uninstalls the backend. A later onClose finds nothing left to do.
   */
  release(): Promise<void> {
    this.released = true;
    this.loadSeq++;
    this.unwatchBacklinks();
    const closings = [...this.closings];
    this.closings.clear();
    for (const c of closings) this.teardown(c.root, c.rootEl, c.book);
    const root = this.root;
    if (root) {
      const rootEl = this.rootEl;
      const book = this.book;
      this.root = null;
      this.rootEl = null;
      void flushAll();
      this.teardown(root, rootEl, book);
    }
    return this.settled().then(() => this.host.viewEnded?.(this));
  }

  /** Resolves once every teardown started so far has finished. */
  private async settled(): Promise<void> {
    while (this.teardowns.size) await Promise.all([...this.teardowns]);
  }

  private track(closed: Promise<void>): void {
    const p = closed.catch((e) => console.error('margin: closing the book failed', e));
    this.teardowns.add(p);
    void p.then(() => this.teardowns.delete(p));
  }

  onPaneMenu(menu: Menu, source: 'more-options' | 'tab-header' | string): void {
    super.onPaneMenu(menu, source);
    if (!this.file) return;
    if (this.hasObsidianViewer()) {
      menu.addItem((item) =>
        item.setTitle(OPEN_IN_OBSIDIAN).setIcon('file-text').setSection('open').onClick(() => void this.openInObsidian()),
      );
    }
    menu.addItem((item) =>
      item.setTitle('Open notebook note').setIcon('notebook-pen').setSection('open').onClick(() => void this.openNotebookNote()),
    );
    if (this.host.copyLink) {
      const label = isEpubFile(this.file) ? 'Copy link to this section' : 'Copy link to this page';
      menu.addItem((item) =>
        item.setTitle(label).setIcon('link').setSection('action').onClick(() => void this.copyPageLink()),
      );
    }
  }

  /** Switches this leaf to Obsidian's own PDF viewer for the same file. */
  async openInObsidian(): Promise<void> {
    const file = this.file;
    if (!file || !this.hasObsidianViewer()) return;
    if (this.host.openInObsidian) await this.host.openInObsidian(this.leaf, file);
    else await this.leaf.setViewState({ type: OBSIDIAN_PDF_VIEW, state: { file: file.path }, active: true });
  }

  /** Opens the book's notebook note in a new tab, or says why there is none yet. */
  async openNotebookNote(): Promise<void> {
    const file = this.file;
    if (!file || !this.host.notebookNote) return;
    const { path, enabled, moved } = await this.host.notebookNote(file);
    const note = path ? this.app.vault.getFileByPath(path) : null;
    if (note) {
      await this.app.workspace.getLeaf('tab').openFile(note);
      return;
    }
    if (!enabled) new Notice('Readside: notebook notes are turned off in settings.');
    else if (moved) new Notice("Readside: the notebook note was moved or deleted; it's rewritten on your next change.");
    else new Notice('Readside: this book has no notebook note yet. It appears after your first highlight or thought.');
  }

  /** Writes a Markdown link to the page on screen to the clipboard. */
  async copyPageLink(): Promise<void> {
    const file = this.file;
    const copyLink = this.host.copyLink;
    const here = this.location.current;
    if (!file || !copyLink) return;
    if (!here) {
      new Notice('Readside: the book is still opening, so there is no page to link to yet.');
      return;
    }
    const location = pageLocation(here);
    try {
      await copyLink(file, location, null);
      const spot = spotOf(location);
      const where = !spot ? null : location.kind === 'pdf' ? `page ${spot.page}` : placeName(location);
      new Notice(where ? `Readside: link to ${where} copied.` : 'Readside: link copied.');
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e));
    }
  }

  /** Jumps to `location` with a flash; before the book has opened, once it has. */
  navigate(location: Location): void {
    if (!this.book) {
      // The load failed: there is no page to jump to, and a jump kept for later would land in whatever
      // file this leaf loads next.
      if (this.error) {
        this.pendingLoc = null;
        this.pendingExplicit = false;
        return;
      }
      this.pendingLoc = location;
      this.pendingExplicit = true;
      return;
    }
    this.nav = { id: ++this.navSeq, location };
    this.render();
  }

  /** Re-reads the book record (after a rename) and re-renders. */
  refreshBook(): void {
    if (!this.book) return;
    this.book = this.host.book(this.book.id) ?? this.book;
    this.render();
  }

  private mount(): void {
    if (this.released || this.ending) return;
    if (!this.rootEl) {
      // A fresh page area: nothing on screen yet, nothing said.
      this.pendingShown = false;
      this.status.set('');
      const el = document.createElement('div');
      el.className = 'margin-app';
      // Focusable, so a click on the page gives the view the keyboard; inPageArea treats it as the page.
      el.tabIndex = -1;
      el.setAttribute('data-margin-root', '');
      this.contentEl.replaceChildren(el);
      this.rootEl = el;
      this.root = createRoot(el);
    }
    this.render();
  }

  /** The book this view shows, once open. */
  get bookId(): string | null {
    return this.book?.id ?? null;
  }

  /** Its thoughts were written elsewhere (the notes hub): the reader reads them again. */
  externalEdit(): void {
    this.externalEdits++;
    this.render();
  }

  private render(): void {
    if (!this.root) return;
    // The status region first, always: React keeps it mounted whatever follows it.
    this.root.render(
      <>
        <LiveStatus key="status" status={this.status} />
        {this.content()}
      </>,
    );
  }

  private content() {
    const book = this.book;
    const file = this.file;
    const title = this.getDisplayText();
    if (!book) {
      if (this.error !== null && file) {
        // The failure is an alert of its own; the opening status has nothing more to say.
        this.status.set('');
        return (
          <ReaderOpenFailed
            key="failed"
            title={title}
            error={{
              message: this.hasObsidianViewer()
                ? `Readside couldn't open ${file.path}. Try opening it again, or use Obsidian's viewer.`
                : `Readside couldn't open ${file.path}. Try opening it again.`,
              detail: this.error,
            }}
            retry={{ label: 'Try again', onRetry: () => void this.retry() }}
            openElsewhere={this.hasObsidianViewer() ? { label: OPEN_IN_OBSIDIAN, onOpen: () => void this.openInObsidian() } : undefined}
          />
        );
      }
      return <Pending key="pending" title={title} onShown={this.onPendingShown} />;
    }
    const copyLink = this.host.copyLink;
    const openBacklink = this.host.openBacklink;
    const hoverBacklink = this.host.hoverBacklink;
    return (
      <StrictMode key="reader">
        <ReaderView
          key={book.id}
          book={book}
          nav={this.nav}
          commands={this.commands}
          hostKeys={this.rootEl ?? 'window'}
          showTitle={false}
          locationRef={this.location}
          onBack={this.host.openShelf}
          backButton={SHELF_BUTTON}
          onCopyLink={copyLink && file ? (location, quote) => copyLink(file, location, quote) : undefined}
          onOpenElsewhere={this.hasObsidianViewer() ? () => void this.openInObsidian() : undefined}
          openElsewhereLabel={OPEN_IN_OBSIDIAN}
          openingDelayMs={this.pendingShown ? 0 : undefined}
          announce={this.status.set}
          linkSuggest={this.host.linkSuggest}
          backlinks={this.backlinks}
          onOpenBacklink={openBacklink ? (link, newTab) => openBacklink(this, link, newTab) : undefined}
          onHoverBacklink={hoverBacklink ? (link, event, el) => hoverBacklink(this, link, event, el) : undefined}
          onPageCount={this.host.pageCount ? (n) => this.host.pageCount?.(book.id, n) : undefined}
          onPageMenu={showPageMenu}
          onCopyQuote={file ? (location, quote) => copyQuoteWithLink(file, location, quote) : undefined}
          translate={this.host.translate?.() ?? undefined}
          externalEdits={this.externalEdits}
        />
      </StrictMode>
    );
  }

  /** "Try again" after a failed open: loads the file again in this leaf (a fresh opening state, then the reader). */
  async retry(): Promise<void> {
    const file = this.file;
    if (!file || this.released || this.ending) return;
    this.error = null;
    this.pendingShown = false;
    this.render();
    await this.onLoadFile(file);
  }

  /** Saves unsent thought text, unmounts, then lets the host write the book. Safe to call twice. */
  private async unmount(): Promise<void> {
    this.loadSeq++;
    this.unwatchBacklinks();
    if (!this.root) return;
    // Taken synchronously, so a load that starts meanwhile mounts into a fresh element.
    const closing = { root: this.root, rootEl: this.rootEl, book: this.book };
    this.root = null;
    this.rootEl = null;
    this.book = null;
    this.closings.add(closing);
    await flushAllBounded().catch(() => {});
    if (!this.closings.delete(closing)) return; // release() finished it
    this.teardown(closing.root, closing.rootEl, closing.book);
    await this.settled();
  }

  /** Unmounts (running the reader's save-on-unmount cleanups) and hands the book back; settled() waits for it. */
  private teardown(root: Root, rootEl: HTMLDivElement | null, book: Book | null): void {
    root.unmount();
    rootEl?.remove();
    if (this.book === book) this.book = null;
    if (!this.root) {
      this.nav = null;
      this.commands.current = null;
    }
    if (book) this.track(this.host.closed(book.id));
  }
}
