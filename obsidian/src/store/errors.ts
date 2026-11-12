/**
 * A rejection the shared reader can show and match: `String(e)` is the bare message, like the string a
 * Tauri command rejects with (bodySaves and ReaderView test `String(e).startsWith('not found')`).
 */
export class MarginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarginError';
  }
  toString(): string {
    return this.message;
  }
}

export const notFound = (kind: string, id: string) => new MarginError(`not found: ${kind} ${id}`);
export const invalid = (message: string) => new MarginError(message);
