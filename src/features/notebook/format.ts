import type { EditorView } from '@codemirror/view';

/**
 * Markdown formatting for a thought editor: the writing sheet's buttons and ⌘B / ⌘I. Each works on the
 * main selection and keeps the text selected (or, with nothing selected, puts the caret between the marks
 * so typing goes inside them). Applying a wrap to text that already has it takes it off again.
 */

/** Wraps the selection in `mark` (`**` bold, `*` italic), or unwraps it when it is already wrapped. */
export function toggleWrap(view: EditorView, mark: string): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const n = mark.length;
  const before = state.sliceDoc(Math.max(0, from - n), from);
  const after = state.sliceDoc(to, to + n);
  // Already wrapped just outside the selection (and, for `*`, not part of a `**`): take the marks off.
  const outer = (pos: number) => (mark === '*' ? state.sliceDoc(pos, pos + 1) !== '*' : true);
  if (before === mark && after === mark && outer(from - n - 1) && outer(to + n)) {
    view.dispatch({
      changes: [
        { from: from - n, to: from, insert: '' },
        { from: to, to: to + n, insert: '' },
      ],
      selection: { anchor: from - n, head: to - n },
      userEvent: 'input.format',
    });
    return true;
  }
  view.dispatch({
    changes: [
      { from, insert: mark },
      { from: to, insert: mark },
    ],
    selection: { anchor: from + n, head: to + n },
    userEvent: 'input.format',
  });
  return true;
}

/** `[[selection]]`; with nothing selected, `[[]]` with the caret inside, so the note list opens. */
export function insertLink(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: `[[${text}]]` },
    selection: text ? { anchor: from + 2, head: from + 2 + text.length } : { anchor: from + 2 },
    userEvent: 'input.format',
  });
  return true;
}

/** Inserts `quote` as a Markdown blockquote on lines of its own at the caret. */
export function insertQuote(view: EditorView, quote: string): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const lineStart = state.doc.lineAt(from).from;
  const lead = from === 0 ? '' : from === lineStart ? '\n' : '\n\n';
  const body = quote
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  const insert = `${lead}${body}\n\n`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    userEvent: 'input.format',
  });
  return true;
}

/** Words in a body, for the sheet's counter: anything between spaces, Markdown marks not counted. */
export function wordCount(body: string): number {
  return body
    // A link counts as the words it shows: its alias, else the note's name.
    .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, name: string, alias?: string) => alias ?? name)
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** The note names a body links to, in order of first appearance (`[[Name]]`, `[[Name|alias]]`, `[[Name#h]]`). */
export function linkTargets(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    const name = m[1].trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * A highlight as Markdown for dropping into a thought: a blockquote, with a link back to its place when
 * there is one (`> the quote — [§ 5](obsidian://readside?…)`). On lines of its own wherever it lands.
 */
export function quoteForDrop(quote: string, place: { label: string; link: string } | null): string {
  const lines = quote
    .trim()
    .split('\n')
    .map((l) => `> ${l}`);
  if (place) lines[lines.length - 1] += ` — [${place.label}](${place.link})`;
  return `\n${lines.join('\n')}\n\n`;
}

/**
 * Drag handlers that carry a highlight as quoteForDrop's Markdown: a thought editor (CodeMirror) inserts
 * it where it is dropped, and so does an Obsidian note.
 */
export function quoteDrag(quote: string, place: { label: string; link: string } | null) {
  return {
    draggable: true,
    onDragStart: (e: { dataTransfer: DataTransfer | null }) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData('text/plain', quoteForDrop(quote, place));
      e.dataTransfer.effectAllowed = 'copy';
    },
  };
}
