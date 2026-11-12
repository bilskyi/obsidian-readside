import { useCallback, useEffect, useRef, useState, type FocusEvent } from 'react';
import type { Zoom, ZoomState } from '../../../renderers/types';
import { CloseIcon, PlusIcon } from '../toolbar/icons';
import { PageNav } from '../toolbar/PageNav';
import { ZoomControl } from '../toolbar/ZoomControl';
import './focus.css';

/** The pill fades after this long without pointer movement or a key. */
export const PILL_FADE_MS = 2500;

export interface FocusPillProps {
  /** The page on screen; null while the book is still opening (the pill then holds only its ×). */
  page: number | null;
  pageCount: number;
  /** The page a jump still in flight is heading to; null when none. */
  pageTarget: number | null;
  zoom: ZoomState | null;
  canAddThought: boolean;
  onGoToPage: (page: number) => void;
  onStepPage: (dir: 1 | -1) => void;
  onZoom: (zoom: Zoom) => void;
  /** After a typed page or a zoom choice: keyboard focus goes back to the page. */
  onReturnToPage: () => void;
  onAddThought: () => void;
  onExit: () => void;
  /** Pointer movement over this element wakes the pill (the reader). */
  pointerArea: HTMLElement | null;
  /** Any key here wakes the pill: the window (desktop) or the host's element (Obsidian). */
  keyArea: 'window' | HTMLElement;
  /** Pages (PDF) or sections (EPUB: `§ 2 / 5`, no Fit Page). */
  unit?: 'page' | 'section';
  /** The fraction read (0–1) when the book says so itself (EPUB); otherwise page / pageCount. */
  progress?: number;
}

/**
 * Focus mode's controls, floating at the bottom centre of the reading column:
 * `‹ 42 / 310 › │ progress │ − 110% + │ + Thought │ ×`. It fades after PILL_FADE_MS without pointer
 * movement or a key and comes back on either; never while hovered, while focus is inside it, or while its
 * zoom menu is open. Faded, it is still in the Tab order: focusing it brings it back.
 */
export function FocusPill(p: FocusPillProps) {
  const [awake, setAwake] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const pinned = hovered || focusWithin || menuOpen;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wake = useCallback(() => {
    setAwake(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAwake(false), PILL_FADE_MS);
  }, []);
  // Shown on arrival; the countdown starts again whenever the pill stops being held (pointer left, focus left).
  useEffect(() => {
    if (!pinned) wake();
  }, [pinned, wake]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const { pointerArea, keyArea } = p;
  useEffect(() => {
    if (!pointerArea) return;
    pointerArea.addEventListener('mousemove', wake);
    pointerArea.addEventListener('pointermove', wake);
    return () => {
      pointerArea.removeEventListener('mousemove', wake);
      pointerArea.removeEventListener('pointermove', wake);
    };
  }, [pointerArea, wake]);
  useEffect(() => {
    // Capture: a key the reader handles (and stops) still wakes the pill.
    const el: Window | HTMLElement = keyArea === 'window' ? window : keyArea;
    el.addEventListener('keydown', wake, true);
    return () => el.removeEventListener('keydown', wake, true);
  }, [keyArea, wake]);

  const page = p.pageCount > 0 ? p.page : null;
  const fraction = page === null ? 0 : Math.min(1, Math.max(0, p.progress ?? page / p.pageCount));
  return (
    // The area spans the reading column's bottom (less its gutters) and is the container the pill's
    // narrow layout measures; the pill itself sizes to its content, centred in it.
    <div className="focus-pill-area">
      <div
        className="focus-pill"
        role="group"
        aria-label="Reader controls"
        data-faded={awake || pinned ? undefined : ''}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocusWithin(true)}
        onBlur={(e: FocusEvent<HTMLDivElement>) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
        }}
      >
        {page !== null && (
          <>
            <PageNav
              page={page}
              pageCount={p.pageCount}
              target={p.pageTarget}
              onGoToPage={p.onGoToPage}
              onStep={p.onStepPage}
              onJumped={p.onReturnToPage}
              unit={p.unit}
            />
            {/* A narrow pill drops the progress bar (and one separator with it) and the zoom steppers. */}
            <span className="focus-pill-sep focus-pill-sep-progress" aria-hidden="true" />
            <div
              className="focus-progress"
              role="progressbar"
              aria-label="Reading progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(fraction * 100)}
              aria-valuetext={`${p.unit === 'section' ? 'Section' : 'Page'} ${page} of ${p.pageCount}`}
            >
              <div className="focus-progress-fill" style={{ width: `${fraction * 100}%` }} />
            </div>
            <span className="focus-pill-sep" aria-hidden="true" />
            {p.zoom && (
              <ZoomControl
                zoom={p.zoom}
                onZoom={p.onZoom}
                onPicked={p.onReturnToPage}
                placement="above"
                onOpenChange={setMenuOpen}
                allowFitPage={p.unit !== 'section'}
              />
            )}
            <button
              type="button"
              className="tool-btn focus-thought"
              aria-label="New Thought"
              aria-keyshortcuts="Meta+Shift+M"
              title="New Thought at the Reading Line (⌘⇧M)"
              disabled={!p.canAddThought}
              onClick={p.onAddThought}
            >
              <PlusIcon />
              Thought
            </button>
          </>
        )}
        <button
          type="button"
          className="tool-btn icon-btn focus-exit"
          aria-label="Leave focus mode"
          aria-keyshortcuts="Meta+. Escape"
          title="Leave Focus Mode (⌘. or Esc)"
          onClick={p.onExit}
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
