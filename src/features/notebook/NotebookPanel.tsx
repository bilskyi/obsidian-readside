import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { labelText, thoughtLabel } from '../../lib/labels';
import { parseLocation, sameSpot } from '../../lib/location';
import { displayQuote } from '../../lib/quote';
import { COLORS, type Annotation, type Location, type Thought } from '../../lib/types';
import { linkedFromText } from '../marginalia/backlinks';
import { useEditorOwner } from './editorOwners';
import { EntryMenu, type MenuItem } from './EntryMenu';
import { LabelField } from './LabelField';
import {
  buildNotebook,
  ENTRY_TYPES,
  linkForEntry,
  SHOW_ALL,
  type EntryType,
  type NotebookEntry,
  type NotebookFilter,
} from './notebookModel';
import { ThoughtEditor } from './ThoughtEditor';
import { ThoughtLabelView } from './ThoughtLabel';
import { NEW_THOUGHT_PLACEHOLDER, ThoughtSessionContext } from './thoughtSession';
import { thoughtMenuItems } from './thoughtMenu';
import { ThoughtPreview } from './ThoughtPreview';
import { useInlineRename } from './useInlineRename';
import './notebook.css';

export interface NotebookPanelProps {
  annotations: Annotation[];
  thoughts: Thought[];
  currentLocation: Location | null;
  /** A thought that was just created and should receive keyboard focus. */
  focusThoughtId: string | null;
  onFocusHandled: () => void;
  onNavigate: (location: Location) => void;
  /** Resolves once the body is saved; rejects on failure so the editor retries. */
  onSaveThought: (id: string, body: string) => Promise<unknown>;
  onCopyLink: (url: string) => void;
  onUnlinkThought: (thought: Thought, anchor: Annotation | null) => void;
  onDeleteThought: (thought: Thought) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
  /** A custom name for the thought; null restores the automatic label. */
  onRenameThought: (id: string, label: string | null) => void;
  /** Go to a thought where it is edited: scroll to its place and focus its margin note (Plan 4B). */
  onOpenThought?: (thought: Thought, location: Location) => void;
  /** The thought whose margin note has focus: marked here and kept in view. */
  activeThoughtId?: string | null;
  /** How many notes elsewhere (Obsidian: vault notes) link into the book; said in the header when any do. */
  linkedFrom?: number;
  /** Thoughts created moments ago: their entries pulse once, so the eye finds them. */
  fresh?: ReadonlySet<string>;
  width: number;
}

type EntryActions = Pick<
  NotebookPanelProps,
  | 'onNavigate'
  | 'onSaveThought'
  | 'onCopyLink'
  | 'onUnlinkThought'
  | 'onDeleteThought'
  | 'onDeleteAnnotation'
  | 'onRenameThought'
  | 'onOpenThought'
>;
type AnnotationEntryData = Extract<NotebookEntry, { kind: 'annotation' }>;
type ThoughtEntryData = Extract<NotebookEntry, { kind: 'thought' }>;

const TYPE_LABELS: Record<EntryType, string> = { highlight: 'Highlights', note: 'Notes', thought: 'Thoughts' };

const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

const toggled = <T,>(set: ReadonlySet<T>, v: T): Set<T> => {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
};

const entryKey = (e: NotebookEntry) => (e.kind === 'annotation' ? `a:${e.annotation.id}` : `t:${e.thought.id}`);

export function NotebookPanel(props: NotebookPanelProps) {
  const { annotations, thoughts, currentLocation, focusThoughtId, onFocusHandled, width, activeThoughtId = null, linkedFrom = 0, fresh } = props;
  const uid = useId();
  const [filter, setFilter] = useState<NotebookFilter>(SHOW_ALL);
  const groups = useMemo(() => buildNotebook(annotations, thoughts, filter), [annotations, thoughts, filter]);
  const showsThoughts = filter.types.has('thought');
  // Annotations on screen; a thought whose anchor is filtered out shows the anchor's quote instead.
  const shownAnnotations = useMemo(
    () => new Set(groups.flatMap((g) => g.entries.flatMap((e) => (e.kind === 'annotation' ? [e.annotation.id] : [])))),
    [groups],
  );

  // A thought that is about to be focused must not be filtered out.
  useEffect(() => {
    if (focusThoughtId && !showsThoughts) setFilter((f) => ({ ...f, types: toggled(f.types, 'thought') }));
  }, [focusThoughtId, showsThoughts]);

  // Editors focus themselves in their own effects, which run before this parent effect.
  useEffect(() => {
    if (focusThoughtId && showsThoughts && thoughts.some((t) => t.id === focusThoughtId)) onFocusHandled();
  }, [focusThoughtId, showsThoughts, thoughts, onFocusHandled]);

  const count = annotations.length + thoughts.length;
  const actions: EntryActions = props;

  return (
    <aside className="notebook" aria-label="Notebook" style={{ width }}>
      <header className="notebook-bar">
        <h2 className="notebook-title">Notebook</h2>
        <span className="notebook-count">{count === 1 ? '1 entry' : `${count} entries`}</span>
        {linkedFrom > 0 && (
          <span className="notebook-linked">
            <span aria-hidden="true">↩ </span>
            {linkedFromText(linkedFrom)}
          </span>
        )}
      </header>
      <div className="notebook-filters" role="group" aria-label="Filter entries">
        <span className="nb-chips">
          {ENTRY_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              className="nb-chip"
              aria-pressed={filter.types.has(t)}
              onClick={() => setFilter((f) => ({ ...f, types: toggled(f.types, t) }))}
            >
              {TYPE_LABELS[t]}
            </button>
          ))}
        </span>
        <span className="nb-swatches">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`nb-swatch nb-color-${c}`}
              aria-label={`Show ${c}`}
              aria-pressed={filter.colors.has(c)}
              onClick={() => setFilter((f) => ({ ...f, colors: toggled(f.colors, c) }))}
            />
          ))}
        </span>
      </div>
      <div className="notebook-scroll">
        {groups.length === 0 ? (
          <p className="notebook-empty">
            {count === 0
              ? 'Highlights and thoughts for this book appear here. Select text and press T, or press ⌘⇧M, to add a thought.'
              : 'Nothing matches these filters.'}
          </p>
        ) : (
          groups.map((g, i) => (
            <section key={g.key} className="nb-group" aria-labelledby={`${uid}-g${i}`}>
              <h3 id={`${uid}-g${i}`} className="nb-group-label">
                {g.label}
              </h3>
              <ul className="nb-entries">
                {g.entries.map((e) => {
                  const current = !!(e.location && currentLocation && sameSpot(e.location, currentLocation));
                  return e.kind === 'annotation' ? (
                    <AnnotationEntry key={entryKey(e)} entry={e} current={current} actions={actions} />
                  ) : (
                    <ThoughtEntry
                      key={entryKey(e)}
                      entry={e}
                      current={current}
                      focus={e.thought.id === focusThoughtId}
                      active={e.thought.id === activeThoughtId}
                      isNew={!!fresh?.has(e.thought.id)}
                      showAnchorQuote={!!e.anchor && !shownAnnotations.has(e.anchor.id)}
                      actions={actions}
                    />
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </aside>
  );
}

function AnnotationEntry({ entry, current, actions }: { entry: AnnotationEntryData; current: boolean; actions: EntryActions }) {
  const { annotation: a, location } = entry;
  const kind = a.note ? 'note' : 'highlight';
  // An unanchored highlight has no entry location; its stored one still says which format it quotes.
  const quote = displayQuote(a.quote, (location ?? parseLocation(a.location))?.kind);
  const link = linkForEntry(entry);
  const items: MenuItem[] = [
    ...(link ? [{ label: 'Copy Link', onSelect: () => actions.onCopyLink(link) }] : []),
    { label: a.note ? 'Delete Note' : 'Delete Highlight', onSelect: () => actions.onDeleteAnnotation(a), danger: true },
  ];
  return (
    <li className={cx('nb-entry nb-annotation', `nb-color-${a.color}`, current && 'is-current')}>
      {location ? (
        <button type="button" className="nb-quote" title={`Go to ${location.label}`} onClick={() => actions.onNavigate(location)}>
          {quote}
        </button>
      ) : (
        <div className="nb-quote">{quote}</div>
      )}
      {a.note && <p className="nb-note">{a.note}</p>}
      <EntryMenu label={location ? `Actions for ${kind} on ${location.label}` : `Actions for unanchored ${kind}`} items={items} />
    </li>
  );
}

function ThoughtEntry({
  entry,
  current,
  focus,
  active,
  showAnchorQuote,
  actions,
  isNew = false,
}: {
  entry: ThoughtEntryData;
  current: boolean;
  focus: boolean;
  /** Created moments ago: it pulses once. */
  isNew?: boolean;
  /** Its margin note has focus. */
  active: boolean;
  showAnchorQuote: boolean;
  actions: EntryActions;
}) {
  const { thought, location, anchor } = entry;
  const link = linkForEntry(entry);
  const place = location ? { location, quote: anchor?.quote ?? null } : null;
  const label = thoughtLabel(thought, place);
  const barRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  // Its margin note has focus: keep the entry in view here too.
  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);
  /** The thought's header: its "Go to thought" button, or a general thought's ⋯ button. */
  const entryHead = () => barRef.current?.querySelector<HTMLElement>('button.nb-thought-head, .nb-menu-btn');
  // After Enter or Escape, focus goes back to the thought's header.
  const { renaming, startRename, finishRename } = useInlineRename(thought, actions.onRenameThought, entryHead);
  const items = thoughtMenuItems(thought, anchor, link, actions, startRename);
  const editorLabel = location ? `Thought on ${location.label}` : 'General thought';
  // One editor per thought: while its margin note holds the editor, the notebook shows a preview.
  const owner = useEditorOwner(thought.id, 'notebook');
  const session = useContext(ThoughtSessionContext);
  return (
    <li
      ref={rowRef}
      className={cx('nb-entry nb-thought', anchor && 'is-anchored', current && 'is-current', active && 'is-active', isNew && 'is-pulse')}
      data-thought-id={thought.id}
    >
      <div className="nb-thought-bar" ref={barRef}>
        {renaming ? (
          <LabelField
            initial={thought.labelCustom?.trim() ?? ''}
            placeholder={labelText(thoughtLabel({ ...thought, labelCustom: null }, place)) || 'Name this thought'}
            onDone={finishRename}
          />
        ) : location ? (
          <button
            type="button"
            className="nb-thought-head"
            aria-label={`Go to thought: ${labelText(label) || location.label}`}
            title={labelText(label) || undefined}
            onClick={() => (actions.onOpenThought ? actions.onOpenThought(thought, location) : actions.onNavigate(location))}
          >
            Thought
            <ThoughtLabelView label={label} />
          </button>
        ) : (
          <span className="nb-thought-head" title={labelText(label) || undefined}>
            Thought
            <ThoughtLabelView label={label} />
          </span>
        )}
        <EntryMenu
          label={location ? `Actions for thought on ${location.label}` : 'Actions for general thought'}
          items={items}
        />
      </div>
      {anchor && showAnchorQuote && <p className={`nb-context nb-color-${anchor.color}`}>{anchor.quote}</p>}
      {owner.editable ? (
        <div className="thought-editor-slot" onFocus={owner.onFocus} onBlur={owner.onBlur}>
          <ThoughtEditor
            initialBody={thought.body}
            label={editorLabel}
            autoFocus={focus}
            onSave={(body) => actions.onSaveThought(thought.id, body)}
            placeholder={session.isNew(thought.id) ? NEW_THOUGHT_PLACEHOLDER : undefined}
            // Esc hands focus back to the entry's name (the ⋯ button for a general thought), not the page.
            onEscape={() => session.finish({ id: thought.id, returnTo: entryHead() })}
            onFinish={() => session.finish()}
            onContent={() => session.wrote(thought.id)}
            readOnly={session.isRemoving(thought.id)}
          />
        </div>
      ) : (
        <ThoughtPreview
          body={thought.body}
          action="Write in the margin"
          onActivate={() => {
            if (location) actions.onOpenThought?.(thought, location);
          }}
        />
      )}
    </li>
  );
}
