import type { RecoveryEvent } from './store/bookStore';

const quoted = (name: string) => `“${name}”`;

/** How many book names a message lists before "and N more". */
export const NAMES_SHOWN = 5;

/** “A”, “B”, … “E” and 3 more. */
function names(books: { name: string }[]): string {
  const shown = books.slice(0, NAMES_SHOWN).map((b) => quoted(b.name)).join(', ');
  const rest = books.length - NAMES_SHOWN;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

const count = (n: number) => `${n} ${n === 1 ? 'book' : 'books'}`;

/** What the user is told (in a Notice) about something the store repaired on load. */
export function recoveryMessage(e: RecoveryEvent): string {
  switch (e.kind) {
    case 'book-kept-aside':
      return `Readside: the saved highlights and thoughts of ${quoted(e.name)} were damaged and there was no backup. The damaged copy is kept as ${e.keptAs}.`;
    case 'backup-restored':
      return `Readside: the saved highlights and thoughts of ${quoted(e.name)} were damaged and have been restored from ${e.backup}; changes after that backup may be missing. The damaged copy is kept as ${e.keptAs}.`;
    case 'index-rebuilt': {
      const head = `Readside's index of books was damaged and has been rebuilt from the book files. The damaged copy is kept as ${e.keptAs}.`;
      const n = e.books.length;
      if (n === 0) return head;
      return `${head} ${count(n)} came back with ${n === 1 ? 'its' : 'their'} highlights and thoughts: ${names(e.books)}. ${n === 1 ? 'It reconnects' : 'Each reconnects'} when its PDF is opened in Readside.`;
    }
    case 'orphans-swept': {
      const n = e.books.length;
      return `Readside found ${count(n)} not linked to a PDF in this vault: ${names(e.books)}. Their highlights and thoughts are kept, marked missing.`;
    }
  }
}
