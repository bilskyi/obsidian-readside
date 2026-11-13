import { linkTargets } from '../../../src/features/notebook/format';
import type { ShelfBook, ShelfNote } from './shelfData';

/**
 * The notes hub's views over the shelf's entries (shelfNotes): its Inbox, today's Resurface, the topics
 * written into thoughts and notes, what relates to an entry, and a link it could have. All of it is worked
 * out here from the books' own files: nothing leaves the vault.
 */

export type HubSection =
  | { kind: 'inbox' }
  | { kind: 'resurface' }
  | { kind: 'all' }
  | { kind: 'topic'; topic: string }
  | { kind: 'book'; bookId: string };

/** A highlight comes back to Resurface once it is this old. */
export const RESURFACE_DAYS = 14;
/** How many highlights Resurface offers a day. */
export const RESURFACE_COUNT = 3;
const DAY_MS = 86_400_000;

const TAG = /(?:^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;

/** The `[[links]]` and `#tags` an entry's note and thoughts use: `Name` for a link, `#tag` for a tag. */
export function topicsOf(n: ShelfNote): string[] {
  const out: string[] = [];
  const add = (t: string) => {
    if (!out.includes(t)) out.push(t);
  };
  for (const text of [n.note ?? '', ...n.thoughts.map((t) => t.body)]) {
    for (const l of linkTargets(text)) add(l);
    for (const m of text.matchAll(TAG)) add(`#${m[1]}`);
  }
  return out;
}

/** Every topic in use, the most used first (then by name). */
export function allTopics(notes: readonly ShelfNote[]): { topic: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const n of notes) for (const t of topicsOf(n)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts]
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
}

/** A highlight with nothing written about it yet (no note, no thought), and not marked done. */
export const inInbox = (n: ShelfNote, done: ReadonlySet<string>): boolean =>
  n.quote !== null && !n.note && n.thoughts.length === 0 && !done.has(n.id);

/** A small stable hash, so a day's Resurface picks stay put through the day. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Today's few older highlights to read again: the same all day, different tomorrow. */
export function resurfaceToday(notes: readonly ShelfNote[], now: Date): ShelfNote[] {
  const cutoff = new Date(now.getTime() - RESURFACE_DAYS * DAY_MS).toISOString();
  const day = now.toISOString().slice(0, 10);
  return notes
    .filter((n) => n.quote !== null && n.createdAt <= cutoff)
    .map((n) => ({ n, k: hash(`${day}:${n.id}`) }))
    .sort((a, b) => a.k - b.k)
    .slice(0, RESURFACE_COUNT)
    .map((x) => x.n);
}

/** The entries a section shows, in the list's order (`notes` already sorted). */
export function sectionNotes(notes: readonly ShelfNote[], section: HubSection, done: ReadonlySet<string>, now: Date): ShelfNote[] {
  switch (section.kind) {
    case 'inbox':
      return notes.filter((n) => inInbox(n, done));
    case 'resurface':
      return resurfaceToday(notes, now);
    case 'topic':
      return notes.filter((n) => topicsOf(n).includes(section.topic));
    case 'book':
      return notes.filter((n) => n.book.bookId === section.bookId);
    default:
      return [...notes];
  }
}

/** Entries that share a topic with `n`, or sit at the same place in the same book; best first, at most `max`. */
export function relatedTo(n: ShelfNote, notes: readonly ShelfNote[], max = 5): { note: ShelfNote; why: string }[] {
  const mine = topicsOf(n);
  const place = n.location?.label;
  const out: { note: ShelfNote; why: string; score: number }[] = [];
  for (const o of notes) {
    if (o.id === n.id) continue;
    const shared = topicsOf(o).filter((t) => mine.includes(t));
    const samePlace = !!place && o.book.bookId === n.book.bookId && o.location?.label === place;
    if (!shared.length && !samePlace) continue;
    const why = shared.length ? shared.map((t) => (t.startsWith('#') ? t : `[[${t}]]`)).join(' ') : `Same place, ${place}`;
    out.push({ note: o, why, score: shared.length * 2 + (samePlace ? 1 : 0) });
  }
  return out
    .sort((a, b) => b.score - a.score || (a.note.updatedAt < b.note.updatedAt ? 1 : -1))
    .slice(0, max)
    .map(({ note, why }) => ({ note, why }));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A topic already in use that this entry's text names but doesn't link or tag: "Reading" in a quote about
 * reading. Matched as whole words, ignoring case; a tag by its name without the `#`. Null when none.
 */
export function suggestedTopic(n: ShelfNote, topics: readonly { topic: string }[]): string | null {
  const mine = topicsOf(n);
  const text = [n.quote ?? '', n.note ?? '', ...n.thoughts.map((t) => t.text)].join(' ');
  for (const { topic } of topics) {
    if (mine.includes(topic)) continue;
    const word = topic.startsWith('#') ? topic.slice(1).replace(/[/_-]/g, ' ') : topic;
    if (word.trim().length < 3) continue;
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(word)}($|[^\\p{L}\\p{N}])`, 'iu').test(text)) return topic;
  }
  return null;
}

/** How a topic is written into a thought. */
export const topicMarkup = (topic: string): string => (topic.startsWith('#') ? topic : `[[${topic}]]`);

/** Books with anything in the hub, in shelf order, with how many entries each has. */
export function hubBooks(books: readonly ShelfBook[], notes: readonly ShelfNote[]): { book: ShelfBook; count: number }[] {
  const counts = new Map<string, number>();
  for (const n of notes) counts.set(n.book.bookId, (counts.get(n.book.bookId) ?? 0) + 1);
  return books.filter((b) => counts.has(b.bookId)).map((book) => ({ book, count: counts.get(book.bookId)! }));
}
