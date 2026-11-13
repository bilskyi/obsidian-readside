import type { EditorView } from '@codemirror/view';
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { labelText, thoughtLabel, thoughtPlace } from '../../lib/labels';
import type { Annotation, Location, Thought } from '../../lib/types';
import { useEditorOwner } from './editorOwners';
import { insertLink, insertQuote, linkTargets, toggleWrap, wordCount } from './format';
import { ThoughtEditor } from './ThoughtEditor';
import { ThoughtSessionContext } from './thoughtSession';
import './writingSheet.css';

export type SaveState = 'saved' | 'saving' | 'failed';

export interface WritingSheetProps {
  thought: Thought;
  /** Every thought and highlight in the book, for the side column. */
  thoughts: readonly Thought[];
  annotations: readonly Annotation[];
  onSave: (id: string, body: string) => Promise<unknown>;
  /** Another thought chosen in the side column: the sheet moves to it. */
  onSwitch: (id: string) => void;
  /** Close the sheet and go to the thought's place in the book. */
  onShowInBook: (location: Location) => void;
  onClose: () => void;
}

const excerpt = (body: string, n = 90) => {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n).trimEnd()}…` : flat;
};

/**
 * The writing sheet: one thought in a large editor over the page, with the highlight it is about at the
 * top and, beside it, the notes it links to and the other thoughts in this book that share a link or the
 * highlight. Opened with ⌘E or ⤢ from a margin note or the notebook; on a phone it fills the screen. It
 * is the thought's one editor while open (editorOwners' 'sheet' surface): the margin and the notebook
 * show a preview meanwhile, and closing unmounts the editor, which saves what is left.
 */
export function WritingSheet({ thought, thoughts, annotations, onSave, onSwitch, onShowInBook, onClose }: WritingSheetProps) {
  const id = thought.id;
  const titleId = useId();
  const anchors = useMemo(() => new Map(annotations.map((a) => [a.id, a])), [annotations]);
  const anchor = thought.anchorId ? (anchors.get(thought.anchorId) ?? null) : null;
  const place = thoughtPlace(thought, anchors);
  const name = labelText(thoughtLabel(thought, place)) || (place ? place.location.label : 'General thought');
  const owner = useEditorOwner(id, 'sheet');
  const session = useContext(ThoughtSessionContext);
  const [view, setView] = useState<EditorView | null>(null);
  const [status, setStatus] = useState<SaveState>('saved');
  const [words, setWords] = useState(() => wordCount(thought.body));

  // Focus goes back where it came from (the ⤢ button, the margin note) when the sheet closes.
  useLayoutEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (before?.isConnected && !before.closest('.writing-sheet')) before.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => setWords(wordCount(thought.body)), [thought.body]);

  const save = (body: string) => {
    setStatus('saving');
    setWords(wordCount(body));
    const p = onSave(id, body);
    p.then(
      () => setStatus('saved'),
      () => setStatus('failed'),
    );
    return p;
  };

  const links = linkTargets(thought.body);
  const related = thoughts.filter((t) => t.id !== id && t.body.trim() && linkTargets(t.body).some((l) => links.includes(l)));
  const siblings = anchor ? thoughts.filter((t) => t.id !== id && t.anchorId === anchor.id && t.body.trim()) : [];

  const onBackdrop = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      onClose();
    }
  };
  /** A format button: acts on the editor and gives it the keyboard back. */
  const format = (fn: (v: EditorView) => boolean) => () => {
    if (!view) return;
    fn(view);
    view.focus();
  };
  // Keep the editor's selection: a button press must not take focus first.
  const keepFocus = (e: MouseEvent) => e.preventDefault();

  const statusText = status === 'saving' ? 'Saving…' : status === 'failed' ? 'Not saved yet, retrying' : 'Saved';

  return (
    <div className="writing-sheet-backdrop" onMouseDown={onBackdrop}>
      <section
        className="writing-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-thought-id={id}
        onKeyDown={onKeyDown}
      >
        <header className="sheet-head">
          {anchor && <span className={`sheet-dot hl-dot-${anchor.color}`} aria-hidden="true" />}
          <h2 id={titleId} className="sheet-title">
            {name}
          </h2>
          {place && !name.includes(place.location.label) && <span className="sheet-place">{place.location.label}</span>}
          <span className="sheet-spacer" />
          {place && (
            <button type="button" className="sheet-button" onClick={() => onShowInBook(place.location)}>
              Show in book
            </button>
          )}
          <button type="button" className="sheet-close" aria-label="Close the writing sheet" title="Close (Esc)" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="sheet-main">
          {anchor && (
            <figure className="sheet-quote">
              <blockquote className={`hl-rule-${anchor.color}`}>{anchor.quote}</blockquote>
              {anchor.note && (
                <figcaption>
                  <span className="sheet-label">Note</span> {anchor.note}
                </figcaption>
              )}
            </figure>
          )}
          <div className="sheet-format" role="toolbar" aria-label="Formatting">
            <button type="button" aria-label="Bold" title="Bold (⌘B)" onMouseDown={keepFocus} onClick={format((v) => toggleWrap(v, '**'))}>
              <b>B</b>
            </button>
            <button type="button" aria-label="Italic" title="Italic (⌘I)" onMouseDown={keepFocus} onClick={format((v) => toggleWrap(v, '*'))}>
              <i>I</i>
            </button>
            <button type="button" aria-label="Link a note" title="Link a note ([[)" onMouseDown={keepFocus} onClick={format(insertLink)}>
              [[ ]]
            </button>
            {anchor && (
              <button
                type="button"
                aria-label="Quote the highlight"
                title="Quote the highlight"
                onMouseDown={keepFocus}
                onClick={format((v) => insertQuote(v, anchor.quote))}
              >
                ❝
              </button>
            )}
          </div>
          <div className="sheet-editor" onFocus={owner.onFocus} onBlur={owner.onBlur}>
            {owner.editable && (
              <ThoughtEditor
                initialBody={thought.body}
                label={`Thought: ${name}`}
                autoFocus
                onSave={save}
                onEscape={onClose}
                onFinish={onClose}
                onContent={() => session.wrote(id)}
                readOnly={session.isRemoving(id)}
                onView={setView}
                formatOnSelect={false}
              />
            )}
          </div>
        </div>

        <aside className="sheet-side" aria-label="Connections">
          <section>
            <h3>Links</h3>
            {links.length ? (
              <ul className="sheet-chips">
                {links.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            ) : (
              <p className="sheet-quiet">Type [[ to link a note.</p>
            )}
          </section>
          {siblings.length > 0 && (
            <section>
              <h3>On this highlight</h3>
              <RelatedList items={siblings} anchors={anchors} onSwitch={onSwitch} />
            </section>
          )}
          {related.length > 0 && (
            <section>
              <h3>Sharing a link</h3>
              <RelatedList items={related} anchors={anchors} onSwitch={onSwitch} />
            </section>
          )}
        </aside>

        <footer className="sheet-foot">
          <span role="status" className={status === 'failed' ? 'sheet-failed' : undefined}>
            {statusText}
          </span>
          <span>{words === 1 ? '1 word' : `${words} words`}</span>
          <span className="sheet-spacer" />
          <span className="sheet-hint">Esc or ⌘↵ to close</span>
          <button type="button" className="sheet-button mod-cta" onClick={onClose}>
            Done
          </button>
        </footer>
      </section>
    </div>
  );
}

function RelatedList({
  items,
  anchors,
  onSwitch,
}: {
  items: readonly Thought[];
  anchors: ReadonlyMap<string, Annotation>;
  onSwitch: (id: string) => void;
}) {
  return (
    <ul className="sheet-related">
      {items.map((t) => {
        const place = thoughtPlace(t, anchors);
        const name = labelText(thoughtLabel(t, place)) || place?.location.label || 'General thought';
        return (
          <li key={t.id}>
            <button type="button" onClick={() => onSwitch(t.id)} aria-label={`Open ${name}`}>
              <span className="sheet-related-name">{name}</span>
              <span className="sheet-related-body">{excerpt(t.body)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
