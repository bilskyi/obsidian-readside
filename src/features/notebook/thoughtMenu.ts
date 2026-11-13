import type { Annotation, Thought } from '../../lib/types';
import type { MenuItem } from './EntryMenu';

export interface ThoughtMenuActions {
  onCopyLink: (url: string) => void;
  onUnlinkThought: (thought: Thought, anchor: Annotation | null) => void;
  onDeleteThought: (thought: Thought) => void;
}

/**
 * A thought's ⋯ menu, the same in the notebook and in the margin: Open in Writing Sheet (when the reader
 * has one), Copy Link, Rename, Unlink, Delete.
 */
export function thoughtMenuItems(
  thought: Thought,
  anchor: Annotation | null,
  link: string | null,
  actions: ThoughtMenuActions,
  rename: () => void,
  expand?: () => void,
): MenuItem[] {
  const unlink: MenuItem[] = thought.anchorId
    ? [{ label: 'Unlink from Highlight', onSelect: () => actions.onUnlinkThought(thought, anchor) }]
    : thought.location
      ? [{ label: 'Unlink from Page', onSelect: () => actions.onUnlinkThought(thought, null) }]
      : [];
  return [
    ...(expand ? [{ label: 'Open in Writing Sheet', onSelect: expand }] : []),
    ...(link ? [{ label: 'Copy Link', onSelect: () => actions.onCopyLink(link) }] : []),
    { label: 'Rename Thought', onSelect: rename },
    ...unlink,
    { label: 'Delete Thought', onSelect: () => actions.onDeleteThought(thought), danger: true },
  ];
}
