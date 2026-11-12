import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { placeNameFor } from '../../../lib/location';
import { countBySection, sectionPath } from '../../../lib/outline';
import type { Location, OutlineEntry } from '../../../lib/types';
import { ChevronRightIcon } from '../toolbar/icons';
import './contents.css';

export interface ContentsPanelProps {
  /** null while loading; [] for a PDF without a table of contents. */
  outline: OutlineEntry[] | null;
  /** The outline couldn't be read (`outline` is then []): say so instead of "no table of contents". */
  outlineFailed?: boolean;
  pageCount: number;
  currentPage: number | null;
  /** The page of every thought that has one, for the per-section badges. */
  thoughtPages: readonly number[];
  width: number;
  onNavigate: (page: number) => void;
  /** An entry that names its own spot (`at`: an EPUB fragment) goes there instead of its page's top. */
  onNavigateTo?: (at: Location) => void;
  /** Pages (PDF) or sections (EPUB: `§ N`). Default 'pdf'. */
  format?: 'pdf' | 'epub';
}

/** A row's jump: its page, and its own spot when it has one. */
type Navigate = (page: number, at?: Location) => void;

const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');
const thoughtsLabel = (n: number) => (n === 1 ? '1 thought' : `${n} thoughts`);
const NO_PATH: readonly OutlineEntry[] = [];
const samePath = (a: readonly OutlineEntry[], b: readonly OutlineEntry[]) =>
  a.length === b.length && a.every((e, i) => e === b[i]);

function CountBadge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <>
      <span className="toc-count" aria-hidden="true">
        {n}
      </span>
      <span className="visually-hidden">, {thoughtsLabel(n)}</span>
    </>
  );
}

/** Keeps the current row visible in the list as the reader moves through the book. */
function useScrollIntoViewWhen(current: boolean) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (current) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [current]);
  return ref;
}

/**
 * Closing the panel (⌘⇧C) while focus is inside it would drop focus to the body. Hand it to the toolbar's
 * Contents button, or else to the page. A layout-effect cleanup runs before the panel leaves the DOM, so
 * focus is still known to be inside it.
 */
function useFocusHandoffOnClose(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const panel = ref.current;
    return () => {
      if (!panel || !panel.contains(document.activeElement)) return;
      const button = document.querySelector<HTMLElement>('button[aria-label="Contents"]');
      if (button && !panel.contains(button)) {
        button.focus();
        return;
      }
      const page = document.querySelector<HTMLElement>('.reader-host .pdf-scroller') ?? document.querySelector<HTMLElement>('.reader-host');
      if (!page) return;
      if (!page.hasAttribute('tabindex')) page.tabIndex = -1;
      page.focus({ preventScroll: true });
    };
  }, [ref]);
}

/** Left sidebar (spec §5.1): nested, collapsible outline; current section marked; thought counts; click jumps. */
export function ContentsPanel({
  outline,
  outlineFailed = false,
  pageCount,
  currentPage,
  thoughtPages,
  width,
  onNavigate,
  onNavigateTo,
  format = 'pdf',
}: ContentsPanelProps) {
  const navRef = useRef<HTMLElement>(null);
  useFocusHandoffOnClose(navRef);

  // The parent may pass a new callback every render; rows get a stable one so they can skip re-rendering.
  const navigateRef = useRef(onNavigate);
  const navigateToRef = useRef(onNavigateTo);
  useLayoutEffect(() => {
    navigateRef.current = onNavigate;
    navigateToRef.current = onNavigateTo;
  });
  const navigate = useCallback<Navigate>((page, at) => {
    const to = navigateToRef.current;
    if (at && to) to(at);
    else navigateRef.current(page);
  }, []);

  // The section path, kept as the same array while the current section stays the same (most page turns).
  const nextPath = useMemo(
    () => (outline && currentPage !== null ? sectionPath(outline, currentPage) : NO_PATH),
    [outline, currentPage],
  );
  const [path, setPath] = useState(nextPath);
  if (!samePath(path, nextPath)) setPath(nextPath);

  const counts = useMemo(
    () => (outline ? countBySection(outline, thoughtPages) : new Map<OutlineEntry, number>()),
    [outline, thoughtPages],
  );
  const [expanded, setExpanded] = useState<ReadonlySet<OutlineEntry>>(() => new Set());
  // When the current section changes, its ancestors open. A section the reader collapsed stays collapsed
  // while they read on inside it; nothing the reader opened is closed.
  useEffect(() => {
    const ancestors = path.slice(0, -1);
    if (!ancestors.length) return;
    setExpanded((s) => (ancestors.every((e) => s.has(e)) ? s : new Set([...s, ...ancestors])));
  }, [path]);
  const toggle = useCallback(
    (e: OutlineEntry) =>
      setExpanded((s) => {
        const n = new Set(s);
        if (n.has(e)) n.delete(e);
        else n.add(e);
        return n;
      }),
    [],
  );
  const currentEntry = path.length ? path[path.length - 1] : null;

  return (
    <nav ref={navRef} className="contents" aria-label="Contents" style={{ '--panel-width': `${width}px` } as CSSProperties}>
      <header className="contents-bar">
        <h2 className="contents-title">Contents</h2>
      </header>
      <div className="contents-scroll">
        {outline === null ? (
          <p className="contents-empty">Loading contents…</p>
        ) : outline.length === 0 ? (
          <>
            <p className="contents-empty">
              {outlineFailed
                ? `Couldn’t read this book’s table of contents. Jump to a ${format === 'epub' ? 'section' : 'page'} instead.`
                : format === 'epub'
                  ? 'This book has no table of contents. Jump to a section instead.'
                  : 'This PDF has no table of contents. Jump to a page instead.'}
            </p>
            <PageList
              pageCount={pageCount}
              currentPage={currentPage}
              thoughtPages={thoughtPages}
              onNavigate={navigate}
              format={format}
            />
          </>
        ) : (
          <ul className="toc">
            {outline.map((entry, i) => {
              const onPath = path.includes(entry);
              return (
                <TocItem
                  key={i}
                  entry={entry}
                  depth={0}
                  current={entry === currentEntry}
                  onPath={onPath && entry !== currentEntry}
                  path={onPath ? path : NO_PATH}
                  counts={counts}
                  expanded={expanded}
                  onToggle={toggle}
                  onNavigate={navigate}
                  format={format}
                />
              );
            })}
          </ul>
        )}
      </div>
    </nav>
  );
}

interface TocItemProps {
  entry: OutlineEntry;
  depth: number;
  current: boolean;
  /** An ancestor of the current section. */
  onPath: boolean;
  /** The current section path, passed only into the branch that holds it (NO_PATH elsewhere). */
  path: readonly OutlineEntry[];
  counts: ReadonlyMap<OutlineEntry, number>;
  expanded: ReadonlySet<OutlineEntry>;
  onToggle: (e: OutlineEntry) => void;
  onNavigate: Navigate;
  format: 'pdf' | 'epub';
}

const TocItem = memo(function TocItem({
  entry,
  depth,
  current,
  onPath,
  path,
  counts,
  expanded,
  onToggle,
  onNavigate,
  format,
}: TocItemProps) {
  const kids = entry.children.length > 0;
  const open = kids && expanded.has(entry);
  const linkRef = useScrollIntoViewWhen(current);
  const currentEntry = path.length ? path[path.length - 1] : null;
  return (
    <li className="toc-item">
      <div className={cx('toc-row', current && 'is-current', onPath && 'on-path')} style={{ paddingLeft: 4 + depth * 14 }}>
        {kids ? (
          <button
            type="button"
            className="toc-twisty"
            aria-expanded={open}
            aria-label={`${entry.title} subsections`}
            onClick={() => onToggle(entry)}
          >
            <ChevronRightIcon />
          </button>
        ) : (
          <span className="toc-twisty" aria-hidden="true" />
        )}
        <button
          ref={linkRef}
          type="button"
          className="toc-link"
          disabled={entry.page === null}
          aria-current={current ? 'location' : undefined}
          title={
            entry.page === null
              ? `This entry doesn’t point to a ${format === 'epub' ? 'section' : 'page'}`
              : format === 'epub'
                ? `Go to ${placeNameFor('epub', entry.page)}`
                : `Go to page ${entry.page}`
          }
          onClick={() => entry.page !== null && onNavigate(entry.page, entry.at)}
        >
          <span className="toc-title">{entry.title}</span>
          <CountBadge n={counts.get(entry) ?? 0} />
          <span className="toc-page" aria-hidden="true">
            {entry.page ?? '–'}
          </span>
        </button>
      </div>
      {open && (
        <ul className="toc-children">
          {entry.children.map((c, i) => {
            const childOnPath = path.includes(c);
            return (
              <TocItem
                key={i}
                entry={c}
                depth={depth + 1}
                current={c === currentEntry}
                onPath={childOnPath && c !== currentEntry}
                path={childOnPath ? path : NO_PATH}
                counts={counts}
                expanded={expanded}
                onToggle={onToggle}
                onNavigate={onNavigate}
                format={format}
              />
            );
          })}
        </ul>
      )}
    </li>
  );
});

/** The no-outline fallback: one row per page, with that page's thought count. */
function PageList({
  pageCount,
  currentPage,
  thoughtPages,
  onNavigate,
  format,
}: Pick<ContentsPanelProps, 'pageCount' | 'currentPage' | 'thoughtPages' | 'onNavigate'> & { format: 'pdf' | 'epub' }) {
  const perPage = useMemo(() => {
    const m = new Map<number, number>();
    for (const p of thoughtPages) m.set(p, (m.get(p) ?? 0) + 1);
    return m;
  }, [thoughtPages]);
  return (
    <ol className="toc page-list">
      {Array.from({ length: pageCount }, (_, i) => i + 1).map((p) => (
        <PageRow
          key={p}
          page={p}
          current={p === currentPage}
          count={perPage.get(p) ?? 0}
          onNavigate={onNavigate}
          format={format}
        />
      ))}
    </ol>
  );
}

/** One page of the fallback list. Memoized: a page turn re-renders only the old and the new current row. */
const PageRow = memo(function PageRow({
  page,
  current,
  count,
  onNavigate,
  format,
}: {
  page: number;
  current: boolean;
  count: number;
  onNavigate: (page: number) => void;
  format: 'pdf' | 'epub';
}) {
  const ref = useScrollIntoViewWhen(current);
  return (
    <li className="toc-item">
      <div className={cx('toc-row', current && 'is-current')}>
        <button
          ref={ref}
          type="button"
          className="toc-link"
          aria-current={current ? 'location' : undefined}
          onClick={() => onNavigate(page)}
        >
          <span className="toc-title">{format === 'epub' ? placeNameFor('epub', page) : <>Page {page}</>}</span>
          <CountBadge n={count} />
        </button>
      </div>
    </li>
  );
});
