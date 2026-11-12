import { Keymap, type PaneType } from 'obsidian';
import { Component, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { debounce } from '../../../src/lib/debounce';
import type { Location } from '../../../src/lib/types';
import type { ShelfEntry } from '../store/bookStore';
import type { CoverView } from '../covers/covers';
import {
  REFRESH_DEBOUNCE_MS,
  SEARCH_CHUNK,
  SEARCH_DEBOUNCE_MS,
  ago,
  cardLabel,
  countsLabel,
  coverColor,
  loadBooks,
  placeOf,
  recentThoughts,
  resurface,
  searchBooks,
  searchOrder,
  shelfBooks,
  summaryLine,
  whereLabel,
  type BookSource,
  type LoadedBooks,
  type RecentThought,
  type Resurfaced,
  type SearchGroup,
  type ShelfBook,
} from './shelfData';
import './shelf.css';

/** What the shelf reads from the plugin. */
export interface ShelfSource extends BookSource {
  /** Every book, from the index alone. */
  entries(): ShelfEntry[];
  /**
   * Calls `onChange` when a book or the index changes; returns the unsubscribe. A book's change names it
   * (`bookId`); an index change does not.
   */
  subscribe(onChange: (bookId?: string) => void): () => void;
  /** What a book's cover shows (absent: every card shows its colour tile). */
  cover?(entry: ShelfEntry): CoverView;
  /** A card wants its first-page thumbnail made (in the background). */
  requestCover?(bookId: string): void;
  /** Opens the card's cover menu, at the pointer (right-click) or at a point (under the "⋯" button). */
  coverMenu?(bookId: string, title: string, at: globalThis.MouseEvent | { x: number; y: number }, opener?: HTMLElement): void;
}

/** Whether the shelf is on screen: a hidden shelf postpones its refreshes until it is shown. */
export interface ShelfVisibility {
  visible(): boolean;
  /** Calls `onShow` when the shelf may have come on screen; returns the unsubscribe. */
  onShow(onShow: () => void): () => void;
}

/** What Back restores: the search and how far the shelf was scrolled. */
export interface ShelfState {
  query: string;
  scroll: number;
}

/** Where a book opens: false replaces the shelf in its tab; a pane type (⌘/Ctrl- or middle-click) opens a new one. */
export type OpenIn = PaneType | false;

export interface ShelfProps {
  source: ShelfSource;
  /** Resolves once the store has loaded. */
  ready: Promise<void>;
  /** Opens the book at `path`, at `location` (null: where it was left). */
  onOpen: (path: string, location: Location | null, openIn: OpenIn) => void;
  /** The PDF picker. */
  onPick: () => void;
  /** Absent: always on screen. */
  visibility?: ShelfVisibility;
  /** The state to start from (Back). */
  initialState?: ShelfState;
  /** Told whenever the query or the scroll changes. */
  onStateChange?: (state: ShelfState) => void;
  now?: () => Date;
  random?: () => number;
}

const TITLE = 'Margin shelf';
const ALWAYS_VISIBLE: ShelfVisibility = { visible: () => true, onShow: () => () => {} };

/** What the index says about which books there are and where: a change in it adds, moves or removes entries. */
const structureKey = (entries: readonly ShelfEntry[]) => entries.map((e) => `${e.path}\u0000${e.bookId}\u0000${e.missing ? 1 : 0}`).join('\u0001');

/** Click handlers for something that opens a book: a plain click, a ⌘/Ctrl-click, or a middle click. */
function opener(go: (openIn: OpenIn) => void) {
  return {
    // A middle press would start the browser's autoscroll; the click that follows opens the book.
    onMouseDown: (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    },
    onClick: (e: MouseEvent) => {
      const pane = Keymap.isModEvent(e.nativeEvent);
      go(pane === true ? 'tab' : pane);
    },
    onAuxClick: (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      go('tab');
    },
  };
}

const OPEN_LABEL = 'Open a book…';

/** null: not loaded yet. */
type Loadable<T> = T | null;

export function Shelf({ source, ready, onOpen, onPick, visibility = ALWAYS_VISIBLE, initialState, onStateChange, now = () => new Date(), random = Math.random }: ShelfProps) {
  const [entries, setEntries] = useState<ShelfEntry[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** Bumped when the books change: background lists load again. */
  const [version, setVersion] = useState(0);
  const loaded = useRef<LoadedBooks>(new Map());
  const alive = useRef(true);
  const nowRef = useRef(now);
  nowRef.current = now;
  const randomRef = useRef(random);
  randomRef.current = random;

  useEffect(() => {
    alive.current = true;
    // This run's own flag: StrictMode runs the effect twice, and a first run's late `ready` must not subscribe.
    let live = true;
    let unsubscribe = () => {};
    /** A change came while the shelf was hidden: it refreshes once it is shown. */
    let stale = false;
    /** Books that changed since the last reload: only these are read again. */
    const dirty = new Set<string>();
    /** A change we cannot place (or no entries seen yet): everything is read again. */
    let lastKey: string | null = null;
    const reload = () => {
      stale = false;
      const next = source.entries();
      const key = structureKey(next);
      let reread = dirty.size > 0;
      if (key !== lastKey) {
        reread = true;
        // An entry was added, moved, removed or marked: what was read may belong to other books now.
        loaded.current = new Map();
        lastKey = key;
      } else {
        // The live books replace what was read of the ones that changed; the others are as they were.
        for (const id of dirty) loaded.current.delete(id);
      }
      dirty.clear();
      setEntries(next);
      if (reread) setVersion((v) => v + 1);
    };
    const refresh = debounce(() => {
      if (!live) return;
      if (visibility.visible()) reload();
      else stale = true;
    }, REFRESH_DEBOUNCE_MS);
    const onSource = (bookId?: string) => {
      if (bookId !== undefined) dirty.add(bookId);
      refresh();
    };
    const offShow = visibility.onShow(() => {
      if (!live) return;
      if (!visibility.visible()) {
        // Gone from sight: what was read for a search is let go (a shelf in a background tab keeps nothing).
        loaded.current = new Map();
        return;
      }
      if (stale) reload();
    });
    ready.then(
      () => {
        if (!live) return;
        const first = source.entries();
        lastKey = structureKey(first);
        setEntries(first);
        unsubscribe = source.subscribe(onSource);
      },
      (e: unknown) => live && setFailed(String(e)),
    );
    return () => {
      live = false;
      alive.current = false;
      refresh.cancel();
      offShow();
      unsubscribe();
    };
  }, [source, ready, visibility]);

  // Re-made with each refresh (a new entries array), so a cover that landed shows on the next one.
  const books = useMemo(() => (entries ? shelfBooks(entries, source.cover ? (e) => source.cover!(e) : undefined) : []), [entries, source]);
  const stopped = useCallback(() => !alive.current, []);

  // ---- search ----
  const searchId = useId();
  const [query, setQuery] = useState(initialState?.query ?? '');
  const [debounced, setDebounced] = useState(initialState?.query ?? '');
  /** The results, the query they are for, and whether every book has been read for it. */
  const [results, setResults] = useState<Loadable<{ q: string; groups: SearchGroup[]; done: boolean }>>(null);
  const hadQuery = useRef(false);
  const setDebouncedLater = useMemo(() => debounce((q: string) => setDebounced(q), SEARCH_DEBOUNCE_MS), []);
  useEffect(() => () => setDebouncedLater.cancel(), [setDebouncedLater]);
  useEffect(() => {
    const q = debounced.trim();
    if (!q) {
      // A search just ended: the books it read are let go (the lists below keep reading what they need).
      if (hadQuery.current) loaded.current = new Map();
      hadQuery.current = false;
      setResults(null);
      return;
    }
    hadQuery.current = true;
    let current = true;
    const stop = () => !current || !alive.current;
    const store = loaded.current;
    const order = searchOrder(books);
    void (async () => {
      // What is found so far shows after each chunk; a newer query (or a refresh) drops this one.
      for (let i = 0; i < order.length; i += SEARCH_CHUNK) {
        await loadBooks(source, order.slice(i, i + SEARCH_CHUNK), store, stop);
        if (stop()) return;
        setResults({ q, groups: searchBooks(q, books, store), done: i + SEARCH_CHUNK >= order.length });
      }
      if (order.length === 0) setResults({ q, groups: [], done: true });
    })();
    return () => {
      current = false;
    };
  }, [debounced, books, source, version]);
  const searching = query.trim() !== '';

  // ---- what Back restores ----
  const scroller = useRef<HTMLDivElement | null>(null);
  const scrollTop = useRef(initialState?.scroll ?? 0);
  /** A restored scroll still to reach: it is set again as the content it needs comes in. */
  const pendingScroll = useRef(initialState?.scroll ?? 0);
  const onStateRef = useRef(onStateChange);
  onStateRef.current = onStateChange;
  useEffect(() => {
    onStateRef.current?.({ query, scroll: scrollTop.current });
  }, [query]);

  // ---- recent thoughts and a highlight from a while ago: after the first paint, in the background ----
  const [recent, setRecent] = useState<Loadable<RecentThought[]>>(null);
  const [old, setOldState] = useState<Loadable<Resurfaced | false>>(null);
  const oldRef = useRef<Resurfaced | null>(null);
  /** Counts resurface requests: only the newest one's answer is shown. */
  const oldRequest = useRef(0);
  const setOld = useCallback((o: Resurfaced | null) => {
    oldRef.current = o;
    setOldState(o ?? false);
  }, []);
  useEffect(() => {
    if (!entries || entries.length === 0) return;
    let current = true;
    const stop = () => !current || !alive.current;
    const timer = setTimeout(() => {
      void (async () => {
        const r = await recentThoughts(books, source, loaded.current, stop);
        if (stop()) return;
        setRecent(r);
        // The highlight on screen stays while it is still there and its book can be opened; another only on "Show another".
        const shown = oldRef.current;
        if (shown && books.some((b) => b.bookId === shown.book.bookId && !b.missing)) {
          await loadBooks(source, [shown.book.bookId], loaded.current, stop);
          if (stop()) return;
          if (loaded.current.get(shown.book.bookId)?.annotations.some((a) => a.id === shown.id)) return;
        }
        const req = ++oldRequest.current;
        const o = await resurface(books, source, loaded.current, nowRef.current(), randomRef.current, null, stop);
        if (stop() || req !== oldRequest.current) return;
        setOld(o);
      })();
    }, 0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [entries, books, source, version, setOld]);

  const showAnother = useCallback(async () => {
    // Only the newest request shows: an older "Show another" (or background pass) resolving later is dropped.
    const req = ++oldRequest.current;
    const o = await resurface(books, source, loaded.current, nowRef.current(), randomRef.current, oldRef.current?.id ?? null, stopped);
    if (!alive.current || req !== oldRequest.current) return;
    setOld(o);
  }, [books, source, stopped, setOld]);

  const trimmed = query.trim();
  const resultsFor = results?.q === trimmed ? results : null;
  useLayoutEffect(() => {
    const el = scroller.current;
    const want = pendingScroll.current;
    if (!el || want <= 0) return;
    el.scrollTop = want;
    const complete = searching ? !!resultsFor?.done : entries !== null && recent !== null && old !== null;
    if (el.scrollTop >= want - 1 || complete) pendingScroll.current = 0;
  });

  if (failed !== null) {
    return (
      <div className="shelf">
        <h1 className="shelf-title">{TITLE}</h1>
        <p className="shelf-sub" role="alert">
          Margin couldn't read its saved books: {failed}
        </p>
      </div>
    );
  }
  if (entries === null) return <div className="shelf" aria-busy="true" />;

  if (entries.length === 0) {
    return (
      <div className="shelf">
        <div className="shelf-empty">
          <h1 className="shelf-title">{TITLE}</h1>
          <p className="shelf-empty-text">Open a PDF or EPUB in Margin to start your shelf</p>
          <button type="button" className="shelf-button shelf-button-primary" onClick={onPick}>
            {OPEN_LABEL}
          </button>
        </div>
      </div>
    );
  }

  const status = searching ? searchStatus(trimmed, resultsFor) : '';
  return (
    <div
      className="shelf"
      ref={scroller}
      onScroll={(e) => {
        scrollTop.current = e.currentTarget.scrollTop;
        onStateRef.current?.({ query, scroll: scrollTop.current });
      }}
    >
      <header className="shelf-header">
        <div className="shelf-heading">
          <h1 className="shelf-title">{TITLE}</h1>
          <p className="shelf-sub">{summaryLine(books, now())}</p>
        </div>
        <div className="shelf-tools">
          <button type="button" className="shelf-button" onClick={onPick}>
            {OPEN_LABEL}
          </button>
          <div className="shelf-search" role="search">
            <label htmlFor={searchId} className="shelf-search-label">
              <SearchIcon />
              <span className="shelf-visually-hidden">Search all highlights and thoughts</span>
            </label>
            <input
              id={searchId}
              type="search"
              className="shelf-search-input"
              placeholder="Search all highlights and thoughts"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setDebouncedLater(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.preventDefault();
                  setQuery('');
                  setDebouncedLater.cancel();
                  setDebounced('');
                }
              }}
            />
          </div>
        </div>
      </header>

      {/* Always there, so screen readers hear each change of it (a region that appears with its text may be missed). */}
      <p className={searching ? 'shelf-quiet shelf-status' : 'shelf-visually-hidden'} role="status">
        {status}
      </p>
      {searching ? (
        <SearchResults results={resultsFor?.groups ?? null} onOpen={onOpen} />
      ) : (
        <>
          <section className="shelf-books" aria-labelledby={`${searchId}-books`}>
            <h2 id={`${searchId}-books`} className="shelf-visually-hidden">
              Books
            </h2>
            <ul className="shelf-grid">
              {books.map((b) => (
                <li key={b.path}>
                  <BookCard book={b} onOpen={onOpen} source={source} />
                </li>
              ))}
            </ul>
          </section>
          <div className="shelf-lower">
            <section className="shelf-panel" aria-labelledby={`${searchId}-recent`}>
              <h2 id={`${searchId}-recent`} className="shelf-panel-title">
                Recent thoughts
              </h2>
              {recent === null ? (
                <p className="shelf-quiet">Loading…</p>
              ) : recent.length === 0 ? (
                <p className="shelf-quiet">Your thoughts on what you read will show up here.</p>
              ) : (
                <ul className="shelf-recent">
                  {recent.map((r) => (
                    <li key={r.id}>
                      <button type="button" className="shelf-recent-item" {...opener((openIn) => onOpen(r.book.path, r.location, openIn))}>
                        <span className="shelf-recent-bar" aria-hidden="true" style={{ '--bar': r.color ? `var(--hl-${r.color}-ink)` : 'var(--ink)' } as CSSProperties} />
                        <span className="shelf-recent-body">
                          <span className="shelf-meta">{where(r.book.title, r.location)}</span>
                          <span className="shelf-recent-text">{r.text}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="shelf-panel shelf-old" aria-labelledby={`${searchId}-old`}>
              <h2 id={`${searchId}-old`} className="shelf-panel-title">
                From your shelf, a while ago
              </h2>
              {old === null ? (
                <p className="shelf-quiet">Loading…</p>
              ) : old === false ? (
                <p className="shelf-quiet">Highlights come back here once they are two weeks old.</p>
              ) : (
                <>
                  <blockquote className="shelf-quote">“{old.quote}”</blockquote>
                  <p className="shelf-meta">
                    {where(old.book.title, old.location)} · highlighted {ago(old.createdAt, now())}
                  </p>
                  <div className="shelf-actions">
                    <button type="button" className="shelf-button" {...opener((openIn) => onOpen(old.book.path, old.location, openIn))}>
                      Open at this spot
                    </button>
                    <button type="button" className="shelf-button shelf-button-quiet" onClick={() => void showAnother()}>
                      Show another
                    </button>
                  </div>
                </>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

/** "Walden · p. 42", "Moby-Dick · § 7", or the title alone for a place without a page. */
const where = (title: string, location: Location | null) => {
  const place = placeOf(location);
  return place !== null ? `${title} · ${place}` : title;
};

function BookCard({ book, onOpen, source }: { book: ShelfBook; onOpen: ShelfProps['onOpen']; source: ShelfSource }) {
  const titleId = useId();
  /** An image that failed to load: the colour tile shows instead until the cover changes. */
  const [broken, setBroken] = useState<string | null>(null);
  const src = book.cover.src !== null && book.cover.src !== broken ? book.cover.src : null;
  const { bookId, title } = book;
  const wantsThumb = book.cover.wantsThumb;
  useEffect(() => {
    if (wantsThumb) source.requestCover?.(bookId);
  }, [source, bookId, wantsThumb]);
  const menu = source.coverMenu
    ? (at: globalThis.MouseEvent | { x: number; y: number }, opener: HTMLElement) => source.coverMenu!(bookId, title, at, opener)
    : null;
  const onContextMenu = menu
    ? (e: MouseEvent) => {
        e.preventDefault();
        menu(e.nativeEvent, e.currentTarget as HTMLElement);
      }
    : undefined;
  const body: ReactNode = (
    <>
      <span className={src ? 'shelf-cover has-image' : 'shelf-cover'} style={{ '--cover': coverColor(book.title) } as CSSProperties}>
        {src && (
          <img
            className="shelf-cover-img"
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => {
              setBroken(src);
              // The thumbnail file may be gone: it is made again (a no-op when it is there).
              source.requestCover?.(bookId);
            }}
          />
        )}
        <span className="shelf-cover-title" id={titleId}>
          {book.title}
        </span>
      </span>
      <span className="shelf-progress" aria-hidden="true">
        <span className="shelf-progress-fill" style={{ width: `${Math.round(book.progress * 100)}%` }} />
      </span>
      <span className="shelf-card-meta">
        <span className={book.missing ? 'shelf-missing' : undefined}>{book.missing ? 'File missing' : whereLabel(book)}</span>
        <span>{countsLabel(book)}</span>
      </span>
    </>
  );
  const card = book.missing ? (
    <div className="shelf-card is-missing" role="group" aria-label={cardLabel(book)} title={`${book.path} is no longer in this vault`} onContextMenu={onContextMenu}>
      {body}
    </div>
  ) : (
    <button
      type="button"
      className="shelf-card"
      aria-label={cardLabel(book)}
      title={book.path}
      onContextMenu={onContextMenu}
      {...opener((openIn) => onOpen(book.path, null, openIn))}
    >
      {body}
    </button>
  );
  return (
    <div className="shelf-card-wrap">
      {card}
      {menu && (
        <button
          type="button"
          className="shelf-card-more"
          aria-label="Cover options"
          aria-describedby={titleId}
          aria-haspopup="menu"
          title="Cover options"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            menu({ x: r.left, y: r.bottom + 4 }, e.currentTarget);
          }}
          onContextMenu={onContextMenu}
        >
          <MoreIcon />
        </button>
      )}
    </div>
  );
}

const matchCount = (groups: readonly SearchGroup[]) => groups.reduce((n, g) => n + g.hits.length + g.more, 0);
const matchesIn = (groups: readonly SearchGroup[]) => {
  const n = matchCount(groups);
  return `${n} ${n === 1 ? 'match' : 'matches'} in ${groups.length} ${groups.length === 1 ? 'book' : 'books'}`;
};

/** "Searching…", "3 matches in 2 books so far…", "Nothing matches “x”." or "3 matches in 2 books". */
function searchStatus(query: string, results: { groups: SearchGroup[]; done: boolean } | null): string {
  if (!results || (!results.done && results.groups.length === 0)) return 'Searching…';
  if (!results.done) return `${matchesIn(results.groups)} so far…`;
  return results.groups.length === 0 ? `Nothing matches “${query}”.` : matchesIn(results.groups);
}

function SearchResults({ results, onOpen }: { results: Loadable<SearchGroup[]>; onOpen: ShelfProps['onOpen'] }) {
  const headingId = useId();
  return (
    <section className="shelf-results" aria-labelledby={headingId}>
      <h2 id={headingId} className="shelf-panel-title">
        Search results
      </h2>
      {results?.map((g) => (
          <section key={g.book.path} className="shelf-result-group" aria-label={g.book.title}>
            <h3 className="shelf-result-book">{g.book.title}</h3>
            <ul className="shelf-result-list">
              {g.hits.map((h) => (
                <li key={`${h.kind}-${h.id}`}>
                  <button type="button" className="shelf-result" {...opener((openIn) => onOpen(g.book.path, h.location, openIn))}>
                    <span className="shelf-meta">
                      {h.kind === 'highlight' ? 'Highlight' : 'Thought'}
                      {placeOf(h.location) !== null ? ` · ${placeOf(h.location)}` : ''}
                    </span>
                    <span className="shelf-result-text">
                      {h.snippet.before}
                      <mark>{h.snippet.match}</mark>
                      {h.snippet.after}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {g.more > 0 && <p className="shelf-quiet">and {g.more} more in this book</p>}
          </section>
        ))}
    </section>
  );
}

/**
 * Whatever goes wrong drawing the shelf (a summary no check foresaw), the tab says so and offers a reload
 * rather than going blank.
 */
export class ShelfBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): Partial<{ failed: boolean }> {
    return { failed: true };
  }
  componentDidCatch(error: unknown): void {
    console.error('margin: the shelf failed to draw', error);
  }
  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="shelf">
          <p className="shelf-sub" role="alert">
            Margin couldn't show the shelf.
          </p>
          <div className="shelf-actions">
            <button type="button" className="shelf-button" onClick={() => this.setState({ failed: false })}>
              Reload
            </button>
          </div>
        </div>
      );
    }
    // Children were unmounted when it failed: Reload mounts them afresh.
    return this.props.children;
  }
}

function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </svg>
  );
}
