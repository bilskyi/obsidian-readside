import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Annotation, Compartment, EditorState, Prec, Transaction } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { debounce } from '../../lib/debounce';
import { register } from './editorRegistry';
import { toggleWrap } from './format';
import { formatBar } from './formatBar';
import { LinkSuggestContext, linkSuggestions } from './linkSuggest';
import './notebook.css';

export const SAVE_DELAY_MS = 500;
/** How long "Saved" shows after a save. */
export const SAVED_SHOWN_MS = 1500;
/** The editor's placeholder when nothing else is asked for. */
export const DEFAULT_PLACEHOLDER = 'Write a thought…';

/** Marks a transaction that applies an external body; it must not trigger a save. */
const external = Annotation.define<boolean>();
const MAX_EMITTED = 20;

/** Colours are App.css tokens, so the editor follows light/dark with the rest of the app. */
const theme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'transparent', fontSize: 'var(--fs-body)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.5', overflow: 'visible' },
  '.cm-content': { padding: '3px 0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '.cm-content ::selection': { backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)' },
  '.cm-placeholder': { color: 'var(--text-2)', fontStyle: 'normal' },
});

/** "Live preview" = Markdown syntax styling; the markup characters stay visible but dimmed. */
const markdownStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.3em', fontWeight: '700' },
  { tag: t.heading2, fontSize: '1.15em', fontWeight: '700' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  {
    tag: [t.link, t.url],
    color: 'color-mix(in srgb, var(--accent) 70%, var(--text))',
    textDecoration: 'underline',
  },
  {
    tag: t.monospace,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '0.92em',
    backgroundColor: 'var(--hover)',
    borderRadius: '3px',
  },
  { tag: t.quote, color: 'var(--text-2)', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--text-2)' },
]);

interface Props {
  initialBody: string;
  /**
   * Full text, 500 ms after the last change and right away on blur/unmount/flushAll; only when it
   * changed. The body counts as saved only when the promise resolves: on rejection the editor is
   * dirty again, so the next keystroke, blur or flush retries.
   */
  onSave: (body: string) => Promise<unknown>;
  label: string;
  autoFocus?: boolean;
  /** Shown while the body is empty (read at mount). */
  placeholder?: string;
  /**
   * Escape, when nothing in the editor used it (an open `[[` list closes first). Without it the key
   * goes on to the surrounding note (a floating card closes on it).
   */
  onEscape?: () => void;
  /** ⌘Enter (Ctrl+Enter elsewhere): the thought is done. Without it the key keeps CodeMirror's meaning. */
  onFinish?: () => void;
  /** The text typed here first holds more than whitespace (once per mount). */
  onContent?: () => void;
  /** Takes no typing (an empty new thought whose delete is on its way); it still takes focus. */
  readOnly?: boolean;
  /** ⌘E (Ctrl+E elsewhere): open the thought in the writing sheet. */
  onExpand?: () => void;
  /** The CodeMirror view once mounted, null when it goes (for the writing sheet's format buttons). */
  onView?: (view: EditorView | null) => void;
  /** The Bold / Italic / Link bar over selected text (read at mount); off where a toolbar is always there. */
  formatOnSelect?: boolean;
}

/** Read-only: no edits from typing or pasting, said to assistive tech too. */
const readOnlyExtension = (on: boolean) =>
  on ? [EditorState.readOnly.of(true), EditorView.contentAttributes.of({ 'aria-readonly': 'true' })] : [];

export function ThoughtEditor({
  initialBody,
  onSave,
  label,
  autoFocus = false,
  placeholder: placeholderText = DEFAULT_PLACEHOLDER,
  onEscape,
  onFinish,
  onContent,
  readOnly = false,
  onExpand,
  onView,
  formatOnSelect = true,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSaveRef = useRef(onSave);
  const keysRef = useRef({ onEscape, onFinish, onContent, onExpand, onView });
  useLayoutEffect(() => {
    onSaveRef.current = onSave;
    keysRef.current = { onEscape, onFinish, onContent, onExpand, onView };
  });
  // The editor owns its text after mount; a later initialBody is adopted only while clean.
  const seed = useRef({ initialBody, label, placeholderText, formatOnSelect });
  // Set by the main effect: adopt a newer external body when the editor has no local changes.
  const labelCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());
  const readOnlyRef = useRef(readOnly);
  const adoptRef = useRef<(body: string) => void>(() => {});
  // `[[` suggestions from the host (Obsidian's vault notes); none on desktop. Read through a ref, so a new
  // function from the host is used without rebuilding the editor.
  const linkSuggest = useContext(LinkSuggestContext);
  const linkSuggestRef = useRef(linkSuggest);
  useLayoutEffect(() => {
    linkSuggestRef.current = linkSuggest;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { initialBody: doc, label: ariaLabel, placeholderText: hint, formatOnSelect: bar } = seed.current;
    // A quiet "Saved" after each save while the editor has focus; "Not saved" while one has failed (CSS).
    let savedTimer: ReturnType<typeof setTimeout> | undefined;
    const showSaved = (ok: boolean) => {
      clearTimeout(savedTimer);
      if (!ok) {
        delete host.dataset.saved;
        host.dataset.unsaved = '';
        return;
      }
      delete host.dataset.unsaved;
      host.dataset.saved = '';
      savedTimer = setTimeout(() => delete host.dataset.saved, SAVED_SHOWN_MS);
    };
    // The format bar's tooltips go where the `[[` list goes, so the scoped CSS reaches them.
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    let hadContent = doc.trim() !== '';
    // `saved`: the last body sent (or seeded/adopted); `persisted`: the last one the backend confirmed.
    let saved = doc;
    let persisted = doc;
    let sendSeq = 0;
    let persistedSeq = 0;
    let inflight: Promise<unknown> = Promise.resolve();
    let pending = false;
    // Bodies this editor has sent (or was seeded/adopted with), oldest first. Echoes of an older one are stale.
    let emitted: string[] = [doc];
    /** Sends `body` unless it is what was last sent; resolves when the latest save settles. */
    const commit = (body: string): Promise<unknown> => {
      pending = false;
      if (body === saved) return inflight;
      saved = body;
      emitted = [...emitted, body].slice(-MAX_EMITTED);
      const seq = ++sendSeq;
      let sent: Promise<unknown>;
      try {
        sent = Promise.resolve(onSaveRef.current(body)); // synchronous: callers see the body at once
      } catch (e) {
        sent = Promise.reject(e);
      }
      inflight = sent.then(
        () => {
          if (seq > persistedSeq) {
            persistedSeq = seq;
            persisted = body;
          }
          if (seq === sendSeq) showSaved(true);
        },
        () => {
          if (seq === sendSeq) showSaved(false);
          // Failed: unless a newer body was sent since, fall back to the last confirmed body so the
          // editor is dirty and the next keystroke, blur or flush sends the text again.
          if (seq === sendSeq) saved = persisted;
        },
      );
      return inflight;
    };
    const save = debounce((body: string) => void commit(body), SAVE_DELAY_MS);
    let liveView: EditorView | null = null;
    /** Sends the current text right away (if unsent or failed) and waits for it to settle. */
    const flushNow = () => {
      save.cancel();
      return liveView ? commit(liveView.state.doc.toString()) : inflight;
    };
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          // Ahead of the default keymap (whose ⌘Enter inserts a blank line); a `[[` list (highest) still
          // takes its own Escape first. Each key is claimed only when the host asked for it.
          Prec.high(
            keymap.of([
              {
                key: 'Escape',
                run: () => {
                  const fn = keysRef.current.onEscape;
                  if (!fn) return false;
                  fn();
                  return true;
                },
              },
              {
                key: 'Mod-Enter',
                run: () => {
                  const fn = keysRef.current.onFinish;
                  if (!fn) return false;
                  fn();
                  return true;
                },
              },
              {
                key: 'Mod-e',
                run: () => {
                  const fn = keysRef.current.onExpand;
                  if (!fn) return false;
                  fn();
                  return true;
                },
              },
              // Obsidian's own bold and italic keys.
              { key: 'Mod-b', run: (v) => toggleWrap(v, '**') },
              { key: 'Mod-i', run: (v) => toggleWrap(v, '*') },
            ]),
          ),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          syntaxHighlighting(markdownStyle),
          theme,
          EditorView.lineWrapping,
          placeholder(hint),
          // Installed only when the host has a source at mount: desktop's editor is exactly what it was.
          linkSuggestRef.current
            ? linkSuggestions(
                () => linkSuggestRef.current,
                // In a narrow window's floating card the list lives in the card (a choice there is the
                // card's); elsewhere in the app root, so the scoped CSS reaches it.
                host.closest<HTMLElement>('.margin-card') ?? host.closest<HTMLElement>('.margin-app') ?? undefined,
              )
            : [],
          bar && !coarse ? formatBar() : [],
          labelCompartment.current.of(EditorView.contentAttributes.of({ 'aria-label': ariaLabel })),
          readOnlyCompartment.current.of(readOnlyExtension(readOnlyRef.current)),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || u.transactions.some((tr) => tr.annotation(external))) return;
            if (!hadContent && u.state.doc.toString().trim() !== '') {
              hadContent = true;
              keysRef.current.onContent?.();
            }
            pending = true;
            save(u.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            blur: () => {
              void flushNow();
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    liveView = view;
    keysRef.current.onView?.(view);
    const unregister = register(flushNow);
    adoptRef.current = (body) => {
      const cur = view.state.doc.toString();
      // Already showing it. (`saved` stays: after a failed save the matching local body is not persisted.)
      if (body === cur) return;
      // An older body of our own coming back late: the doc is already ahead of it.
      if (body !== emitted[emitted.length - 1] && emitted.includes(body)) return;
      // Dirty (unsent or unsaved local edits): local text wins, like useThoughts.
      if (pending || cur !== saved) return;
      saved = body;
      persisted = body;
      emitted = [body];
      const head = Math.min(view.state.selection.main.head, body.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: body },
        selection: { anchor: head },
        annotations: [external.of(true), Transaction.addToHistory.of(false)],
      });
    };
    return () => {
      clearTimeout(savedTimer);
      unregister();
      void flushNow();
      keysRef.current.onView?.(null);
      liveView = null;
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: labelCompartment.current.reconfigure(EditorView.contentAttributes.of({ 'aria-label': label })),
    });
  }, [label]);

  useEffect(() => {
    adoptRef.current(initialBody);
  }, [initialBody]);

  useEffect(() => {
    if (readOnlyRef.current === readOnly) return;
    readOnlyRef.current = readOnly;
    viewRef.current?.dispatch({ effects: readOnlyCompartment.current.reconfigure(readOnlyExtension(readOnly)) });
  }, [readOnly]);

  useEffect(() => {
    if (!autoFocus || !viewRef.current) return;
    viewRef.current.focus();
    // CodeMirror focuses without scrolling; bring a freshly created thought into view.
    hostRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [autoFocus]);

  return <div className="thought-editor" ref={hostRef} />;
}
