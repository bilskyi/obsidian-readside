import { useCallback, useEffect, useId, useState, type CSSProperties } from 'react';
import { coarsePointer } from '../../lib/floating';

/** Per device: once dismissed, the first-run hint never shows again (desktop and Obsidian alike). */
export const HINT_DISMISSED_KEY = 'margin.hint.firstThought.dismissed';

/** The hint's first sentence, the same everywhere. */
export const HINT_TEXT = "Hover the page's right edge and click + to add a thought here.";
/** Its second: the shortcut where it is ⌘⇧M (the reader's chords are ⌘ chords: readerCommand reads metaKey), the command elsewhere. */
export const HINT_KEYS_MAC = '⌘⇧M adds one at the reading line.';
export const HINT_KEYS_OTHER = 'The “Add thought at reading line” command adds one there.';
/** On a touch screen there is no hover and no keyboard: tapping the margin, and the toolbar's +. */
export const HINT_TEXT_TOUCH = 'Tap in the margin beside a line to add a thought there.';
export const HINT_KEYS_TOUCH = 'The + in the toolbar adds one at the reading line.';

/** macOS, where the reader's ⌘ chords exist. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac/i.test(nav.userAgentData?.platform || nav.platform || '');
}

// Storage can be missing or throw (private mode, cleared site data): then the hint is dismissed for this session only.
function readDismissed(): boolean {
  try {
    return localStorage.getItem(HINT_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}
function writeDismissed(): void {
  try {
    localStorage.setItem(HINT_DISMISSED_KEY, '1');
  } catch {
    // not remembered; the hint stays hidden until the reader reopens
  }
}

/** Mounted hints, told when the hint is retired elsewhere (the first thought made in the reader). */
const retired = new Set<() => void>();

/** Dismisses the hint for good on this device: "Got it", or the first thought made. */
export function retireHint(): void {
  writeDismissed();
  for (const l of [...retired]) l();
}

/** Whether the first-run hint was dismissed on this device, and the way to dismiss it. */
export function useHintDismissed(): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => {
    const l = () => setDismissed(true);
    retired.add(l);
    return () => void retired.delete(l);
  }, []);
  const dismiss = useCallback(() => {
    retireHint();
    setDismissed(true);
  }, []);
  return [dismissed, dismiss];
}

/** A quiet first-run hint at the top of the empty margin: how to add a thought, and "Got it". */
export function MarginHint({
  style,
  onDismiss,
  mac = isMacPlatform(),
  touch = coarsePointer(null),
}: {
  style: CSSProperties;
  onDismiss: () => void;
  mac?: boolean;
  touch?: boolean;
}) {
  const textId = useId();
  return (
    <div className="margin-hint" role="note" style={style}>
      <p className="margin-hint-text" id={textId}>
        {touch ? `${HINT_TEXT_TOUCH} ${HINT_KEYS_TOUCH}` : `${HINT_TEXT} ${mac ? HINT_KEYS_MAC : HINT_KEYS_OTHER}`}
      </p>
      <button type="button" className="margin-hint-dismiss" aria-describedby={textId} onClick={onDismiss}>
        Got it
      </button>
    </div>
  );
}
