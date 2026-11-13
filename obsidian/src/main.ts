import {
  Notice,
  Plugin,
  TFile,
  TFolder,
  loadPdfJs,
  normalizePath,
  FileView,
  type Editor,
  type MarkdownFileInfo,
  type MarkdownView,
  type ObsidianProtocolData,
  type PaneType,
  type Menu,
  type TAbstractFile,
  type Tasks,
  type WorkspaceLeaf,
} from 'obsidian';
import '../../src/App.css';
import { displayTitle } from '../../src/lib/titles';
import * as bodySaves from '../../src/features/notebook/bodySaves';
import { flushAll, flushAllBounded } from '../../src/features/notebook/editorRegistry';
import { setBackend } from '../../src/lib/backend';
import { setAppName } from '../../src/lib/appName';
import { pdfLocation, serializeLocation } from '../../src/lib/location';
import type { Location } from '../../src/lib/types';
import { pdfjs, pdfjsDocOptions, setPdfjs } from '../../src/renderers/pdf/pdfjsProvider';
import { COVER_DELAY_MS, CoverManager } from './covers/covers';
import { isCoverImage, showCoverMenu } from './covers/coverMenu';
import { renderFirstPage, COVER_QUALITY, COVER_WIDTH } from './covers/thumbnail';
import { epubCoverWebp } from './covers/epubCover';
import { confirmModal } from './backend/confirmModal';
import { registerViewCommands } from './commands';
import { markdownLink, parseMarginParams } from './links';
import { suggestNotes, suggestTags } from './linkSuggest';
import { BacklinkIndex } from './backlinks';
import { VaultBackend } from './backend/vaultBackend';
import { PdfPicker, bookLinkAt, isBook, isPdf, recentFirst } from './open';
import { recoveryMessage } from './recoveryNotice';
import { generateMirror } from './mirror/generate';
import { OutlineCache } from './mirror/outline';
import { MIRROR_DELAY_MS, MirrorScheduler } from './mirror/scheduler';
import { mirrorPath, MirrorWriter } from './mirror/writer';
import { DEFAULT_SETTINGS, MarginSettingTab, folderError, normalizeFolder, normalizeTranslationSettings, type MarginSettings } from './settings';
import { createTranslation, type TranslationDeps } from './translate/engine';
import { InstalledStore } from './translate/installed';
import type { ObsidianTranslateHost } from './translate/service';
import { BookStore } from './store/bookStore';
import type { BookFile } from './store/types';
import { MarginError } from './store/errors';
import { fingerprint } from './store/hash';
import { MarginView, OBSIDIAN_PDF_VIEW, VIEW_TYPE, type MarginHost } from './view/MarginView';
import { SHELF_VIEW_TYPE, ShelfView, type ShelfHost } from './shelf/ShelfView';
import { APP_NAME, LEGACY_MIRROR_FOLDER, LEGACY_PROTOCOL_ACTION, PROTOCOL_ACTION } from './identity';
import { IMPORTED_NOTICE, importLegacyData } from './legacyImport';
import '../../src/renderers/pdf/pdf.css';
import '../../src/renderers/epub/epub.css';

// Shared reader text names the app: in Obsidian it is Readside (the desktop app stays Margin).
setAppName(APP_NAME);

/**
 * (The key keeps the plugin's old id on purpose; see identity.ts.)
 * The unload tail of a Margin instance that is still writing, on `window` because each load evaluates
 * main.js afresh: a plugin update disables and at once enables Margin, and the new instance must not
 * read (or repair) the store's files while the old one is still writing them.
 */
export const UNLOADING_KEY = '__margin-reader-unloading';
/** How long a new instance waits for the old one's tail at most. */
export const HANDOFF_TIMEOUT_MS = 5000;
/**
 * How long closing a view waits for its notebook note at most, and the one budget unloading or quitting
 * has for every note together (counted from its start): a slow vault write must not hold the reader's
 * teardown, the store's last write, the next instance (HANDOFF_TIMEOUT_MS) or Obsidian's quit.
 */
/**
 * The getDocument options Obsidian's own PDF viewer uses (app.js, pdf.js 5.3): its bundled cmaps, standard
 * fonts, wasm decoders and ICC profiles, and no eval (Obsidian's CSP forbids it). Without them, non-embedded
 * fonts and some images render blank.
 */
export const OBSIDIAN_PDF_OPTIONS = {
  cMapUrl: '/lib/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/lib/pdfjs/standard_fonts/',
  wasmUrl: '/lib/pdfjs/wasm/',
  iccUrl: '/lib/pdfjs/iccs/',
  isEvalSupported: false,
} as const;

interface PdfViewRegistry {
  getTypeByExtension(extension: string): string | undefined;
  registerExtensions(extensions: string[], viewType: string): void;
  unregisterExtensions(extensions: string[]): void;
}

/** When to look again for the PDF tab being opened (ms after file-open): Obsidian may still be loading it. */
export const TAKE_OVER_RETRY_MS = [0, 50, 150, 400, 1000];

export const MIRROR_FLUSH_TIMEOUT_MS = 2500;
/** How long after load the translation folder is tidied (leftovers of an interrupted download). */
export const TRANSLATION_SWEEP_DELAY_MS = 10_000;
/** The ribbon's tooltip and the command's name. */
export const SHELF_TITLE_COMMAND = 'Open Readside shelf';

type HandoffWindow = Window & { [UNLOADING_KEY]?: Promise<void> };

/** Resolves when `p` settles or after `ms`, whichever comes first. */
async function settledOrTimeout(p: Promise<unknown>, ms: number, onTimeout?: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((r) => (timer = setTimeout(() => (onTimeout?.(), r()), ms)));
  try {
    await Promise.race([p.then(() => undefined, () => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export default class MarginPlugin extends Plugin {
  settings: MarginSettings = { ...DEFAULT_SETTINGS };
  store!: BookStore;
  /** Resolves once the store has loaded (the index: rename/delete tracking and the picker need it). */
  storeReady: Promise<void> = Promise.resolve();
  /** Resolves once Obsidian's pdf.js is installed (the reader needs it). Independent of storeReady. */
  pdfReady: Promise<void> = Promise.resolve();
  /** Both of the above. */
  ready: Promise<void> = Promise.resolve();
  /** The unload chain: saves land, the store is written and closed, then the backend is uninstalled. */
  unloading: Promise<void> = Promise.resolve();
  /** Every MarginView from construction until its teardown has finished (closing ones included). */
  readonly views = new Set<MarginView>();
  mirrors!: MirrorWriter;
  /** Where vault notes link into open books (set in onload; disposed by a register cleanup). */
  backlinks: BacklinkIndex | null = null;
  scheduler!: MirrorScheduler;
  outlines!: OutlineCache;
  /** Book covers: first-page thumbnails made in the background, and the shelf's cover choices. */
  covers!: CoverManager;
  /** How long after a request a cover job starts; tests shorten it before onload. */
  coverDelayMs = COVER_DELAY_MS;
  /** How long after a book's last change its notebook note is rewritten; tests shorten it before onload. */
  mirrorDelayMs = MIRROR_DELAY_MS;
  /** The bound on waiting for notebook notes (view close, unload, quit); tests shorten it. */
  mirrorFlushTimeoutMs = MIRROR_FLUSH_TIMEOUT_MS;
  /**
   * Set when unloading or quitting starts: every wait for notebook notes from then on (each released
   * view's host.closed, the final flushAll) shares this one deadline, so a stuck write is waited for once.
   */
  private mirrorDeadline: number | null = null;
  /** The mirror settings the notes were last written with (saveSettings rewrites them on a change). */
  private mirrorApplied = { enabled: true, folder: '' };
  /** Stops scheduling notebook notes on store changes; called at the end of the unload tail. */
  private stopMirrorTracking: () => void = () => {};
  /** Test seams for translation (a fake fetcher, worker or sha256); set before the first use. */
  translationOptions: Pick<TranslationDeps, 'fetcher' | 'createWorker' | 'sha256' | 'warn'> = {};
  /** How long after load the translation folder is tidied; tests shorten it before onload. */
  translationSweepDelayMs = TRANSLATION_SWEEP_DELAY_MS;
  /** The one translate host (it owns the one engine client), made on first use; null before and after. */
  private translateHost: ObsidianTranslateHost | null = null;
  /** Set when unloading starts: no translate host is made after that. */
  private translationClosed = false;

  /**
   * The translate host, made on first use (a reader view, the settings tab, the startup tidy-up). Making
   * it starts nothing: the worker starts with the first translation, a download only when asked. Null
   * once the plugin is unloading.
   */
  readonly translation = (): ObsidianTranslateHost | null => {
    if (this.translationClosed) return null;
    this.translateHost ??= createTranslation({
      adapter: this.app.vault.adapter,
      root: this.translationRoot(),
      // A light startup sweep still running: the host's downloads wait for it.
      maintenance: this.startupSweep ?? undefined,
      settings: () => ({ target: this.settings.translateTarget, hover: this.settings.translateHover }),
      saveTarget: (code) => {
        this.settings.translateTarget = code;
        void this.saveSettings().catch((e) => console.warn('margin: could not save the translation target', e));
      },
      notice: (message) => new Notice(message),
      progressNotice: (message) => new Notice(message, 0),
      ...this.translationOptions,
    });
    return this.translateHost;
  };

  private translationRoot(): string {
    return normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/translation`);
  }

  /** The startup sweep run without a host (no translate host was needed yet), while it runs. */
  private startupSweep: Promise<void> | null = null;

  /**
   * Tidies what an interrupted download left behind. With a host, through it (it skips while anything
   * downloads); without one, a plain InstalledStore sweep, so users who never translate don't get a whole
   * host built at startup. A host made meanwhile takes that sweep as its first maintenance.
   */
  private sweepTranslation(): void {
    if (this.translationClosed) return;
    if (this.translateHost) {
      void this.translateHost.sweep();
      return;
    }
    const run = new InstalledStore(this.app.vault.adapter, this.translationRoot())
      .sweep()
      .then(
        () => undefined,
        (e) => console.warn('margin: could not tidy the translation folder', e),
      )
      .finally(() => {
        if (this.startupSweep === run) this.startupSweep = null;
      });
    this.startupSweep = run;
  }

  /** Cancels running translation downloads (their partial files go) and stops the engine; synchronous. */
  private closeTranslation(): void {
    this.translationClosed = true;
    const host = this.translateHost;
    this.translateHost = null;
    host?.dispose();
  }

  readonly host: MarginHost = {
    openBook: async (file, bytes, meta) => {
      await this.storeReady;
      // Only a PDF needs Obsidian's pdf.js: an EPUB opens even when it failed to load.
      if (isPdf(file)) await this.pdfReady;
      const f = await this.store.openPath(file.path, await fingerprint(bytes), displayTitle(file.basename), meta);
      // For the picker's order; a failure here does not stop the book opening.
      await this.store.markOpened(file.path).catch((e) => console.warn('margin: could not record the open', e));
      // Its cover, later and in the background (skipped when the thumbnail is from this content).
      this.covers.request(f.book.id);
      return f.book;
    },
    book: (bookId) => {
      const book = this.store.peek(bookId)?.book;
      return book ? { ...book } : null;
    },
    // Called from the view, never from inside a store operation: flush waits for those, so it would deadlock there.
    closed: async (bookId) => {
      await this.store.flush(bookId);
      // The book's notebook note, now (not MIRROR_DELAY_MS later); bounded, it never holds the teardown long.
      await this.waitForMirrors(this.scheduler.flush(bookId));
    },
    // The reader says "Link copied" itself; a failure is rethrown, so its problem banner is the one message.
    copyLink: async (file, location, quote) => {
      try {
        await navigator.clipboard.writeText(markdownLink(file.path, location, quote));
      } catch (e) {
        throw new MarginError(`Readside couldn't copy the link: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    linkSuggest: (query, session, kind) =>
      kind === 'tag' ? suggestTags(this.app, query, undefined, session) : suggestNotes(this.app, query, undefined, session),
    watchBacklinks: (file, onChange) => this.backlinks?.watch(file, onChange) ?? (() => {}),
    // Beside the reader, never in its place: one split leaf, reused while it is still in the workspace
    // (and not itself a reader by then); ⌘/Ctrl or a middle click: a new tab.
    openBacklink: (view, link, newTab) => {
      const note = this.app.vault.getFileByPath(link.sourcePath);
      if (!note) return;
      let leaf: WorkspaceLeaf;
      if (newTab) leaf = this.app.workspace.getLeaf('tab');
      else {
        const kept = this.backlinkLeaf;
        const reusable = kept && this.inWorkspace(kept) && kept.view.getViewType() !== VIEW_TYPE && !kept.getViewState().pinned;
        // Split the reader's own leaf, not whichever leaf happens to be active.
        leaf = reusable ? kept : this.app.workspace.createLeafBySplit(view.leaf, 'vertical');
        this.backlinkLeaf = leaf;
      }
      void leaf.openFile(note, link.line !== undefined ? { eState: { line: link.line } } : undefined);
    },
    hoverBacklink: (view, link, event, targetEl) => {
      this.app.workspace.trigger('hover-link', {
        event,
        source: VIEW_TYPE,
        hoverParent: view,
        targetEl,
        linktext: link.sourcePath,
        sourcePath: link.sourcePath,
        state: link.line !== undefined ? { scroll: link.line } : undefined,
      });
    },
    // For the shelf's "p. N of M"; kept in the index summary, never in the book file.
    pageCount: (bookId, pageCount) => this.store.setPageCount(bookId, pageCount),
    translate: () => this.translation(),
    openShelf: () => void this.openShelf(),
    viewStarted: (view) => void this.views.add(view),
    viewEnded: (view) => void this.views.delete(view),
    openInObsidian: async (leaf, file) => {
      // The user asked for Obsidian's viewer for this file in this leaf: takeOver leaves it there.
      this.keptInViewer.set(leaf, file.path);
      await leaf.setViewState({ type: OBSIDIAN_PDF_VIEW, state: { file: file.path }, active: true });
    },
    notebookNote: async (file) => {
      const enabled = this.settings.mirrorEnabled;
      await this.storeReady;
      const bookId = this.store.bookIdForPath(file.path);
      const book = bookId ? this.store.peek(bookId)?.book : null;
      if (!bookId || !book) return { path: null, enabled };
      // Highlights or thoughts whose note is still waiting (MIRROR_DELAY_MS) or being written: write it now,
      // bounded like a view close, so there is a note to open rather than "none yet".
      const f = this.store.peek(bookId);
      if (enabled && f && (f.annotations.length > 0 || f.thoughts.length > 0) && this.scheduler.isPending(bookId)) {
        await this.waitForMirrors(this.scheduler.flush(bookId));
      }
      const exists = (p: string | null): p is string => !!p && this.app.vault.getFileByPath(p) !== null;
      // The path on record first: a second book of the same title has its note at "<title> (2).md".
      const recorded = await this.mirrors.recordedPath(bookId);
      if (exists(recorded)) return { path: recorded, enabled };
      const desired = mirrorPath(this.settings.mirrorFolder, book);
      if (recorded === null && exists(desired)) return { path: desired, enabled };
      // Written once (on record), gone from the vault since: moved or deleted by the user.
      return { path: null, enabled, moved: recorded !== null };
    },
  };
  /** The shelf reads the index (and, in the background, book files) through this; one object, so its views share it. */
  readonly shelfHost: ShelfHost = {
    source: {
      entries: () => this.store.shelfEntries(),
      // Uncached: search and the lists look at a book without keeping it in the store's memory.
      file: (bookId) => this.store.peekFile(bookId),
      subscribe: (onChange) => {
        const offBooks = this.store.onChange((bookId) => onChange(bookId));
        const offIndex = this.store.onIndexChange(() => onChange());
        // A cover file changed: the cards redraw; no book is read again.
        const offCovers = this.covers.onChange(() => onChange());
        return () => {
          offBooks();
          offIndex();
          offCovers();
        };
      },
      cover: (entry) => this.covers.view(entry),
      requestCover: (bookId) => this.covers.request(bookId),
      coverMenu: (bookId, title, at, opener) => {
        showCoverMenu(this.app, this.covers, this.store.entryOf(bookId)?.cover ?? null, { bookId, title }, at, opener);
      },
    },
    ready: () => this.storeReady,
    openBook: (path, location, openIn = false) => {
      const file = this.app.vault.getFileByPath(path);
      if (!isBook(file)) {
        new Notice(`Readside can't find ${path} in this vault.`);
        return;
      }
      void this.openInMargin(file, location, openIn);
    },
    pickPdf: () => void this.pickPdf(),
  };
  /**
   * Leaves the user switched to Obsidian's viewer, with the file they showed then. Only consulted when
   * .pdf could not be mapped to Margin (takeOver's fallback): a leaf stays in the viewer while it shows
   * that file, and is dropped once its file or view type changes. A map, not a set: "that file" must be known.
   */
  private readonly keptInViewer = new WeakMap<WorkspaceLeaf, string>();
  /** The split leaf backlinks open in (reused while it is still in the workspace). */
  private backlinkLeaf: WorkspaceLeaf | null = null;
  private inWorkspace(leaf: WorkspaceLeaf): boolean {
    let found = false;
    this.app.workspace.iterateAllLeaves((l) => {
      if (l === leaf) found = true;
    });
    return found;
  }
  /** setPdfDefault mapped .pdf to Margin (and nothing has changed the mapping since, as far as it knows). */
  private pdfMapped = false;

  async onload(): Promise<void> {
    // A plugin update: the previous instance may still be writing. Its store must be done before this
    // one reads (and repairs) the same files. Obsidian awaits onload, so the leaves wait too.
    const previous = (window as HandoffWindow)[UNLOADING_KEY];
    if (previous) await settledOrTimeout(previous, HANDOFF_TIMEOUT_MS, () =>
        console.warn(`margin: the previous instance did not finish unloading within ${HANDOFF_TIMEOUT_MS} ms; loading anyway`),
      );
    const root = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    // The plugin was Margin (id margin-reader): its books, notes and settings come across once, before
    // anything here reads them. A failure leaves both folders as they were; the next load tries again.
    try {
      if (await importLegacyData(this.app.vault.adapter, this.app.vault.configDir, root)) new Notice(IMPORTED_NOTICE);
    } catch (e) {
      new Notice(`Readside couldn't import your books and notes from Margin; it tries again next time: ${String(e)}`, 0);
    }
    const saved = (await this.loadData()) as Partial<MarginSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...saved };
    // An install from before the rename keeps its notebook notes where they are: with no folder saved,
    // notes already on record (mirrors.json) mean the old default, Margin/.
    if (saved?.mirrorFolder === undefined && (await this.hasRecordedMirrors(root))) {
      this.settings.mirrorFolder = LEGACY_MIRROR_FOLDER;
      await this.saveData(this.settings);
    }
    // data.json edited by hand (or synced from elsewhere): a folder the settings tab would refuse is not used.
    const folder = typeof this.settings.mirrorFolder === 'string' ? normalizeFolder(this.settings.mirrorFolder) : null;
    if (folder === null || folderError(folder, this.app.vault.configDir)) {
      console.warn(`margin: the notebook notes folder ${JSON.stringify(this.settings.mirrorFolder)} can't be used; using "${DEFAULT_SETTINGS.mirrorFolder}"`);
      this.settings.mirrorFolder = DEFAULT_SETTINGS.mirrorFolder;
    }
    this.mirrorApplied = { enabled: this.settings.mirrorEnabled, folder: this.settings.mirrorFolder };
    normalizeTranslationSettings(this.settings);
    this.store = new BookStore(this.app.vault.adapter, root, { pathExists: (p) => this.app.vault.getAbstractFileByPath(p) !== null });
    // Anything load() repaired (a damaged book or index, books swept back) is named to the user; it stays until dismissed.
    this.store.onRecovery((e) => new Notice(recoveryMessage(e), 0));
    this.outlines = new OutlineCache((path) => this.readBytes(path), () => pdfjs());
    this.covers = new CoverManager({
      adapter: this.app.vault.adapter,
      root,
      index: this.store,
      ready: () => this.ready,
      readBytes: (path) => this.readBytes(path),
      render: (bytes) => renderFirstPage(pdfjs(), pdfjsDocOptions(), bytes),
      renderEpub: (bytes) => epubCoverWebp(bytes, { width: COVER_WIDTH, quality: COVER_QUALITY }),
      vaultImage: (path) => {
        const file = this.app.vault.getFileByPath(path);
        return isCoverImage(file) ? this.app.vault.getResourcePath(file) : null;
      },
      delayMs: this.coverDelayMs,
    });
    this.mirrors = new MirrorWriter({ app: this.app, root, notice: (message) => new Notice(message), isClosed: () => this.store.isClosed });
    this.scheduler = new MirrorScheduler((bookId) => this.writeMirror(bookId), this.mirrorDelayMs);
    // Not a register() cleanup: those run before onunload, and changes the unload tail lands (the
    // positions views save on release, a body retry) must still reach the note. The tail stops it.
    this.stopMirrorTracking = this.store.onChange((bookId) => {
      if (this.settings.mirrorEnabled) this.scheduler.touch(bookId);
    });
    // Separate, so a pdf.js failure leaves rename/delete tracking working (and the other way round).
    this.pdfReady = (async () => setPdfjs(await loadPdfJs(), OBSIDIAN_PDF_OPTIONS))();
    this.storeReady = this.store.load();
    this.pdfReady.catch((e) => new Notice(`Readside couldn't load Obsidian's PDF engine, so it can't show PDFs: ${String(e)}`, 0));
    this.storeReady.catch((e) => new Notice(`Readside couldn't read its saved books: ${String(e)}`, 0));
    // Cover files of books the index no longer has (and pasted images no longer chosen) go.
    this.storeReady.then(() => this.covers.sweep()).catch((e) => console.warn('margin: could not tidy the covers folder', e));
    this.ready = Promise.all([this.pdfReady, this.storeReady]).then(() => undefined);
    this.ready.catch(() => {}); // each failure has its Notice
    setBackend(
      new VaultBackend(this.store, {
        readBytes: (path) => this.readBytes(path),
        confirm: (message, opts) => confirmModal(this.app, message, opts),
      }),
    );

    // Backlinks: idle until a view watches a book; refreshed (debounced) as the metadata cache changes.
    const backlinks = new BacklinkIndex(this.app);
    this.backlinks = backlinks;
    this.register(() => {
      backlinks.dispose();
      if (this.backlinks === backlinks) this.backlinks = null;
    });
    this.registerEvent(this.app.metadataCache.on('changed', (file: TFile, data: string) => backlinks.changed(file, data)));
    this.registerEvent(this.app.metadataCache.on('resolved', () => backlinks.resolved()));
    this.registerEvent(this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => backlinks.renamed(file, oldPath)));
    this.registerEvent(this.app.vault.on('delete', (file: TAbstractFile) => backlinks.deleted(file)));

    this.registerView(VIEW_TYPE, (leaf) => new MarginView(leaf, this.host));
    this.registerView(SHELF_VIEW_TYPE, (leaf) => new ShelfView(leaf, this.shelfHost));
    // Hovering a linking note in a marker's list previews it (Page preview core plugin; with Mod by default).
    this.registerHoverLinkSource(VIEW_TYPE, { display: 'Readside', defaultMod: true });
    // Registered after registerView, so it runs before the view type goes (cleanups run last first):
    // .pdf is handed back to Obsidian's viewer before Margin's view type is unregistered.
    this.register(() => this.setPdfDefault(false));
    this.setPdfDefault(this.settings.openPdfsInMargin);
    // .epub has no viewer in Obsidian: Margin opens it (explorer, switcher, links), unless another plugin
    // already claimed it. Handed back on unload only while it is still Margin's, like .pdf above.
    this.claimEpub();
    this.addSettingTab(new MarginSettingTab(this.app, this));
    // Later, not at load: leftovers of a download cut short (a quit, a crash, a plugin update) go.
    const sweepTimer = window.setTimeout(() => this.sweepTranslation(), this.translationSweepDelayMs);
    this.register(() => window.clearTimeout(sweepTimer));
    // New links say obsidian://readside; obsidian://margin is the same link from before the rename, kept for good.
    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => this.openLink(params));
    this.registerObsidianProtocolHandler(LEGACY_PROTOCOL_ACTION, (params) => this.openLink(params));
    // The shelf; its "Open a book…" button is the picker this used to open.
    this.addRibbonIcon('book-open', SHELF_TITLE_COMMAND, () => void this.openShelf());
    this.addCommand({ id: 'open-shelf', name: SHELF_TITLE_COMMAND, callback: () => void this.openShelf() });
    this.addCommand({
      id: 'open-current-pdf',
      name: 'Open current book',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!isBook(file)) return false;
        if (!checking) void this.openInMargin(file);
        return true;
      },
    });
    registerViewCommands(this, () => this.app.workspace.getActiveViewOfType(MarginView));
    this.addCommand({
      id: 'open-notebook-note',
      name: 'Open notebook note',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarginView);
        if (!view?.file) return false;
        if (!checking) void view.openNotebookNote();
        return true;
      },
    });
    this.registerEvent(this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => this.addOpenItem(menu, file)));
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
        const cursor = editor.getCursor();
        const link = bookLinkAt(editor.getLine(cursor.line), cursor.ch);
        const dest = link ? this.app.metadataCache.getFirstLinkpathDest(link, info.file?.path ?? '') : null;
        if (dest) this.addOpenItem(menu, dest);
      }),
    );
    this.registerEvent(this.app.workspace.on('file-open', (file: TFile | null) => void this.takeOver(file)));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.pruneKeptInViewer()));
    this.registerEvent(this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => void this.onRenamed(file, oldPath)));
    this.registerEvent(this.app.vault.on('delete', (file: TAbstractFile) => void this.onDeleted(file)));
    // Quit: Obsidian waits for these tasks before it closes.
    this.registerEvent(
      this.app.workspace.on('quit', (tasks: Tasks) =>
        tasks.add(async () => {
          this.mirrorDeadline ??= Date.now() + this.mirrorFlushTimeoutMs;
          // The window goes next: release the views so their pending position and zoom are written too.
          const released = this.releaseViews();
          await flushAllBounded();
          await released;
          await this.store.flush();
          await this.waitForMirrors(this.scheduler.flushAll());
        }),
      ),
    );
    // Reload, or a quit that skips the tasks: best effort, the window may go before the writes land.
    this.registerDomEvent(window, 'beforeunload', () => {
      void flushAll().then(() => this.store.flush());
    });
  }

  /**
   * Obsidian's Component.unload runs, in order: the children; the registered cleanups, last first;
   * then this. The registerView cleanup unregisters the view type, which closes every Margin view
   * synchronously (View.close starts MarginView.onClose, whose unmount waits on the editor flush) and,
   * when the user turned Margin off, detaches the leaves; otherwise they reopen as placeholders. So by
   * now no leaf may show a Margin view, but their teardowns are still in flight. Every view registered
   * since its construction is released here, synchronously, while the vault backend is installed (a
   * close in flight is finished, not run twice). The tail then waits for the editor flush and every
   * view's teardown (host.closed), stops the body retries, writes and closes the store, and only then
   * uninstalls the backend. The next instance (a plugin update) waits for the tail before its load.
   */
  onunload(): void {
    // No more cover jobs; one in flight stops before it writes.
    this.covers?.dispose();
    // Synchronous, first in the unload: a running translation download is cancelled (its partial file is
    // removed, or swept on the next load) and the engine's worker is terminated. Nothing here waits, so
    // neither the store's last write nor the next instance's handoff is held up.
    // Guarded: a throw here must not skip the release, the store's last write or the handoff below.
    try {
      this.closeTranslation();
    } catch (e) {
      console.error('margin: closing translation on unload failed', e);
    }
    // Before the release: the views' host.closed draw on the same mirror budget as the tail's flushAll.
    this.mirrorDeadline ??= Date.now() + this.mirrorFlushTimeoutMs;
    const released = this.releaseViews();
    const tail = (async () => {
      try {
        await flushAllBounded();
        await released;
        bodySaves.stopRetries();
        await this.store?.flush();
        // After the flush: a body save still in flight when the unload began has landed or failed by now.
        const failed = bodySaves.failedCount();
        if (failed > 0) {
          new Notice(
            `Readside couldn't save the text of ${failed} ${failed === 1 ? 'thought' : 'thoughts'} before it was turned off; that text is not in the vault.`,
            0,
          );
        }
        // Notes of books changed since their last write, from the store's final state; within what is left
        // of the one mirror budget, so a slow vault write cannot hold the store open or the next instance.
        if (this.scheduler) await this.waitForMirrors(this.scheduler.flushAll());
      } catch (e) {
        console.error('margin: saving on unload failed', e);
      } finally {
        this.stopMirrorTracking();
        this.scheduler?.dispose();
        this.store?.close();
        // This instance's own module state (each load evaluates main.js afresh).
        setBackend(null);
      }
    })();
    this.unloading = tail;
    const w = window as HandoffWindow;
    w[UNLOADING_KEY] = tail;
    void tail.finally(() => {
      if (w[UNLOADING_KEY] === tail) delete w[UNLOADING_KEY];
    });
  }

  /** Releases every live Margin view (closing ones too); resolves once their teardowns have finished. */
  private releaseViews(): Promise<void> {
    return Promise.all([...this.views].map((v) => v.release())).then(() => undefined);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.setPdfDefault(this.settings.openPdfsInMargin);
    const { mirrorEnabled: enabled, mirrorFolder: folder } = this.settings;
    const was = this.mirrorApplied;
    this.mirrorApplied = { enabled, folder };
    // Turned on, or the folder moved: rewrite the notes now, not on each book's next change.
    if (enabled && (!was.enabled || was.folder !== folder)) void this.rewriteAllMirrors();
  }

  /**
   * "Open PDFs in Margin": while on, Obsidian's view registry maps .pdf to Margin, so every PDF opens
   * in Margin directly (file list, switcher, links, PDF++ alike). Off, .pdf goes back to Obsidian's
   * own viewer. app.viewRegistry is internal (not in the typings) but stable; a missing or changed
   * registry leaves PDFs with Obsidian and Margin reachable through "Open in Margin".
   */
  private setPdfDefault(on: boolean): void {
    const registry = (this.app as unknown as { viewRegistry?: PdfViewRegistry }).viewRegistry;
    if (!registry?.getTypeByExtension || !registry.registerExtensions || !registry.unregisterExtensions) return;
    const want = on ? VIEW_TYPE : OBSIDIAN_PDF_VIEW;
    const current = registry.getTypeByExtension('pdf');
    this.pdfMapped = current === VIEW_TYPE;
    if (current === want) return;
    // Only ever swap between Obsidian's viewer and Margin: another plugin's claim on .pdf is left alone.
    if (current !== undefined && current !== VIEW_TYPE && current !== OBSIDIAN_PDF_VIEW) return;
    try {
      registry.unregisterExtensions(['pdf']);
      registry.registerExtensions(['pdf'], want);
      this.pdfMapped = want === VIEW_TYPE;
    } catch (e) {
      this.pdfMapped = false;
      console.warn('margin: could not change which view opens PDFs', e);
      try {
        if (registry.getTypeByExtension('pdf') === undefined) registry.registerExtensions(['pdf'], OBSIDIAN_PDF_VIEW);
      } catch {
        /* leave it */
      }
    }
  }

  /**
   * Maps .epub to Margin's view when no one has it (Obsidian has no EPUB viewer of its own), and unmaps it
   * on unload only if it is still Margin's. Without a usable registry, EPUBs open through "Open in Margin".
   */
  private claimEpub(): void {
    const registry = (this.app as unknown as { viewRegistry?: Partial<PdfViewRegistry> }).viewRegistry;
    if (!registry?.getTypeByExtension || !registry.registerExtensions || !registry.unregisterExtensions) return;
    const current = registry.getTypeByExtension('epub');
    // Already Margin's (left by an instance that never unloaded cleanly): kept, and handed back on unload.
    if (current !== undefined && current !== VIEW_TYPE) return;
    if (current === undefined) {
      try {
        registry.registerExtensions(['epub'], VIEW_TYPE);
      } catch (e) {
        console.warn('margin: could not open EPUBs in Readside by default', e);
        return;
      }
    }
    // Registered after registerView: it runs first on unload (cleanups run last first).
    this.register(() => {
      try {
        if (registry.getTypeByExtension?.('epub') === VIEW_TYPE) registry.unregisterExtensions?.(['epub']);
      } catch (e) {
        console.warn('margin: could not hand .epub back', e);
      }
    });
  }

  /** Schedules the note of every book that has one on record or is open in a view. */
  private async rewriteAllMirrors(): Promise<void> {
    try {
      await this.storeReady;
      // A note on record for a book the store no longer has (its file was removed): nothing to write it from.
      const ids = new Set((await this.mirrors.bookIds()).filter((id) => this.store.hasBook(id)));
      for (const v of this.marginViews()) {
        const id = v.file ? this.store.bookIdForPath(v.file.path) : null;
        if (id) ids.add(id);
      }
      if (!this.settings.mirrorEnabled) return;
      for (const id of ids) this.scheduler.touch(id);
    } catch (e) {
      console.error('margin: could not rewrite the notebook notes', e);
    }
  }

  /** Waits for notebook-note writes: the view-close bound, or what is left of the unload/quit budget. */
  private waitForMirrors(p: Promise<unknown>): Promise<void> {
    const ms = this.mirrorDeadline === null ? this.mirrorFlushTimeoutMs : Math.max(0, this.mirrorDeadline - Date.now());
    return settledOrTimeout(p, ms);
  }

  /** Regenerates a book's notebook note (spec §6). Reads the store only: never inside a store operation. */
  async writeMirror(bookId: string): Promise<void> {
    if (!this.settings.mirrorEnabled) return;
    await this.storeReady;
    const f = await this.store.file(bookId);
    // A PDF's outline needs Obsidian's pdf.js; without it the note has no sections, but is still written.
    if (f.book.format === 'pdf') await this.pdfReady.catch(() => {});
    // Keyed by the content too: a file replaced at its path keeps its book but gets a new outline.
    const outline = await this.outlines.get(bookId, f.book.path, f.book.contentHash, f.book.format);
    // generateMirror is pure: the live (read-only) book is only read.
    const { book, annotations, thoughts } = f as BookFile;
    const content = generateMirror({ book, annotations, thoughts, outline });
    await this.mirrors.write(bookId, mirrorPath(this.settings.mirrorFolder, book), content);
  }

  async readBytes(path: string): Promise<ArrayBuffer> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) throw new MarginError(`Readside can't find ${path} in this vault.`);
    return this.app.vault.readBinary(file);
  }

  /** A leaf whose saved state is a Margin view of `path` but that holds no MarginView yet (deferred). */
  private deferredMarginLeaf(path: string): WorkspaceLeaf | null {
    let found: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found || leaf.view instanceof MarginView) return;
      const vs = leaf.getViewState();
      if (vs.type === VIEW_TYPE && vs.state?.file === path) found = leaf;
    });
    return found;
  }

  marginViews(): MarginView[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE)
      .map((l) => l.view)
      .filter((v): v is MarginView => v instanceof MarginView);
  }

  /**
   * Opens `file` in Margin, reusing a Margin view that already shows it; `location` jumps there. `openIn`:
   * false uses the active leaf, a pane type ('tab' for ⌘/Ctrl- or middle-click) a new one.
   */
  async openInMargin(file: TFile, location: Location | null = null, openIn: PaneType | false = false): Promise<void> {
    const open = this.marginViews().find((v) => v.file?.path === file.path);
    if (open) {
      await this.app.workspace.revealLeaf(open.leaf);
      if (location) open.navigate(location);
      return;
    }
    // A Margin tab of this file that is still deferred (a background tab since startup): reveal it, which
    // loads it, rather than opening a second tab of the same book.
    const deferred = this.deferredMarginLeaf(file.path);
    if (deferred) {
      await this.app.workspace.revealLeaf(deferred);
      if (!location) return;
      if (deferred.view instanceof MarginView) deferred.view.navigate(location);
      else await deferred.setViewState({ type: VIEW_TYPE, state: { file: file.path, loc: serializeLocation(location) }, active: true });
      return;
    }
    const leaf = this.app.workspace.getLeaf(openIn);
    await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
    if (!location) return;
    // Through navigate, not state.loc: an explicit jump flashes even at the book's stored position,
    // which a `loc` in the view state skips (that is a restored layout).
    if (leaf.view instanceof MarginView) leaf.view.navigate(location);
    // Not a Margin view yet (a deferred leaf): the view state carries the jump to it instead of dropping it.
    else await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path, loc: serializeLocation(location) }, active: true });
  }

  /** Whether mirrors.json records at least one notebook note (an unreadable one counts as none). */
  private async hasRecordedMirrors(root: string): Promise<boolean> {
    try {
      const text = await this.app.vault.adapter.read(`${root}/mirrors.json`);
      const books = (JSON.parse(text) as { books?: Record<string, unknown> }).books;
      return !!books && Object.keys(books).length > 0;
    } catch {
      return false;
    }
  }

  /**
   * `obsidian://readside?file=<vault path>` (or the older `obsidian://margin?…`)&loc=<Location JSON>`: opens the PDF in Readside (an open
   * view of it is reused) and jumps there with a flash. No usable `loc`: the book opens where it was left.
   */
  async openLink(params: ObsidianProtocolData): Promise<void> {
    try {
      await this.ready;
    } catch {
      return; // the failed load has its Notice
    }
    const target = parseMarginParams(params);
    if (!target) {
      new Notice('Readside: this link names no file.');
      return;
    }
    // A hand-written link may say `/Books/x.pdf` or `Books\x.pdf`.
    const file = this.app.vault.getFileByPath(normalizePath(target.file));
    if (!file) {
      new Notice(`Readside can't find ${target.file} in this vault.`);
      return;
    }
    if (!isBook(file)) {
      new Notice(`Readside opens PDF and EPUB books only; ${target.file} is not one.`);
      return;
    }
    await this.openInMargin(file, target.location);
  }

  /** Shows the shelf: an open one is revealed, else it opens in a new tab. */
  async openShelf(): Promise<void> {
    const open = this.app.workspace.getLeavesOfType(SHELF_VIEW_TYPE)[0];
    if (open) {
      await this.app.workspace.revealLeaf(open);
      return;
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: SHELF_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private async pickPdf(): Promise<void> {
    await this.storeReady;
    const files = recentFirst(this.app.vault.getFiles(), this.store.openedAtByPath());
    new PdfPicker(this.app, files, (f) => void this.openInMargin(f)).open();
  }

  private addOpenItem(menu: Menu, file: TAbstractFile): void {
    if (!(file instanceof TFile) || !isBook(file)) return;
    menu.addItem((item) => item.setTitle('Open in Readside').setIcon('book-open').onClick(() => void this.openInMargin(file)));
  }

  /**
   * "Open PDFs in Margin" on: the PDF that just opened in Obsidian's viewer, in the active leaf, switches
   * to Margin at the page the viewer was asked for. Other leaves (other windows, a restored layout) stay.
   */
  private async takeOver(file: TFile | null): Promise<void> {
    // file-open also fires on every tab switch: forget leaves that no longer show what the user kept in the viewer.
    this.pruneKeptInViewer();
    if (!this.settings.openPdfsInMargin || !isPdf(file)) return;
    // .pdf maps to Margin: Obsidian opens PDFs in Margin itself, so a leaf in Obsidian's viewer is there
    // because someone chose it ("Open in Obsidian's viewer", "Open with"). It stays.
    if (this.marginOwnsPdf()) return;
    // Obsidian announces file-open while the PDF tab is still loading (its view may not hold the file yet,
    // and a click in the explorer activates the leaf only afterwards), so the leaf is found by the state
    // Obsidian is opening, and looked for again for a moment.
    for (const wait of TAKE_OVER_RETRY_MS) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (!this.settings.openPdfsInMargin) return;
      if (this.marginOwnsPdf()) return;
      const leaf = this.pdfLeafFor(file.path);
      if (!leaf) continue;
      // The user switched this leaf to the viewer for this file: it stays while it shows it.
      if (this.keptInViewer.get(leaf) === file.path) return;
      const state: Record<string, unknown> = { file: file.path };
      const page = requestedPage(leaf);
      if (page) state.loc = serializeLocation(pdfLocation({ page, start: 0, end: 0 }));
      await leaf.setViewState({ type: VIEW_TYPE, state, active: true });
      return;
    }
  }

  /** Whether Obsidian's view registry opens .pdf in Margin (or, without a readable registry, setPdfDefault mapped it). */
  private marginOwnsPdf(): boolean {
    const registry = (this.app as unknown as { viewRegistry?: Partial<PdfViewRegistry> }).viewRegistry;
    if (typeof registry?.getTypeByExtension === 'function') return registry.getTypeByExtension('pdf') === VIEW_TYPE;
    return this.pdfMapped;
  }

  /** Drops kept leaves that now show another file or another view type (or have left the workspace's view). */
  private pruneKeptInViewer(): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const kept = this.keptInViewer.get(leaf);
      if (kept === undefined) return;
      const vs = leaf.getViewState();
      const file = (vs.state as { file?: unknown } | undefined)?.file ?? (leaf.view as FileView | undefined)?.file?.path;
      if (vs.type !== OBSIDIAN_PDF_VIEW || file !== kept) this.keptInViewer.delete(leaf);
    });
  }

  /** The leaf that is opening `path` in Obsidian's PDF viewer: the active (or most recent) leaf only. */
  private pdfLeafFor(path: string): WorkspaceLeaf | null {
    const ws = this.app.workspace;
    const showing = (leaf: WorkspaceLeaf | null | undefined): leaf is WorkspaceLeaf => {
      if (!leaf) return false;
      const vs = leaf.getViewState();
      if (vs.type !== 'pdf') return false;
      const file = (vs.state as { file?: unknown } | undefined)?.file ?? (leaf.view as FileView | undefined)?.file?.path;
      return file === path;
    };
    const active = ws.getActiveViewOfType(FileView)?.leaf ?? null;
    if (showing(active)) return active;
    const recent = ws.getMostRecentLeaf();
    return showing(recent) ? recent : null;
  }

  private async onRenamed(file: TAbstractFile, oldPath: string): Promise<void> {
    // The mirror moving its own note (a book renamed, the folder changed): not a book, nothing to follow.
    if (this.mirrors?.isOwnWrite(oldPath) || this.mirrors?.isOwnWrite(file.path)) return;
    if (!(file instanceof TFile) && !(file instanceof TFolder)) return;
    try {
      await this.storeReady;
      await this.store.renamePath(oldPath, file.path);
      for (const v of this.marginViews()) v.refreshBook();
    } catch (e) {
      new Notice(`Readside couldn't follow the move of ${oldPath} to ${file.path}; its book stays under the old path: ${String(e)}`, 0);
    }
    // Covers never block tracking: a cover chosen from this image (or one under this folder) follows it, after the book did.
    try {
      await this.store.followCoverMove(oldPath, file.path);
    } catch (e) {
      console.warn(`margin: a cover could not follow the move of ${oldPath}`, e);
    }
  }

  private async onDeleted(file: TAbstractFile): Promise<void> {
    try {
      await this.storeReady;
      const bookId = this.store.bookIdForPath(file.path);
      if (bookId) this.outlines.forget(bookId);
      else if (file instanceof TFolder) this.outlines.clear();
      await this.store.markMissing(file.path);
    } catch (e) {
      new Notice(`Readside couldn't mark the books under ${file.path} as missing: ${String(e)}`, 0);
    }
    // Covers never block tracking: a cover chosen from this image goes back to automatic, after the books were marked.
    try {
      await this.store.dropCoverPath(file.path);
    } catch (e) {
      console.warn(`margin: a cover could not be reset after ${file.path} was deleted`, e);
    }
  }
}

/** The page a pdf leaf was opened at: `page` in its state, or a `#page=N` subpath in its state or ephemeral state. */
function requestedPage(leaf: WorkspaceLeaf): number | null {
  const fromSubpath = (v: unknown) => {
    const m = typeof v === 'string' ? /[#&]page=(\d+)/.exec(v) : null;
    return m ? Number(m[1]) : null;
  };
  const state = (leaf.getViewState().state ?? {}) as Record<string, unknown>;
  const eState = (leaf.getEphemeralState() ?? {}) as Record<string, unknown>;
  for (const s of [eState, state]) {
    const page = typeof s.page === 'number' ? s.page : fromSubpath(s.subpath);
    if (page && Number.isInteger(page) && page >= 1) return page;
  }
  return null;
}
