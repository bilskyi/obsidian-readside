import { useId, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { COLORS, type Color, type Location } from '../../../src/lib/types';
import { ago, placeOf, type NoteFilter, type NoteKind, type ShelfBook, type ShelfNote } from './shelfData';

/** Entries shown at first, and how many more each "Show more" adds. */
export const NOTES_PAGE = 100;

const KINDS: { kind: NoteKind; label: string }[] = [
  { kind: 'all', label: 'All' },
  { kind: 'highlights', label: 'Highlights' },
  { kind: 'notes', label: 'Notes' },
  { kind: 'thoughts', label: 'Thoughts' },
];

export interface ShelfNotesProps {
  /** The entries for `filter`; null until the first books are read. */
  notes: ShelfNote[] | null;
  /** False while books are still being read (the list grows). */
  done: boolean;
  /** Books that have highlights or thoughts, for the book picker (shelf order). */
  books: readonly ShelfBook[];
  filter: NoteFilter;
  onFilter: (f: NoteFilter) => void;
  /** Click handlers that open an entry's book at its place (a plain, ⌘/Ctrl- or middle click). */
  open: (book: ShelfBook, location: Location | null) => ButtonHTMLAttributes<HTMLButtonElement>;
  now: () => Date;
}

const toggled = (colors: readonly Color[], c: Color) => (colors.includes(c) ? colors.filter((x) => x !== c) : [...colors, c]);

/** "Highlights & thoughts": every highlight (with its note and thoughts) and thought, across books. */
export function ShelfNotes({ notes, done, books, filter, onFilter, open, now }: ShelfNotesProps) {
  const id = useId();
  const [limit, setLimit] = useState(NOTES_PAGE);
  const set = (f: Partial<NoteFilter>) => {
    setLimit(NOTES_PAGE);
    onFilter({ ...filter, ...f });
  };
  const filtered = filter.kind !== 'all' || filter.colors.length > 0 || filter.bookId !== null;
  const shown = notes?.slice(0, limit) ?? [];

  let list: ReactNode;
  if (notes === null) list = <p className="shelf-quiet">Loading…</p>;
  else if (notes.length === 0)
    list = (
      <p className="shelf-quiet">
        {!done ? 'Loading…' : filtered ? 'Nothing matches these filters.' : 'Highlights and thoughts you make while reading show up here.'}
      </p>
    );
  else if (filter.sort === 'book') {
    // Book by book: a heading per book, its entries in reading order under it.
    const groups: { book: ShelfBook; items: ShelfNote[] }[] = [];
    for (const n of shown) {
      const last = groups[groups.length - 1];
      if (last && last.book.bookId === n.book.bookId) last.items.push(n);
      else groups.push({ book: n.book, items: [n] });
    }
    list = groups.map((g) => (
      <section key={g.book.bookId} className="shelf-notes-group" aria-labelledby={`${id}-${g.book.bookId}`}>
        <h3 id={`${id}-${g.book.bookId}`} className="shelf-notes-book">
          {g.book.title}
        </h3>
        <ul className="shelf-notes-list">
          {g.items.map((n) => (
            <NoteItem key={n.id} n={n} open={open} now={now} showBook={false} />
          ))}
        </ul>
      </section>
    ));
  } else
    list = (
      <ul className="shelf-notes-list">
        {shown.map((n) => (
          <NoteItem key={n.id} n={n} open={open} now={now} showBook />
        ))}
      </ul>
    );

  return (
    <section className="shelf-notes" aria-label="Highlights and thoughts">
      <div className="shelf-notes-filters">
        <div className="shelf-segmented" role="group" aria-label="Show">
          {KINDS.map((k) => (
            <button key={k.kind} type="button" aria-pressed={filter.kind === k.kind} onClick={() => set({ kind: k.kind })}>
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
              aria-pressed={filter.colors.includes(c)}
              style={{ '--dot': `var(--hl-${c})` } as CSSProperties}
              onClick={() => set({ colors: toggled(filter.colors, c) })}
            />
          ))}
        </div>
        <label className="shelf-select">
          <span className="shelf-visually-hidden">Book</span>
          <select id={`${id}-book`} value={filter.bookId ?? ''} onChange={(e) => set({ bookId: e.target.value || null })}>
            <option value="">All books</option>
            {books.map((b) => (
              <option key={b.bookId} value={b.bookId}>
                {b.title}
              </option>
            ))}
          </select>
        </label>
        <label className="shelf-select">
          <span className="shelf-visually-hidden">Order</span>
          <select id={`${id}-sort`} value={filter.sort} onChange={(e) => set({ sort: e.target.value === 'book' ? 'book' : 'newest' })}>
            <option value="newest">Newest first</option>
            <option value="book">By book</option>
          </select>
        </label>
      </div>
      {notes !== null && notes.length > 0 && (
        <p className="shelf-quiet shelf-notes-count" role="status">
          {notes.length === 1 ? '1 entry' : `${notes.length} entries`}
          {done ? '' : ' so far…'}
        </p>
      )}
      {list}
      {notes !== null && notes.length > limit && (
        <button type="button" className="shelf-button shelf-notes-more" onClick={() => setLimit((l) => l + NOTES_PAGE)}>
          Show {Math.min(NOTES_PAGE, notes.length - limit)} more
        </button>
      )}
    </section>
  );
}

function NoteItem({ n, open, now, showBook }: { n: ShelfNote; open: ShelfNotesProps['open']; now: () => Date; showBook: boolean }) {
  const place = placeOf(n.location);
  const where = [showBook ? n.book.title : null, place].filter(Boolean).join(' · ');
  return (
    <li>
      <button
        type="button"
        className="shelf-note"
        style={{ '--bar': n.color ? `var(--hl-${n.color}-ink)` : 'var(--ink)' } as CSSProperties}
        {...open(n.book, n.location)}
      >
        <span className="shelf-note-bar" aria-hidden="true" />
        <span className="shelf-note-body">
          {n.quote !== null && <span className="shelf-note-quote">{n.quote}</span>}
          {n.note && (
            <span className="shelf-note-note">
              <span className="shelf-note-label">Note</span> {n.note}
            </span>
          )}
          {n.thoughts.map((t) => (
            <span key={t.id} className={n.quote === null ? 'shelf-note-thought is-own' : 'shelf-note-thought'}>
              {t.text}
            </span>
          ))}
          <span className="shelf-meta">
            {where}
            {where ? ' · ' : ''}
            {ago(n.updatedAt, now())}
          </span>
        </span>
      </button>
    </li>
  );
}
