/**
 * What an image entry's own bytes say it is, read before any decoder sees them (EPUB images are untrusted:
 * a few header bytes can declare gigapixels). Shared by the reader (`EpubRenderer.loadImages`) and the
 * plugin's cover thumbnails.
 */

/** The type the bytes themselves say they are (the manifest's claim is not trusted), or null. */
export function sniff(b: Uint8Array): string | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

/** The most pixels a cover may declare (a 40000 x 40000 header in a few bytes must never reach the decoder). */
export const MAX_COVER_PIXELS = 40_000_000;

/** Width and height declared in the image's own header, or null when they can't be read. */
export function dims(b: Uint8Array, type: string): { w: number; h: number } | null {
  const be32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const be16 = (i: number) => (b[i] << 8) | b[i + 1];
  const le16 = (i: number) => b[i] | (b[i + 1] << 8);
  const le24 = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const tag = (i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  let w = 0;
  let h = 0;
  if (type === 'image/png') {
    if (b.length < 24) return null;
    w = be32(16);
    h = be32(20);
  } else if (type === 'image/gif') {
    if (b.length < 10) return null;
    w = le16(6);
    h = le16(8);
  } else if (type === 'image/jpeg') {
    let i = 2;
    for (let n = 0; n < 1024 && i + 4 <= b.length; n++) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) {
        i++; // fill byte
        continue;
      }
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
        i += 2;
        continue;
      }
      if (m === 0xd9 || m === 0xda) return null; // image data before any frame header
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        if (i + 9 > b.length) return null;
        h = be16(i + 5);
        w = be16(i + 7);
        break;
      }
      i += 2 + be16(i + 2);
    }
  } else if (type === 'image/webp') {
    if (b.length < 25) return null;
    const kind = tag(12);
    if (kind === 'VP8X' && b.length >= 30) {
      w = le24(24) + 1;
      h = le24(27) + 1;
    } else if (kind === 'VP8L') {
      if (b[20] !== 0x2f) return null;
      w = 1 + (b[21] | ((b[22] & 0x3f) << 8));
      h = 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10));
    } else if (kind === 'VP8 ' && b.length >= 30) {
      w = le16(26) & 0x3fff;
      h = le16(28) & 0x3fff;
    } else return null;
  }
  return w > 0 && h > 0 ? { w, h } : null;
}

/** The most pixels a reader image may declare: the same cap as a cover. */
export const MAX_IMAGE_PIXELS = MAX_COVER_PIXELS;

/** Largest SVG entry shown (an SVG is parsed and laid out as a document, not decoded by size). */
export const MAX_SVG_BYTES = 2 * 1024 * 1024;

/**
 * Whether the reader may hand these bytes to the browser as an image of manifest type `type`: an SVG up to
 * MAX_SVG_BYTES; a raster image only when its header sniffs as JPEG, PNG, GIF or WebP and declares at most
 * MAX_IMAGE_PIXELS (unreadable dimensions are refused).
 */
export function imageAllowed(bytes: Uint8Array, type: string): boolean {
  if (type.startsWith('image/svg')) return bytes.length <= MAX_SVG_BYTES;
  const real = sniff(bytes);
  const size = real ? dims(bytes, real) : null;
  return size !== null && size.w * size.h <= MAX_IMAGE_PIXELS;
}
