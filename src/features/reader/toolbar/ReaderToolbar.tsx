import type { Zoom, ZoomState } from '../../../renderers/types';
import { ContentsIcon, FocusIcon, LibraryIcon, NotebookIcon, PlusIcon, SearchIcon } from './icons';
import { PageNav } from './PageNav';
import { ZoomControl } from './ZoomControl';
import './toolbar.css';

export interface ReaderToolbarProps {
  title: string;
  /** The centre title shows unless false (the Obsidian view header already shows it); the heading stays for screen readers. */
  showTitle?: boolean;
  /** Current page; null for formats without pages. */
  page: number | null;
  /** 0 until the book is open: page navigation, zoom and progress stay hidden. */
  pageCount: number;
  zoom: ZoomState | null;
  notebookOpen: boolean;
  canAddThought: boolean;
  /** Shows "‹ Library" (desktop), or what `backButton` says (Obsidian: its shelf). */
  onBack?: () => void;
  /** The back button's text, tooltip and icon; default "‹ Library" with no tooltip. */
  backButton?: BackButton;
  onGoToPage: (page: number) => void;
  /** ‹ › (the reader steps from its pending jump target); without it they go to page ± 1. */
  onStepPage?: (dir: 1 | -1) => void;
  /** The page a jump still in flight is heading to (‹ › disable at its ends); null when none. */
  pageTarget?: number | null;
  onZoom: (zoom: Zoom) => void;
  onAddThought: () => void;
  onToggleNotebook: () => void;
  /** Called after a typed page jump or a zoom menu choice, to hand keyboard focus back to the page. */
  onReturnToPage?: () => void;
  /** Search and Contents buttons render only when their handler is given. */
  searchOpen?: boolean;
  onToggleSearch?: () => void;
  contentsOpen?: boolean;
  onToggleContents?: () => void;
  /** Focus mode's button renders only with this. */
  onToggleFocus?: () => void;
  /** Pages (PDF) or sections (EPUB: `§ 2 / 5`, no Fit Page). */
  unit?: 'page' | 'section';
  /** The fraction read (0–1) when the book says so itself (EPUB); otherwise page / pageCount. */
  progress?: number;
}

export interface BackButton {
  label: string;
  title?: string;
  /** 'chevron' (default): `‹ Label`; 'library': a shelf icon before the label. */
  icon?: 'chevron' | 'library';
}

/** `‹ Library │ 42 / 310 ‹ › │ title │ − 110% + │ Search │ Contents │ + Thought │ Notebook`, progress along the bottom (spec §5.1). */
export function ReaderToolbar(p: ReaderToolbarProps) {
  const open = p.pageCount > 0 && p.page !== null;
  const fraction = open ? Math.min(1, Math.max(0, p.progress ?? p.page! / p.pageCount)) : 0;
  return (
    <header className="reader-bar">
      <div className="bar-start">
        {p.onBack && (
          <button type="button" className="back-btn" title={p.backButton?.title} onClick={p.onBack}>
            {p.backButton?.icon === 'library' ? (
              <LibraryIcon />
            ) : (
              <span className="back-chevron" aria-hidden="true">
                ‹
              </span>
            )}
            {p.backButton?.label ?? 'Library'}
          </button>
        )}
        {open && (
          <PageNav
            page={p.page!}
            pageCount={p.pageCount}
            target={p.pageTarget}
            onGoToPage={p.onGoToPage}
            onStep={p.onStepPage}
            onJumped={p.onReturnToPage}
            unit={p.unit}
          />
        )}
      </div>
      {p.showTitle !== false ? (
        <h1 className="reader-title" title={p.title}>
          {p.title}
        </h1>
      ) : (
        // The host shows the title already: an empty centre cell, the heading kept for screen readers only.
        <div className="bar-spacer">
          <h1 className="visually-hidden">{p.title}</h1>
        </div>
      )}
      <div className="reader-tools">
        {open && p.zoom && <ZoomControl zoom={p.zoom} onZoom={p.onZoom} onPicked={p.onReturnToPage} allowFitPage={p.unit !== 'section'} />}
        {p.onToggleSearch && (
          <button
            type="button"
            className="tool-btn"
            aria-label="Search"
            aria-pressed={!!p.searchOpen}
            aria-keyshortcuts="Meta+F"
            title="Search in Book (⌘F)"
            onClick={p.onToggleSearch}
          >
            <SearchIcon />
            <span className="tool-label">Search</span>
          </button>
        )}
        {p.onToggleContents && (
          <button
            type="button"
            className="tool-btn"
            aria-label="Contents"
            aria-pressed={!!p.contentsOpen}
            aria-keyshortcuts="Meta+Shift+C"
            title="Contents (⌘⇧C)"
            onClick={p.onToggleContents}
          >
            <ContentsIcon />
            <span className="tool-label">Contents</span>
          </button>
        )}
        {p.onToggleFocus && (
          <button
            type="button"
            className="tool-btn icon-btn"
            aria-label="Focus mode"
            aria-keyshortcuts="Meta+."
            title="Focus Mode (⌘.)"
            onClick={p.onToggleFocus}
          >
            <FocusIcon />
          </button>
        )}
        <button
          type="button"
          className="tool-btn thought-btn"
          aria-label="New Thought"
          aria-keyshortcuts="Meta+Shift+M"
          title="New Thought at the Reading Line (⌘⇧M)"
          disabled={!p.canAddThought}
          onClick={p.onAddThought}
        >
          <PlusIcon />
          <span className="tool-label">Thought</span>
        </button>
        <button
          type="button"
          className="tool-btn"
          aria-label="Notebook"
          aria-pressed={p.notebookOpen}
          aria-keyshortcuts={'Meta+\\'}
          title="Notebook (⌘\)"
          onClick={p.onToggleNotebook}
        >
          <NotebookIcon />
          <span className="tool-label">Notebook</span>
          <span className="key-hint tool-label" aria-hidden="true">
            ⌘\
          </span>
        </button>
      </div>
      {open && (
        <div
          className="reading-progress"
          role="progressbar"
          aria-label="Reading progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fraction * 100)}
          aria-valuetext={`${p.unit === 'section' ? 'Section' : 'Page'} ${p.page} of ${p.pageCount}`}
        >
          <div className="reading-progress-fill" style={{ clipPath: `inset(0 ${(1 - fraction) * 100}% 0 0)` }} />
        </div>
      )}
    </header>
  );
}
