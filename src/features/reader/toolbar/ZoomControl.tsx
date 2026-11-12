import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { FLOAT_INSET, floatBounds, shiftInto } from '../../../lib/floating';
import { stepZoom, ZOOM_MAX, ZOOM_MIN, ZOOM_PRESETS } from '../../../renderers/pdf/zoom';
import type { Zoom, ZoomState } from '../../../renderers/types';
import { MinusIcon, PlusIcon } from './icons';

const OPTIONS: { label: string; zoom: Zoom; hint?: string }[] = [
  { label: 'Fit Width', zoom: 'fit-width', hint: '⌘0' },
  { label: 'Fit Page', zoom: 'fit-page' },
  ...ZOOM_PRESETS.map((p) => ({ label: `${p}%`, zoom: p })),
];

/** The zoom menu's least height cap (px): about two rows, so it never collapses to nothing. */
export const ZOOM_MENU_MIN_HEIGHT = 80;

const MODE_LABEL: Partial<Record<string, string>> = { 'fit-width': 'Fit Width', 'fit-page': 'Fit Page' };

/**
 * `− 110% +`; the percentage opens a menu of fit modes and presets (↑/↓/Home/End, Esc, Tab).
 * A choice calls `onPicked` (the reader hands focus back to the page); Esc returns focus to the trigger.
 */
export function ZoomControl({
  zoom,
  onZoom,
  onPicked,
  placement = 'below',
  onOpenChange,
  allowFitPage = true,
}: {
  zoom: ZoomState;
  onZoom: (zoom: Zoom) => void;
  onPicked?: () => void;
  /** Where the menu opens: under the percentage (the toolbar) or over it (focus mode's pill, at the bottom). */
  placement?: 'below' | 'above';
  /** Told when the menu opens or closes. */
  onOpenChange?: (open: boolean) => void;
  /** False hides "Fit Page" (EPUB: a text column has no page height to fit). */
  allowFitPage?: boolean;
}) {
  const options = allowFitPage ? OPTIONS : OPTIONS.filter((o) => o.zoom !== 'fit-page');
  /** The presets start after the fit modes: a separator goes there. */
  const presetsAt = options.findIndex((o) => typeof o.zoom === 'number');
  // Without Fit Page, a remembered 'fit-page' is laid out as fit-width (EPUB) and shows as that.
  const current: Zoom = !allowFitPage && zoom.zoom === 'fit-page' ? 'fit-width' : zoom.zoom;
  const mode = typeof current === 'string' ? MODE_LABEL[current] : undefined;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  useEffect(() => {
    onOpenChangeRef.current?.(open);
  }, [open]);

  /** Sideways shift that keeps the open menu inside the reader (a narrow Obsidian pane clips it otherwise). */
  const [dx, setDx] = useState(0);
  /** The menu's height cap: the room between its anchored edge and the reader's far edge (it scrolls past that). */
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setDx(0);
      setMaxHeight(null);
      return;
    }
    const menu = menuRef.current;
    if (!menu) return;
    const r = menu.getBoundingClientRect();
    const bounds = floatBounds(menu);
    // Measured unshifted (dx is 0 while closed), so the shift is from the menu's natural place.
    setDx(shiftInto(r.left, r.width, bounds));
    // A below menu hangs from its top, an above one stands on its bottom: the other edge is the one to cap.
    const room = placement === 'above' ? r.bottom - bounds.top - FLOAT_INSET : bounds.bottom - FLOAT_INSET - r.top;
    // Never under ZOOM_MENU_MIN_HEIGHT: a trigger at the reader's far edge keeps a usable, scrolling menu.
    setMaxHeight(Math.max(ZOOM_MENU_MIN_HEIGHT, Math.floor(room)));
  }, [open, placement]);

  const menuStyle: CSSProperties = {};
  if (dx) menuStyle.marginLeft = dx;
  if (maxHeight !== null) {
    menuStyle.maxHeight = maxHeight;
    menuStyle.overflowY = 'auto';
  }

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    (menu?.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu?.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && (menuRef.current?.contains(t) || triggerRef.current?.contains(t))) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const pick = (z: Zoom) => {
    if (onPicked) setOpen(false);
    else close();
    onZoom(z);
    onPicked?.();
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (j: number) => items[(j + items.length) % items.length]?.focus();
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusAt(i + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusAt(i - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusAt(items.length - 1);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="zoom-control" role="group" aria-label="Zoom">
      <button
        type="button"
        className="tool-btn icon-btn zoom-step"
        aria-label="Zoom Out"
        title="Zoom Out (⌘−)"
        disabled={zoom.percent <= ZOOM_MIN}
        onClick={() => onZoom(stepZoom(zoom.percent, -1))}
      >
        <MinusIcon />
      </button>
      <button
        ref={triggerRef}
        type="button"
        className="zoom-value"
        aria-label={mode ? `Zoom: ${mode}, ${zoom.percent}%` : `Zoom: ${zoom.percent}%`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Zoom Options"
        onClick={() => setOpen((o) => !o)}
      >
        {zoom.percent}%
      </button>
      <button
        type="button"
        className="tool-btn icon-btn zoom-step"
        aria-label="Zoom In"
        title="Zoom In (⌘+)"
        disabled={zoom.percent >= ZOOM_MAX}
        onClick={() => onZoom(stepZoom(zoom.percent, 1))}
      >
        <PlusIcon />
      </button>
      {open && (
        <div ref={menuRef} role="menu" aria-label="Zoom options" className={placement === 'above' ? 'zoom-menu zoom-menu-above' : 'zoom-menu'} style={menuStyle} onKeyDown={onMenuKey}>
          {options.map((o, i) => {
            const checked = o.zoom === current;
            return (
              <Fragment key={o.label}>
                {i === presetsAt && <div role="separator" className="zoom-menu-sep" />}
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  tabIndex={-1}
                  className="zoom-menu-item"
                  onClick={() => pick(o.zoom)}
                >
                  <span className="zoom-check" aria-hidden="true">
                    {checked ? '✓' : ''}
                  </span>
                  {o.label}
                  {o.hint && (
                    <span className="key-hint" aria-hidden="true">
                      {o.hint}
                    </span>
                  )}
                </button>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
