import type { Color } from '../../lib/types';

/** What a right-click on the page offers. */
export type PageMenuItemId = 'add-thought-here' | 'copy-spot-link' | 'highlight' | 'thought-on-selection' | 'copy' | 'copy-quote';

/**
 * One entry of the page's right-click menu. The reader builds the list; a host may show it in its own menu
 * (Obsidian: its `Menu`), otherwise the reader shows its own small menu (PageMenu).
 */
export interface PageMenuItem {
  id: PageMenuItemId;
  label: string;
  /** A Lucide icon name, for a host menu that shows icons (Obsidian). */
  icon: string;
  onSelect: () => void;
  /** "Highlight" only: the same action in another colour (the item itself highlights in yellow). */
  onColor?: (color: Color) => void;
}
