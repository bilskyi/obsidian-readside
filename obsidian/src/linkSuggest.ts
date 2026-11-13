import { getAllTags, prepareFuzzySearch, type App, type TFile } from 'obsidian';
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

/**
 * The vault's tags for a `#` typed in a thought: those containing the query (case-insensitive), those that
 * start with it first, then the most used. Each shows how many notes carry it. The vault's tags are counted
 * once per `#` (kept in `session`).
 */
export function suggestTags(app: App, query: string, limit = MAX_SUGGESTIONS, session?: LinkSuggestSession): LinkSuggestion[] {
  let counts = session?.tags as Map<string, number> | undefined;
  if (!counts) {
    counts = new Map();
    for (const file of app.vault.getMarkdownFiles()) {
      const cache = app.metadataCache.getFileCache(file);
      if (!cache) continue;
      // A note counts once per tag, however often it uses it.
      for (const tag of new Set(getAllTags(cache) ?? [])) {
        const name = tag.replace(/^#/, '');
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    if (session) session.tags = counts;
  }
  const q = query.toLowerCase();
  return [...counts]
    .filter(([name]) => name.toLowerCase().includes(q))
    .sort(
      ([a, na], [b, nb]) =>
        Number(b.toLowerCase().startsWith(q)) - Number(a.toLowerCase().startsWith(q)) || nb - na || a.localeCompare(b),
    )
    .slice(0, limit)
    .map(([name, n]) => ({ label: `#${name}`, insert: name, detail: n === 1 ? '1 note' : `${n} notes` }));
}
