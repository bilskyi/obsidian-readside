import { useEffect, useRef } from 'react';
import { ArrowDownIcon, ArrowUpIcon, CloseIcon, SearchIcon } from '../toolbar/icons';
import { placeNameFor } from '../../../lib/location';
import { useSearch, type SearchDeps } from './useSearch';
import './search.css';

/** The results list stops here; the count still shows every match. */
const MAX_LISTED = 500;

export interface SearchBarProps {
  deps: SearchDeps;
  /** 0 until the book is open: the field stays disabled and says Loading… until then. */
  pageCount: number;
  /** Bumped by ⌘F while the bar is open: refocus and select the field. */
  focusSignal: number;
  onClose: () => void;
  /** Pages (PDF) or sections (EPUB: results say `§ N`). Default 'pdf'. */
  format?: 'pdf' | 'epub';
}

/** Full-width bar sliding down from under the toolbar (spec §5.1): field, `3 of 27`, ↑ ↓, close; results listed below the field. */
export function SearchBar({ deps, pageCount, focusSignal, onClose, format = 'pdf' }: SearchBarProps) {
  const epub = format === 'epub';
  const { query, setQuery, run, index, next, prev, select, flush } = useSearch(deps);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const ready = pageCount > 0;

  // A disabled field can't take focus, so focus again once the book is open.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal, ready]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [index]);

  const q = query.trim();
  const count = !ready
    ? 'Loading…'
    : !q
      ? ''
      : run.hits.length
        ? `${Math.max(0, index) + 1} of ${run.hits.length}`
        : run.done
          ? 'No matches'
          : '';

  return (
    <div
      className="search-bar"
      role="search"
      aria-label="Find in book"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="search-row">
        <span className="search-glyph">
          <SearchIcon />
        </span>
        <input
          ref={inputRef}
          type="search"
          className="search-field"
          data-reader-field=""
          aria-label="Search in book"
          placeholder="Search in book"
          autoComplete="off"
          spellCheck={false}
          disabled={!ready}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            // Typed faster than the debounce: search now; its first match becomes current.
            if (flush()) return;
            if (e.shiftKey) prev();
            else next();
          }}
        />
        <span className="search-count" role="status">
          {count}
        </span>
        <button
          type="button"
          className="tool-btn icon-btn"
          aria-label="Previous Match"
          title="Previous Match (⇧↩)"
          disabled={!run.hits.length}
          onClick={prev}
        >
          <ArrowUpIcon />
        </button>
        <button
          type="button"
          className="tool-btn icon-btn"
          aria-label="Next Match"
          title="Next Match (↩)"
          disabled={!run.hits.length}
          onClick={next}
        >
          <ArrowDownIcon />
        </button>
        <button type="button" className="tool-btn icon-btn" aria-label="Close Search" title="Close (Esc)" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      {q && !run.done && ready && (
        <p className="search-progress">
          Searching… {run.scanned} of {pageCount} {epub ? 'sections' : 'pages'}
        </p>
      )}
      {q && run.done && run.noText > 0 && (
        <p className="search-note">
          {epub
            ? `${run.noText === 1 ? '1 section has' : `${run.noText} sections have`} no text to search (images only).`
            : <>{run.noText === 1 ? '1 page has' : `${run.noText} pages have`} no text to search (scanned pages).</>}
        </p>
      )}
      {run.hits.length > 0 && (
        <ol ref={listRef} className="search-results" aria-label="Matches">
          {run.hits.slice(0, MAX_LISTED).map((h, i) => (
            <li key={`${h.page}:${h.start}`}>
              <button
                type="button"
                className="search-result"
                aria-current={i === index ? 'true' : undefined}
                onClick={() => select(h)}
              >
                <span className="search-result-page">{epub ? placeNameFor('epub', h.page) : <>p. {h.page}</>}</span>{' '}
                <span className="search-result-text">
                  {h.snippet.before}
                  <mark>{h.snippet.match}</mark>
                  {h.snippet.after}
                </span>
              </button>
            </li>
          ))}
          {run.hits.length > MAX_LISTED && (
            <li className="search-more">
              Showing the first {MAX_LISTED} of {run.hits.length} matches.
            </li>
          )}
        </ol>
      )}
    </div>
  );
}
