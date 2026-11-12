import type { Plugin } from 'obsidian';
import type { ReaderCommand } from '../../src/lib/keys';
import type { MarginView } from './view/MarginView';

/** The in-view shortcuts as commands, so users can rebind them (spec §4). */
export const VIEW_COMMANDS: readonly { id: string; name: string; cmd: ReaderCommand }[] = [
  { id: 'new-thought', name: 'Add thought at reading line', cmd: 'newThought' },
  { id: 'toggle-notebook', name: 'Toggle notebook', cmd: 'toggleNotebook' },
  { id: 'toggle-contents', name: 'Toggle contents', cmd: 'toggleContents' },
  { id: 'find', name: 'Find in book', cmd: 'find' },
  { id: 'zoom-in', name: 'Zoom in', cmd: 'zoomIn' },
  { id: 'zoom-out', name: 'Zoom out', cmd: 'zoomOut' },
  { id: 'zoom-fit', name: 'Zoom to fit width', cmd: 'zoomFit' },
  { id: 'next-page', name: 'Next page', cmd: 'nextPage' },
  { id: 'prev-page', name: 'Previous page', cmd: 'prevPage' },
  { id: 'toggle-focus', name: 'Toggle focus mode', cmd: 'toggleFocus' },
];

/** Each command is available only while a Margin view is focused, and acts on that view. */
export function registerViewCommands(plugin: Plugin, activeView: () => MarginView | null): void {
  for (const c of VIEW_COMMANDS) {
    plugin.addCommand({
      id: c.id,
      name: c.name,
      checkCallback: (checking) => {
        const run = activeView()?.commands.current;
        return run ? run(c.cmd, checking) : false;
      },
    });
  }
}
