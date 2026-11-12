export type ReaderCommand =
  | 'toggleNotebook'
  | 'newThought'
  | 'find'
  | 'toggleContents'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomFit'
  | 'nextPage'
  | 'prevPage'
  | 'toggleFocus'
  /** Leaves focus mode. No key maps to it: a host runs it (Obsidian: an Esc pressed outside the reader). */
  | 'leaveFocus';

/** Typing targets keep their own keys. */
export const isEditable = (t: EventTarget | null): boolean =>
  t instanceof Element && t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;

/** The reader's own text fields (thought editors, search and page fields): ⌘ chords still work there; bare keys never do. */
export const inReaderField = (t: EventTarget | null): boolean =>
  t instanceof Element && t.closest('.thought-editor, [data-reader-field]') !== null;

/**
 * Page keys turn PDF pages only when nothing in particular has focus (window, document, body) or focus
 * is in the page area. In the contents list, notebook, search results or any other panel, PageUp/PageDown
 * and ⌥←/⌥→ keep their native meaning (scrolling that panel).
 */
export const inPageArea = (t: EventTarget | null): boolean =>
  !(t instanceof Element) ||
  t === document.body ||
  t === document.documentElement ||
  // An embedding host's root (the Obsidian view) takes focus when the page itself is clicked.
  t.hasAttribute('data-margin-root') ||
  // The margin lives inside the reader host (in the scroller) but is a panel of its own.
  (t.closest('.reader-host') !== null && t.closest('.pdf-margin') === null);

/**
 * The key a bare letter or digit shortcut reads (T, N, M, 1–5): `e.key` when it is ASCII (the layout's own
 * letter, wherever it sits: Dvorak, AZERTY), otherwise the physical QWERTY key from `e.code`, so a
 * Ukrainian layout's "е" on the T key is "t" and AZERTY's "é" on the 2 key is "2".
 */
export function shortcutKey(e: Pick<KeyboardEvent, 'key' | 'code'>): string {
  if (!/[^\x00-\x7f]/.test(e.key)) return e.key;
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code ?? '');
  if (!m) return e.key;
  return m[1] ? m[1].toLowerCase() : m[2];
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'target'>;

/** ASCII punctuation that is no other reader chord's key. */
const OTHER_PUNCTUATION = /^[!-\/:-@[-`{-~]$/;
const CHORD_KEYS = new Set(['.', '\\', '=', '+', '-', '_']);

/**
 * ⌘. (with ⌘ held), conservatively across layouts:
 * - `e.key` "." without Shift: wherever the layout has it (QWERTY, Dvorak, QWERTZ).
 * - `e.key` "." with Shift, on a key other than QWERTY's period: the layout needs Shift to type "."
 *   (French AZERTY: Shift + ";"). On QWERTY, Shift + period is "⌘⇧." and is never taken, even where
 *   macOS reports the unshifted "." under ⌘.
 * - QWERTY's period key without Shift typing other punctuation (AZERTY's ":"): that key's position. Never
 *   a letter or digit (Dvorak's "v" there stays "v"), nor another chord's key (a layout with "-" there
 *   keeps ⌘- as zoom out).
 * - A non-ASCII key falls back to the position, as for the letters.
 */
function isFocusChord(e: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey'>, ascii: boolean): boolean {
  if (!ascii) return !e.shiftKey && e.code === 'Period';
  if (e.key === '.') return !e.shiftKey || e.code !== 'Period';
  return !e.shiftKey && e.code === 'Period' && OTHER_PUNCTUATION.test(e.key) && !CHORD_KEYS.has(e.key);
}

/** The reader command a keydown asks for (spec §5.1, M3 keyboard rules), or null. */
export function readerCommand(e: KeyLike): ReaderCommand | null {
  const editable = isEditable(e.target);
  if (e.metaKey) {
    if (e.ctrlKey || e.altKey) return null;
    if (editable && !inReaderField(e.target)) return null;
    const k = e.key.toLowerCase();
    // An ASCII key decides (Dvorak, AZERTY: the key labelled F is ⌘F wherever it sits, and AZERTY's
    // "," on the QWERTY M position is not M). Only a non-ASCII key (e.g. Ukrainian) falls back to the
    // physical QWERTY position.
    const ascii = !/[^\x00-\x7f]/.test(e.key);
    const is = (letter: string) => (ascii ? k === letter : e.code === `Key${letter.toUpperCase()}`);
    if (!e.shiftKey && (e.key === '\\' || e.code === 'Backslash')) return 'toggleNotebook';
    if (e.shiftKey && is('m')) return 'newThought';
    if (e.shiftKey && is('c')) return 'toggleContents';
    if (!e.shiftKey && is('f')) return 'find';
    // Focus mode: ⌘. (⌘⇧F is Obsidian's "Search in all files", which the view's scope would otherwise swallow).
    if (isFocusChord(e, ascii)) return 'toggleFocus';
    if (e.key === '=' || e.key === '+') return 'zoomIn';
    if (e.key === '-' || e.key === '_') return 'zoomOut';
    // AZERTY types "à" on the 0 key without Shift: a key that isn't a digit falls back to its position.
    if (!e.shiftKey && (e.key === '0' || (!/^[0-9]$/.test(e.key) && e.code === 'Digit0'))) return 'zoomFit';
    return null;
  }
  if (e.ctrlKey || e.shiftKey || editable || !inPageArea(e.target)) return null;
  if (!e.altKey && e.key === 'PageDown') return 'nextPage';
  if (!e.altKey && e.key === 'PageUp') return 'prevPage';
  if (e.altKey && e.key === 'ArrowRight') return 'nextPage';
  if (e.altKey && e.key === 'ArrowLeft') return 'prevPage';
  return null;
}
