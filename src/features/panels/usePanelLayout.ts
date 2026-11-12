import { useCallback, useState } from 'react';

export interface PanelLayoutOptions {
  openKey: string;
  widthKey: string;
  min: number;
  max: number;
  defaultWidth: number;
}

// Storage can be missing or throw (private mode, cleared site data): the layout just isn't remembered.
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered; nothing else depends on it
  }
}

/** A side panel's open state and width, remembered per device. Pass a module-level options object. */
export function usePanelLayout({ openKey, widthKey, min, max, defaultWidth }: PanelLayoutOptions) {
  const clampWidth = useCallback((w: number) => Math.round(Math.min(max, Math.max(min, w))), [min, max]);
  const [open, setOpenState] = useState(() => read(openKey) === 'true');
  const [width, setWidthState] = useState(() => {
    const n = Number(read(widthKey));
    return Number.isFinite(n) && n > 0 ? Math.round(Math.min(max, Math.max(min, n))) : defaultWidth;
  });

  const setOpen = useCallback(
    (v: boolean) => {
      setOpenState(v);
      write(openKey, String(v));
    },
    [openKey],
  );

  const toggle = useCallback(() => {
    setOpenState((o) => {
      write(openKey, String(!o));
      return !o;
    });
  }, [openKey]);

  /** Live width while dragging (`persist = false`); stored on drag end and on key presses. */
  const setWidth = useCallback(
    (w: number, persist = true) => {
      const c = clampWidth(w);
      setWidthState(c);
      if (persist) write(widthKey, String(c));
      return c;
    },
    [clampWidth, widthKey],
  );

  return { open, setOpen, toggle, width, setWidth };
}
