/** Lowercase hex SHA-256 (crypto.subtle). The input is copied, so typed arrays from any realm work. */
export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const view = typeof data === 'string' ? new TextEncoder().encode(data) : ArrayBuffer.isView(data) ? (data as Uint8Array) : new Uint8Array(data);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const FINGERPRINT_BYTES = 256 * 1024;

/** `<byteLength>:<sha256 of the first 256 KiB>`: cheap for big books, enough to recognise a moved file. */
export async function fingerprint(bytes: ArrayBuffer): Promise<string> {
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, FINGERPRINT_BYTES));
  return `${bytes.byteLength}:${await sha256Hex(head)}`;
}
