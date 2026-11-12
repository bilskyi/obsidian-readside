import { useEffect, useRef, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from './icons';

/**
 * `42 / 310 ‹ ›`: click the number to type a page (file page numbers). Enter jumps and calls `onJumped`
 * (the reader hands focus back to the page); Esc cancels and refocuses the number. ‹ › call `onStep`
 * (the reader steps from its pending jump, like the page keys) and disable at the ends of `target ?? page`.
 */
export function PageNav({
  page,
  pageCount,
  target = null,
  onGoToPage,
  onStep,
  onJumped,
  unit = 'page',
}: {
  page: number;
  pageCount: number;
  /** The page a jump still in flight is heading to; null when none. */
  target?: number | null;
  onGoToPage: (page: number) => void;
  /** Without it, ‹ › go to page ± 1. */
  onStep?: (dir: 1 | -1) => void;
  onJumped?: () => void;
  /** What is stepped through: PDF pages, or EPUB sections (`§ 2 / 5`; PageUp/PageDown scroll there, ⌥←/⌥→ step). */
  unit?: 'page' | 'section';
}) {
  const section = unit === 'section';
  const Unit = section ? 'Section' : 'Page';
  const at = target ?? page;
  const step = (dir: 1 | -1) => (onStep ? onStep(dir) : onGoToPage(at + dir));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const numberRef = useRef<HTMLButtonElement>(null);
  /** Set by Enter/Escape so focus goes back to the number (not on blur, where focus is going elsewhere). */
  const refocus = useRef(false);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (refocus.current) {
      refocus.current = false;
      numberRef.current?.focus();
    }
  }, [editing]);

  const finish = (go: boolean) => {
    const text = draft.trim();
    const n = Number(text);
    const jump = go && text !== '' && Number.isFinite(n);
    // A jump hands focus to the page (if the reader takes it); otherwise focus returns to the number.
    refocus.current = !(jump && onJumped);
    setEditing(false);
    if (jump) {
      onGoToPage(Math.min(pageCount, Math.max(1, Math.round(n))));
      onJumped?.();
    }
  };

  return (
    <div className="page-nav" role="group" aria-label={`${Unit} navigation`}>
      <button
        type="button"
        className="tool-btn icon-btn"
        aria-label={`Previous ${Unit}`}
        aria-keyshortcuts={section ? 'Alt+ArrowLeft' : 'PageUp Alt+ArrowLeft'}
        title={section ? 'Previous Section (⌥←)' : 'Previous Page (PgUp or ⌥←)'}
        disabled={at <= 1}
        onClick={() => step(-1)}
      >
        <ChevronLeftIcon />
      </button>
      {editing ? (
        <input
          ref={inputRef}
          className="page-input"
          data-reader-field=""
          aria-label={`Go to ${unit} (1–${pageCount})`}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          style={{ width: `${String(pageCount).length + 2}ch` }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              finish(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              finish(false);
            }
          }}
          onBlur={() => setEditing(false)}
        />
      ) : (
        <button
          ref={numberRef}
          type="button"
          className="page-number"
          aria-label={section ? `§ ${page} / ${pageCount}, go to section` : `${page} / ${pageCount}, go to page`}
          title={`Go to ${Unit}`}
          onClick={() => {
            setDraft(String(page));
            setEditing(true);
          }}
        >
          {/* key: a new page number remounts, so it "ticks" in (spec §6) */}
          <span key={page} className="page-current">
            {section ? `§ ${page}` : page}
          </span>
          <span className="page-of">/ {pageCount}</span>
        </button>
      )}
      <button
        type="button"
        className="tool-btn icon-btn"
        aria-label={`Next ${Unit}`}
        aria-keyshortcuts={section ? 'Alt+ArrowRight' : 'PageDown Alt+ArrowRight'}
        title={section ? 'Next Section (⌥→)' : 'Next Page (PgDn or ⌥→)'}
        disabled={at >= pageCount}
        onClick={() => step(1)}
      >
        <ChevronRightIcon />
      </button>
    </div>
  );
}
