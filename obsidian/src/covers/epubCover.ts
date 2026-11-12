import { openEpub } from '../../../src/renderers/epub/epubPackage';
import { dims, MAX_COVER_PIXELS, sniff } from '../../../src/renderers/epub/imageInfo';
import { COVER_MAX_HEIGHT, COVER_TYPE } from './thumbnail';

export { dims, MAX_COVER_PIXELS } from '../../../src/renderers/epub/imageInfo';

/** `PK\x03\x04`: how an EPUB (a zip) is told from a PDF. */
export function isZip(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 4) return false;
  const b = new Uint8Array(bytes, 0, 4);
  return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/** The raster types a cover may be. SVG (script, external references) is never decoded. */
const RASTER = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * The cover image of an EPUB, drawn offscreen at COVER_WIDTH and encoded as WebP (the contract of
 * `renderFirstPage`): its bytes, or null when the book has no cover, the cover is not a JPEG, PNG, GIF or
 * WebP (both its manifest type and its bytes), or it can't be decoded or encoded (the shelf then shows the
 * colour tile). Never throws. The EPUB is untrusted: `openEpub`'s size limits apply.
 */
export async function epubCoverWebp(bytes: ArrayBuffer, opts: { width: number; quality: number }): Promise<ArrayBuffer | null> {
  let bitmap: ImageBitmap | null = null;
  let canvas: HTMLCanvasElement | null = null;
  try {
    const pkg = openEpub(bytes);
    const href = pkg.coverHref;
    if (!href) return null;
    if (!RASTER.has(pkg.mediaType(href) ?? '')) return null;
    const data = pkg.bytes(href);
    if (!data) return null;
    const type = sniff(data);
    if (!type) return null;
    // Before the decoder sees it: a few header bytes can declare gigapixels.
    const size = dims(data, type);
    if (!size || size.w * size.h > MAX_COVER_PIXELS) return null;
    bitmap = await createImageBitmap(new Blob([data as BlobPart], { type }));
    if (!(bitmap.width > 0) || !(bitmap.height > 0)) return null;
    const scale = Math.min(opts.width / bitmap.width, COVER_MAX_HEIGHT / bitmap.height);
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // A cover with transparency reads on paper, as a page does.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await toBlob(canvas, COVER_TYPE, opts.quality);
    if (!blob || blob.type !== COVER_TYPE) return null;
    return await blob.arrayBuffer();
  } catch {
    return null;
  } finally {
    bitmap?.close?.();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
