import { useEffect, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { ThoughtEditor } from '../../../src/features/notebook/ThoughtEditor';
import { LinkSuggestContext, type LinkSuggestSource } from '../../../src/features/notebook/linkSuggest';
import { COLORS, type Color, type Location } from '../../../src/lib/types';
import {
  allTopics,
  hubBooks,
  inInbox,
  relatedTo,
  resurfaceToday,
  sectionNotes,
  suggestedTopic,
  topicMarkup,
  topicsOf,
  type HubSection,
} from './hubData';
import { ago, placeOf, type NoteFilter, type NoteKind, type ShelfBook, type ShelfNote } from './shelfData';

/** Entries shown at first, and how many more each "Show more" adds. */
export const HUB_PAGE = 100;

const KINDS: { kind: NoteKind; label: string }[] = [
  { kind: 'all', label: 'All' },
  { kind: 'highlights', label: 'Highlights' },
  { kind: 'notes', label: 'Notes' },
  { kind: 'thoughts', label: 'Thoughts' },
];

/** Writes from the hub: a thought's new body, a new thought, an entry marked done in the Inbox. */
export interface HubWrites {
  saveThought(bookId: string, thoughtId: string, body: string): Promise<unknown>;
  /** A new thought on the highlight `anchorId` (null: at no place), with its first text; resolves to its id. */
  createThought(bookId: string, anchorId: string | null, body: string): Promise<string>;
  markDone(noteId: string, done: boolean): void;
}

export interface ShelfHubProps {
  /** Every entry (no filter), newest first; null until the first books are read. */
  everything: ShelfNote[] | null;
  /** The entries the kind / colour / order filters leave. */
  filtered: ShelfNote[] | null;
  done: boolean;
  books: readonly ShelfBook[];
  filter: NoteFilter;
  onFilter: (f: NoteFilter) => void;
  section: HubSection;
  onSection: (s: HubSection) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Inbox entries marked done. */
  inboxDone: ReadonlySet<string>;
  writes: HubWrites | null;
  linkSuggest?: LinkSuggestSource;
  open: (book: ShelfBook, location: Location | null) => ButtonHTMLAttributes<HTMLButtonElement>;
  now: () => Date;
}

const toggled = (colors: readonly Color[], c: Color) => (colors.includes(c) ? colors.filter((x) => x !== c) : [...colors, c]);
const sameSection = (a: HubSection, b: HubSection) =>
  a.kind === b.kind &&
  (a.kind !== 'topic' || (b.kind === 'topic' && a.topic === b.topic)) &&
  (a.kind !== 'book' || (b.kind === 'book' && a.bookId === b.bookId));

const SECTION_HINT: Record<HubSection['kind'], string> = {
  inbox: 'Highlights you haven’t written about yet.',
  resurface: `A few older highlights to read again today.`,
  all: 'Every highlight and thought, across your books.',
  topic: 'Everything that links or tags this.',
  book: 'Everything from this book.',
};

/**
 * The notes hub: a place to work through what you have read, across books. On the left its sections
 * (Inbox, Resurface, Everything, the topics you link and tag, the books); in the middle that section's
 * entries; on the right the chosen one, its thoughts editable, with what relates to it and a link it
 * could have. A narrow shelf shows the sections as a row and the entry in place of the list.
 */
export function ShelfHub(p: ShelfHubProps) {
  const id = useId();
  const now = p.now();
  const everything = p.everything ?? [];
  const topics = useMemo(() => allTopics(everything), [everything]);
  const books = useMemo(() => hubBooks(p.books, everything), [p.books, everything]);
  const inboxCount = useMemo(() => everything.filter((n) => inInbox(n, p.inboxDone)).length, [everything, p.inboxDone]);
  const resurfaceCount = useMemo(() => resurfaceToday(everything, now).length, [everything, now.toISOString().slice(0, 10)]);
  // The filters apply to Everything, a topic and a book; Inbox and Resurface are what they are.
  const filterable = p.section.kind === 'all' || p.section.kind === 'topic' || p.section.kind === 'book';
  const base = filterable ? (p.filtered ?? []) : everything;
  const list = useMemo(
    () => sectionNotes(base, p.section, p.inboxDone, now),
    [base, p.section, p.inboxDone, now.toISOString().slice(0, 10)],
  );
  const [limit, setLimit] = useState(HUB_PAGE);
  useEffect(() => setLimit(HUB_PAGE), [p.section, p.filter]);
  const selected = p.selectedId ? (everything.find((n) => n.id === p.selectedId) ?? null) : null;
  // A chosen entry comes into view (on a narrow shelf it replaces the list, which may be scrolled far down).
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (p.selectedId) detailRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [p.selectedId]);

  const navButton = (s: HubSection, label: string, count: number | null, key: string) => (
    <li key={key}>
      <button type="button" aria-current={sameSection(s, p.section) ? 'true' : undefined} onClick={() => p.onSection(s)}>
        <span className="hub-nav-label">{label}</span>
        {count !== null && <span className="hub-nav-count">{count}</span>}
      </button>
    </li>
  );

  const title =
    p.section.kind === 'inbox'
      ? 'Inbox'
      : p.section.kind === 'resurface'
        ? 'Resurface'
        : p.section.kind === 'all'
          ? 'Everything'
          : p.section.kind === 'topic'
            ? topicMarkup(p.section.topic)
            : (p.books.find((b) => p.section.kind === 'book' && b.bookId === p.section.bookId)?.title ?? 'Book');

  let body: ReactNode;
  if (p.everything === null || (!p.done && list.length === 0)) body = <p className="shelf-quiet">Loading…</p>;
  else if (list.length === 0)
    body = (
      <p className="shelf-quiet">
        {p.section.kind === 'inbox'
          ? 'Inbox is empty: every highlight has a note or a thought.'
          : p.section.kind === 'resurface'
            ? `Highlights come back here once they are ${14} days old.`
            : everything.length === 0
              ? 'Highlights and thoughts you make while reading show up here.'
              : 'Nothing matches these filters.'}
      </p>
    );
  else
    body = (
      <ul className="hub-items">
        {list.slice(0, limit).map((n) => (
          <HubItem key={n.id} n={n} current={n.id === p.selectedId} onSelect={() => p.onSelect(n.id)} now={now} />
        ))}
      </ul>
    );

  return (
    <section className="hub-frame" aria-label="Highlights and thoughts">
      <div className={selected ? 'shelf-hub has-detail' : 'shelf-hub'}>
        <nav className="hub-nav" aria-label="Sections">
          <ul>
            {navButton({ kind: 'inbox' }, 'Inbox', inboxCount, 'inbox')}
            {navButton({ kind: 'resurface' }, 'Resurface', resurfaceCount, 'resurface')}
            {navButton({ kind: 'all' }, 'Everything', everything.length, 'all')}
          </ul>
          {topics.length > 0 && (
            <>
              <h3 id={`${id}-topics`}>Topics</h3>
              <ul aria-labelledby={`${id}-topics`}>
                {topics.map((t) => navButton({ kind: 'topic', topic: t.topic }, topicMarkup(t.topic), t.count, `t:${t.topic}`))}
              </ul>
            </>
          )}
          {books.length > 0 && (
            <>
              <h3 id={`${id}-books`}>Books</h3>
              <ul aria-labelledby={`${id}-books`}>
                {books.map(({ book, count }) => navButton({ kind: 'book', bookId: book.bookId }, book.title, count, `b:${book.bookId}`))}
              </ul>
            </>
          )}
        </nav>

        <div className="hub-list">
          <header className="hub-list-head">
            <h2>{title}</h2>
            <p className="shelf-quiet" role="status">
              {SECTION_HINT[p.section.kind]} {list.length === 1 ? '1 entry' : `${list.length} entries`}
              {p.done ? '' : ' so far…'}
            </p>
          </header>
          {filterable && (
            <div className="shelf-notes-filters">
              <div className="shelf-segmented" role="group" aria-label="Show">
                {KINDS.map((k) => (
                  <button
                    key={k.kind}
                    type="button"
                    aria-pressed={p.filter.kind === k.kind}
                    onClick={() => p.onFilter({ ...p.filter, kind: k.kind })}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
              <div className="shelf-colors" role="group" aria-label="Colours">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="shelf-color"
                    aria-label={`Show ${c}`}
                    aria-pressed={p.filter.colors.includes(c)}
                    style={{ '--dot': `var(--hl-${c})` } as CSSProperties}
                    onClick={() =>
                      p.onFilter({
                        ...p.filter,
                        colors: toggled(p.filter.colors, c),
                      })
                    }
                  />
                ))}
              </div>
              <label className="shelf-select">
                <span className="shelf-visually-hidden">Order</span>
                <select
                  value={p.filter.sort}
                  onChange={(e) =>
                    p.onFilter({
                      ...p.filter,
                      sort: e.target.value === 'book' ? 'book' : 'newest',
                    })
                  }
                >
                  <option value="newest">Newest first</option>
                  <option value="book">By book</option>
                </select>
              </label>
            </div>
          )}
          {body}
          {list.length > limit && (
            <button type="button" className="shelf-button shelf-notes-more" onClick={() => setLimit((l) => l + HUB_PAGE)}>
              Show {Math.min(HUB_PAGE, list.length - limit)} more
            </button>
          )}
        </div>

        <div className="hub-detail" ref={detailRef}>
          {selected ? (
            <LinkSuggestContext.Provider value={p.linkSuggest ?? null}>
              <HubDetail
                key={selected.id}
                n={selected}
                everything={everything}
                topics={topics}
                inInbox={inInbox(selected, p.inboxDone)}
                writes={p.writes}
                open={p.open}
                onSelect={p.onSelect}
                onTopic={(topic) => p.onSection({ kind: 'topic', topic })}
                now={now}
              />
            </LinkSuggestContext.Provider>
          ) : (
            <p className="shelf-quiet hub-detail-empty">Choose an entry to read it, write about it and see what it connects to.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function HubItem({ n, current, onSelect, now }: { n: ShelfNote; current: boolean; onSelect: () => void; now: Date }) {
  const place = placeOf(n.location);
  const first = n.note ?? n.thoughts[0]?.text ?? null;
  return (
    <li>
      <button
        type="button"
        className="hub-item"
        aria-current={current ? 'true' : undefined}
        style={
          {
            '--bar': n.color ? `var(--hl-${n.color}-ink)` : 'var(--ink)',
          } as CSSProperties
        }
        onClick={onSelect}
      >
        {n.quote !== null && <span className="hub-item-quote">{n.quote}</span>}
        {first && <span className={n.quote === null ? 'hub-item-text is-own' : 'hub-item-text'}>{first}</span>}
        <span className="shelf-meta">{[n.book.title, place, ago(n.updatedAt, now)].filter(Boolean).join(' · ')}</span>
      </button>
    </li>
  );
}

function HubDetail({
  n,
  everything,
  topics,
  inInbox: waiting,
  writes,
  open,
  onSelect,
  onTopic,
  now,
}: {
  n: ShelfNote;
  everything: readonly ShelfNote[];
  topics: readonly { topic: string }[];
  inInbox: boolean;
  writes: HubWrites | null;
  open: ShelfHubProps['open'];
  onSelect: (id: string | null) => void;
  onTopic: (topic: string) => void;
  now: Date;
}) {
  const place = placeOf(n.location);
  const related = relatedTo(n, everything);
  const suggestion = writes ? suggestedTopic(n, topics) : null;
  const anchorId = n.quote !== null ? n.id : null;
  /** A thought written here that the book files don't show yet (its first save is on its way). */
  const [draft, setDraft] = useState<{ key: number; id: string | null } | null>(null);
  const draftId = useRef<Promise<string> | null>(null);
  const shown = new Set(n.thoughts.map((t) => t.id));
  const pending = draft && (draft.id === null || !shown.has(draft.id)) ? draft : null;

  const saveDraft = (body: string): Promise<unknown> => {
    if (!writes) return Promise.resolve();
    if (!draftId.current) {
      if (!body.trim()) return Promise.resolve();
      draftId.current = writes.createThought(n.book.bookId, anchorId, body).then((tid) => {
        setDraft((d) => (d ? { ...d, id: tid } : d));
        return tid;
      });
      draftId.current.catch(() => {
        draftId.current = null;
      });
      return draftId.current;
    }
    return draftId.current.then((tid) => writes.saveThought(n.book.bookId, tid, body));
  };
  const startDraft = () => {
    draftId.current = null;
    setDraft({ key: Date.now(), id: null });
  };
  const addTopic = (topic: string) => {
    if (!writes) return;
    const mark = topicMarkup(topic);
    const last = n.thoughts[n.thoughts.length - 1];
    if (last) void writes.saveThought(n.book.bookId, last.id, `${last.body.trimEnd()} ${mark}`);
    else void writes.createThought(n.book.bookId, anchorId, mark);
  };

  return (
    <article className="hub-entry" aria-label={n.quote ?? 'Thought'}>
      <header className="hub-entry-head">
        <span className="shelf-meta">{[n.book.title, place, ago(n.updatedAt, now)].filter(Boolean).join(' · ')}</span>
        <span className="hub-spacer" />
        <button type="button" className="shelf-button" {...open(n.book, n.location)}>
          Open in book
        </button>
        <button type="button" className="shelf-button hub-back" onClick={() => onSelect(null)}>
          Back to list
        </button>
      </header>
      {n.quote !== null && (
        <blockquote
          className="hub-quote"
          style={
            {
              '--bar': n.color ? `var(--hl-${n.color})` : 'var(--ink)',
            } as CSSProperties
          }
        >
          {n.quote}
        </blockquote>
      )}
      {n.note && (
        <p className="hub-note">
          <span className="shelf-note-label">Note</span> {n.note}
        </p>
      )}

      <section className="hub-thoughts" aria-label="Thoughts">
        {n.thoughts.map((t) => (
          <div key={t.id} className="hub-thought">
            {writes ? (
              <ThoughtEditor initialBody={t.body} label="Thought" onSave={(body) => writes.saveThought(n.book.bookId, t.id, body)} />
            ) : (
              <p>{t.text}</p>
            )}
          </div>
        ))}
        {writes && pending && (
          <div key={pending.key} className="hub-thought">
            <ThoughtEditor
              initialBody=""
              label="New thought"
              autoFocus
              placeholder="Write a thought. [[ links a note, # adds a tag."
              onSave={saveDraft}
            />
          </div>
        )}
        {writes && !pending && (
          <div className="hub-actions">
            <button type="button" className="shelf-button" onClick={startDraft}>
              {n.thoughts.length ? 'Add a thought' : 'Write a thought'}
            </button>
            {waiting && (
              <button type="button" className="shelf-button" onClick={() => writes.markDone(n.id, true)}>
                Done, nothing to add
              </button>
            )}
          </div>
        )}
      </section>

      {suggestion && (
        <p className="hub-suggest">
          <span>
            This mentions <b>{suggestion.replace(/^#/, '')}</b>, a topic you use.
          </span>
          <button type="button" className="shelf-link" onClick={() => addTopic(suggestion)}>
            Add {topicMarkup(suggestion)}
          </button>
        </p>
      )}

      {topicsLine(n, onTopic)}

      {related.length > 0 && (
        <section className="hub-related" aria-label="Related">
          <h3>Related</h3>
          <ul>
            {related.map(({ note, why }) => (
              <li key={note.id}>
                <button type="button" onClick={() => onSelect(note.id)}>
                  <span className="hub-item-quote">{note.quote ?? note.thoughts[0]?.text ?? ''}</span>
                  <span className="shelf-meta">
                    {note.book.title} · {why}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

/** The entry's own topics, each a way into that topic's list. */
function topicsLine(n: ShelfNote, onTopic: (t: string) => void) {
  const mine = topicsOf(n);
  if (!mine.length) return null;
  return (
    <ul className="hub-topics" aria-label="Topics">
      {mine.map((t) => (
        <li key={t}>
          <button type="button" onClick={() => onTopic(t)}>
            {topicMarkup(t)}
          </button>
        </li>
      ))}
    </ul>
  );
}
