import { describe, expect, it } from 'vitest';
import { allTopics, inInbox, relatedTo, resurfaceToday, RESURFACE_COUNT, suggestedTopic, topicsOf } from '../src/shelf/hubData';
import type { ShelfBook, ShelfNote } from '../src/shelf/shelfData';

const book = (id: string) => ({ bookId: id, title: id, path: `${id}.pdf` }) as unknown as ShelfBook;
function note(id: string, over: Partial<ShelfNote> = {}): ShelfNote {
  return {
    id,
    book: book('b1'),
    quote: `quote ${id}`,
    color: 'yellow',
    note: null,
    thoughts: [],
    location: { kind: 'pdf', value: { page: 1, start: 0, end: 1 }, label: 'p. 1' },
    page: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}
const thought = (body: string, id = 't') => ({ id, body, text: body });

describe('hub data', () => {
  it('topics are the [[links]] and #tags of the note and thoughts, once each', () => {
    const n = note('a', { note: 'see #ideas', thoughts: [thought('[[Simplicity]] and #ideas, #2026 is no tag, url.org/#x neither')] });
    expect(topicsOf(n)).toEqual(['#ideas', 'Simplicity']);
    const topics = allTopics([n, note('b', { thoughts: [thought('[[Simplicity]]')] })]);
    expect(topics).toEqual([
      { topic: 'Simplicity', count: 2 },
      { topic: '#ideas', count: 1 },
    ]);
  });

  it('the Inbox is highlights with nothing written, less the ones marked done', () => {
    expect(inInbox(note('a'), new Set())).toBe(true);
    expect(inInbox(note('a'), new Set(['a']))).toBe(false);
    expect(inInbox(note('a', { note: 'x' }), new Set())).toBe(false);
    expect(inInbox(note('a', { thoughts: [thought('x')] }), new Set())).toBe(false);
    expect(inInbox(note('a', { quote: null }), new Set())).toBe(false);
  });

  it('Resurface picks a few older highlights, the same all day and different another day', () => {
    const notes = Array.from({ length: 20 }, (_, i) => note(`n${i}`));
    const fresh = note('fresh', { createdAt: '2026-11-10T00:00:00.000Z' });
    const day = new Date('2026-11-13T09:00:00.000Z');
    const a = resurfaceToday([...notes, fresh], day).map((n) => n.id);
    expect(a).toHaveLength(RESURFACE_COUNT);
    expect(a).not.toContain('fresh');
    expect(resurfaceToday([...notes, fresh], new Date('2026-11-13T22:00:00.000Z')).map((n) => n.id)).toEqual(a);
    expect(resurfaceToday(notes, new Date('2026-11-14T09:00:00.000Z')).map((n) => n.id)).not.toEqual(a);
  });

  it('related entries share a topic or a place; a suggested topic is one the text names but doesn’t link', () => {
    const a = note('a', { thoughts: [thought('[[Simplicity]]')] });
    const b = note('b', { thoughts: [thought('more [[Simplicity]]')], location: null });
    const c = note('c', { location: { kind: 'pdf', value: { page: 1, start: 0, end: 1 }, label: 'p. 1' } });
    const d = note('d', { book: book('b2') });
    expect(relatedTo(a, [a, b, c, d]).map((r) => [r.note.id, r.why])).toEqual([
      ['b', '[[Simplicity]]'],
      ['c', 'Same place, p. 1'],
    ]);
    const topics = allTopics([a, b, note('e', { thoughts: [thought('#slow-reading')] })]);
    expect(suggestedTopic(note('x', { quote: 'A life of simplicity' }), topics)).toBe('Simplicity');
    expect(suggestedTopic(note('x', { quote: 'simple' }), topics)).toBeNull();
    expect(suggestedTopic(note('x', { quote: 'in praise of slow reading' }), topics)).toBe('#slow-reading');
    expect(suggestedTopic(a, topics)).toBeNull();
  });
});
