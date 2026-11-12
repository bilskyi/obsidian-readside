import { useCallback, useState } from 'react';

/** Focus mode's last state: the same key in both hosts (the desktop app, the Obsidian plugin); each host keeps its own. */
export const FOCUS_KEY = 'margin.focus';

// Storage can be missing or throw (private mode, cleared site data): the state just isn't remembered.
function read(): boolean {
  try {
    return localStorage.getItem(FOCUS_KEY) === 'true';
  } catch {
    return false;
  }
}
function write(on: boolean): void {
  try {
    localStorage.setItem(FOCUS_KEY, String(on));
  } catch {
    // not remembered; nothing else depends on it
  }
}

/** Focus mode on or off, remembered per device (not per book). */
export function useFocusMode() {
  const [focus, setState] = useState(read);
  const setFocus = useCallback((on: boolean) => {
    setState(on);
    write(on);
  }, []);
  return { focus, setFocus };
}
