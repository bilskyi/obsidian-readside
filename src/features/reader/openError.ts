/** What the reader says when a book won't open: a plain sentence, and the raw error behind a "Details" toggle. */
export interface OpenError {
  message: string;
  detail: string;
}

export const OPEN_ERROR_MESSAGES = {
  invalid: "This file isn't a readable PDF.",
  password: "This PDF is password-protected; Margin can't open protected PDFs yet.",
  missing: "The file couldn't be found.",
  other: "Margin couldn't read this PDF; it may be damaged.",
} as const;

/** How a missing file reads in an OS or Rust error: ENOENT (Node), `os error 2` (Rust io), "No such file or directory". */
const MISSING_FILE = /ENOENT|os error 2\b|No such file/i;

/** pdf.js exceptions carry their kind in `name` (they cross the worker boundary as plain objects too). */
function errorName(e: unknown): string {
  if (e && typeof e === 'object' && typeof (e as { name?: unknown }).name === 'string') return (e as { name: string }).name;
  return '';
}

/** The technical message as the error gives it: `Name: message`, or the error turned into text. */
function rawMessage(e: unknown, name: string): string {
  if (e instanceof Error) return String(e);
  const message = e && typeof e === 'object' ? (e as { message?: unknown }).message : undefined;
  if (typeof message === 'string') return name ? `${name}: ${message}` : message;
  return String(e);
}

/**
 * pdf.js errors in plain language. pdf.js 5 reports a missing file as a ResponseException with
 * `missing: true` (older versions: MissingPDFException). A backend error that names a missing file
 * (`not found: …`, ENOENT, `os error 2`, "No such file") is "missing" too.
 */
export function describeOpenError(e: unknown): OpenError {
  const name = errorName(e);
  const detail = rawMessage(e, name);
  if (name === 'InvalidPDFException') return { message: OPEN_ERROR_MESSAGES.invalid, detail };
  if (name === 'PasswordException') return { message: OPEN_ERROR_MESSAGES.password, detail };
  if (name === 'MissingPDFException' || (name === 'ResponseException' && (e as { missing?: unknown }).missing === true)) {
    return { message: OPEN_ERROR_MESSAGES.missing, detail };
  }
  // The backend's own words: the store's `not found: …`, or the OS saying the file is gone.
  const text = e instanceof Error ? e.message : String(e);
  if (String(e).startsWith('not found') || text.startsWith('not found') || MISSING_FILE.test(detail)) return { message: OPEN_ERROR_MESSAGES.missing, detail };
  return { message: OPEN_ERROR_MESSAGES.other, detail };
}
