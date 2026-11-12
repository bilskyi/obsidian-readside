import { Prec, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, showTooltip, tooltips, type Tooltip, type TooltipView } from '@codemirror/view';
import { createContext } from 'react';

/**
 * `[[` link suggestions in a thought editor. Dependency-free (no @codemirror/autocomplete): a StateField
 * holds the open list, a tooltip shows it, a top-precedence keymap drives it. The list comes from the
 * host (Obsidian: the vault's notes); without a host source the extension is never installed, so `[[`
 * does nothing on desktop.
 */

export interface LinkSuggestion {
  /** What the list shows (the note's name). */
  label: string;
  /** The link target written between the brackets: `[[insert]]`. */
  insert: string;
  /**
   * The whole text to write instead of `[[insert]]` (it replaces the `[[` and the query): for a note whose
   * name a wikilink can't carry, the host gives a Markdown link.
   */
  replace?: string;
  /** A quieter second line (the note's folder). */
  detail?: string;
}

/**
 * Scratch space for the host, one per `[[` being typed: what it keeps there (the vault's file list, say)
 * lasts while that link is typed, and goes with it.
 */
export type LinkSuggestSession = Record<string, unknown>;

/** The host's source: notes matching `query` (the text typed after `[[`), best first. */
export type LinkSuggestSource = (query: string, session?: LinkSuggestSession) => readonly LinkSuggestion[];

/** Given by the host (ReaderView's `linkSuggest`); null = no suggestions. */
export const LinkSuggestContext = createContext<LinkSuggestSource | null>(null);

export const MAX_SUGGESTIONS = 8;
/** Longer than this after `[[` is not a link being typed. */
const MAX_QUERY = 80;

/**
 * The `[[` link the cursor at `pos` is typing: `from` is just after the `[[`, `query` the text between it
 * and the cursor. Null when there is no `[[` before the cursor on its line, or the text after it already
 * closes or leaves the target (`]`, `[`, `|`, `#`, `^`).
 */
export function linkQueryAt(state: EditorState, pos: number): { from: number; query: string } | null {
  const line = state.doc.lineAt(pos);
  const before = state.sliceDoc(line.from, pos);
  const open = before.lastIndexOf('[[');
  if (open < 0) return null;
  const query = before.slice(open + 2);
  if (query.length > MAX_QUERY || /[[\]|#^]/.test(query)) return null;
  return { from: line.from + open + 2, query };
}

interface Open {
  /** Just after the `[[`. */
  from: number;
  query: string;
  items: readonly LinkSuggestion[];
  selected: number;
}
interface SuggestState {
  open: Open | null;
  /** Escape closed the list of the `[[` here: it stays closed until the cursor leaves that link. */
  dismissed: number | null;
  /** The `[[` being typed (just after it) and the host's session for it. */
  session: { from: number; data: LinkSuggestSession } | null;
}

const move = StateEffect.define<number>();
const dismiss = StateEffect.define<null>();
/** Closed, nothing remembered: typing in the same `[[` opens the list again. */
const close = StateEffect.define<null>();
/** A composition ended: its committed text is settled, so the list is worked out again (like a doc change). */
const refresh = StateEffect.define<null>();
const CLOSED: SuggestState = { open: null, dismissed: null, session: null };

let uid = 0;

/** The extension; `source()` is read on every change, so the host may swap its function. */
export function linkSuggestions(source: () => LinkSuggestSource | null, parent?: HTMLElement): Extension {
  const listId = `link-suggest-${++uid}`;
  const field = StateField.define<SuggestState>({
    create: () => CLOSED,
    update(value, tr) {
      for (const e of tr.effects) {
        if (e.is(dismiss)) return { open: null, dismissed: value.open?.from ?? value.dismissed, session: null };
        if (e.is(close)) return CLOSED;
        if (e.is(move) && value.open) {
          const n = value.open.items.length;
          return { ...value, open: { ...value.open, selected: (value.open.selected + e.value + n) % n } };
        }
      }
      const refreshed = tr.effects.some((e) => e.is(refresh));
      if (!tr.docChanged && !tr.selection && !refreshed) return value;
      // Mid-composition (IME) text is not settled: the list stays as it was, kept in place.
      if (tr.isUserEvent('input.type.compose')) {
        if (!value.open && value.dismissed === null && !value.session) return value;
        const map = (n: number) => tr.changes.mapPos(n);
        return {
          open: value.open && { ...value.open, from: map(value.open.from) },
          dismissed: value.dismissed === null ? null : map(value.dismissed),
          session: value.session && { ...value.session, from: map(value.session.from) },
        };
      }
      const sel = tr.state.selection.main;
      const q = sel.empty ? linkQueryAt(tr.state, sel.head) : null;
      if (!q) return CLOSED;
      const dismissed = value.dismissed === null ? null : tr.changes.mapPos(value.dismissed);
      if (dismissed === q.from) return { open: null, dismissed, session: null };
      // Only typing opens the list; moving the cursor within an open link keeps it in step.
      if (!value.open && !tr.docChanged && !refreshed) return CLOSED;
      const kept = value.session && tr.changes.mapPos(value.session.from) === q.from ? value.session.data : null;
      const session = { from: q.from, data: kept ?? {} };
      if (value.open && value.open.query === q.query && tr.changes.mapPos(value.open.from) === q.from) {
        return { open: { ...value.open, from: q.from }, dismissed: null, session };
      }
      const items = (source()?.(q.query, session.data) ?? []).slice(0, MAX_SUGGESTIONS);
      return { open: items.length ? { from: q.from, query: q.query, items, selected: 0 } : null, dismissed: null, session };
    },
  });

  const accept = (view: EditorView, index: number): boolean => {
    const open = view.state.field(field).open;
    const item = open?.items[index];
    if (!open || !item) return false;
    const head = view.state.selection.main.head;
    // A `]]` already right after the cursor (typed ahead, or auto-paired) is replaced, not doubled.
    const end = view.state.sliceDoc(head, head + 2) === ']]' ? head + 2 : head;
    const text = item.replace ?? `[[${item.insert}]]`;
    view.dispatch({
      changes: { from: open.from - 2, to: end, insert: text },
      selection: { anchor: open.from - 2 + text.length },
      userEvent: 'input.complete',
      scrollIntoView: true,
    });
    return true;
  };

  const whenOpen = (run: (view: EditorView, open: Open) => boolean) => (view: EditorView) => {
    const open = view.state.field(field).open;
    return open ? run(view, open) : false;
  };

  const optionId = (i: number) => `${listId}-${i}`;

  const render = (dom: HTMLElement, view: EditorView, open: Open | null) => {
    if (!open) return;
    const rows = open.items.map((item, i) => {
      const row = document.createElement('div');
      row.id = optionId(i);
      row.className = 'cm-link-suggest-option';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === open.selected));
      const name = document.createElement('span');
      name.className = 'cm-link-suggest-label';
      name.textContent = item.label;
      row.appendChild(name);
      if (item.detail) {
        const detail = document.createElement('span');
        detail.className = 'cm-link-suggest-detail';
        detail.textContent = item.detail;
        row.appendChild(detail);
      }
      // mousedown, not click: the editor keeps focus (and its selection) while the row is chosen.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        accept(view, i);
      });
      return row;
    });
    dom.replaceChildren(...rows);
    dom.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  };

  // One tooltip object per `[[`: its view re-renders in place as the query and the selection change.
  let shown: { from: number; tooltip: Tooltip } | null = null;
  const tooltipFor = (open: Open): Tooltip => {
    if (shown?.from === open.from) return shown.tooltip;
    const tooltip: Tooltip = {
      pos: open.from - 2,
      above: false,
      strictSide: false,
      create(view): TooltipView {
        const dom = document.createElement('div');
        dom.className = 'cm-link-suggest';
        dom.id = listId;
        dom.setAttribute('role', 'listbox');
        dom.setAttribute('aria-label', 'Link to a note');
        render(dom, view, view.state.field(field).open);
        return {
          dom,
          update(u) {
            if (u.startState.field(field) !== u.state.field(field)) render(dom, u.view, u.state.field(field).open);
          },
        };
      },
    };
    shown = { from: open.from, tooltip };
    return tooltip;
  };

  return [
    field,
    showTooltip.compute([field], (state) => {
      const open = state.field(field).open;
      if (!open) shown = null;
      return open ? tooltipFor(open) : null;
    }),
    // The list belongs to the editor for assistive technology: what is open, and which option is current.
    EditorView.contentAttributes.compute([field], (state) => {
      const open = state.field(field).open;
      const attrs: Record<string, string> = { 'aria-autocomplete': 'list' };
      if (open) {
        attrs['aria-expanded'] = 'true';
        attrs['aria-controls'] = listId;
        attrs['aria-activedescendant'] = optionId(open.selected);
      }
      return attrs;
    }),
    tooltips(parent ? { parent } : {}),
    Prec.highest(
      keymap.of([
        { key: 'ArrowDown', run: whenOpen((view) => (view.dispatch({ effects: move.of(1) }), true)) },
        { key: 'ArrowUp', run: whenOpen((view) => (view.dispatch({ effects: move.of(-1) }), true)) },
        { key: 'Enter', run: whenOpen((view, open) => accept(view, open.selected)) },
        { key: 'Tab', run: whenOpen((view, open) => accept(view, open.selected)) },
        { key: 'Escape', run: whenOpen((view) => (view.dispatch({ effects: dismiss.of(null) }), true)) },
      ]),
    ),
    EditorView.domEventHandlers({
      // The composition's last text arrives tagged as compose, which keeps the old list: once it has ended
      // (and no new one began), the list is worked out for what is there now.
      compositionend: (_e, view) => {
        setTimeout(() => {
          if (!view.composing) view.dispatch({ effects: refresh.of(null) });
        });
      },
      // Leaving the editor closes the list (a click elsewhere, Tab out), without Escape's memory: back in
      // the same `[[`, typing opens it again.
      blur: (_e, view) => {
        const state = view.state.field(field);
        if (state.open || state.session) view.dispatch({ effects: close.of(null) });
      },
    }),
  ];
}
