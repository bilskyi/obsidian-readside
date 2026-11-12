import { prepareFuzzySearch, type App, type TFile } from 'obsidian';
import { MAX_SUGGESTIONS, type LinkSuggestion, type LinkSuggestSession } from '../../src/features/notebook/linkSuggest';

const folderOf = (file: TFile) => {
  const slash = file.path.lastIndexOf('/');
  return slash > 0 ? file.path.slice(0, slash) : '';
};

/** A wikilink to a note named with one of these would be read as a heading, alias, block or the link's end. */
const WIKILINK_UNSAFE = /[#|^[\]]/;
const escapeLinkText = (s: string) => s.replace(/[[\]\\]/g, (c) => `\\${c}`);

/**
 * The vault's notes for a `[[` typed in a thought: fuzzy-matched on the note's name (then, less strongly,
 * its path), best first; the most recently changed notes for a bare `[[`. Each inserts the shortest
 * link Obsidian itself would write, so the notebook note's copy of the thought links the right note. A
 * note whose name holds a character a wikilink can't carry (`# | ^ [ ]`) gets a Markdown link instead.
 * The vault's file list is read once per `[[` (kept in `session`), not on every keystroke.
 */
export function suggestNotes(app: App, query: string, limit = MAX_SUGGESTIONS, session?: LinkSuggestSession): LinkSuggestion[] {
  let files = session?.files as TFile[] | undefined;
  if (!files) {
    files = app.vault.getMarkdownFiles();
    if (session) session.files = files;
  }
  const q = query.trim();
  let ranked: TFile[];
  if (!q) {
    ranked = [...files].sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, limit);
  } else {
    const match = prepareFuzzySearch(q);
    const scored: { file: TFile; score: number }[] = [];
    for (const file of files) {
      const byName = match(file.basename);
      // A match in the folder path only counts for less than any match in the name.
      const byPath = byName ? null : match(file.path);
      const score = byName ? byName.score : byPath ? byPath.score - 1000 : null;
      if (score !== null) scored.push({ file, score });
    }
    scored.sort((a, b) => b.score - a.score || a.file.basename.length - b.file.basename.length || (a.file.path < b.file.path ? -1 : 1));
    ranked = scored.slice(0, limit).map((s) => s.file);
  }
  return ranked.map((file) => {
    const folder = folderOf(file);
    const insert = app.metadataCache.fileToLinktext(file, '', true);
    return {
      label: file.basename,
      insert,
      ...(WIKILINK_UNSAFE.test(file.basename) ? { replace: `[${escapeLinkText(file.basename)}](<${file.path}>)` } : {}),
      ...(folder ? { detail: folder } : {}),
    };
  });
}
