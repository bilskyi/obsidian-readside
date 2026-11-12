import type { PdfDocOptions, PdfjsLib } from '../../../src/renderers/pdf/pdfjsProvider';

/** How wide the first-page thumbnail is drawn (CSS px of the shelf's cover, about twice over). */
export const COVER_WIDTH = 320;
/** The tallest a thumbnail gets: a very long first page is drawn smaller rather than as a strip. */
export const COVER_MAX_HEIGHT = 640;
export const COVER_QUALITY = 0.8;
export const COVER_TYPE = 'image/webp';

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * Page 1 of a PDF, drawn offscreen at COVER_WIDTH and encoded as WebP: its bytes, or null when the page
 * can't be drawn or encoded (the shelf then shows the colour tile). The pdf.js document is destroyed and the
 * canvas emptied before it returns, whatever happened.
 */
export async function renderFirstPage(lib: PdfjsLib, options: PdfDocOptions, bytes: ArrayBuffer): Promise<ArrayBuffer | null> {
  const task = lib.getDocument({ ...options, data: new Uint8Array(bytes) });
  let canvas: HTMLCanvasElement | null = null;
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    try {
      const natural = page.getViewport({ scale: 1 });
      if (!(natural.width > 0) || !(natural.height > 0)) return null;
      const scale = Math.min(COVER_WIDTH / natural.width, COVER_MAX_HEIGHT / natural.height);
      const viewport = page.getViewport({ scale });
      canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      // Paper, not transparency: a page with no background of its own reads as a white sheet.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      const blob = await toBlob(canvas, COVER_TYPE, COVER_QUALITY);
      // A browser without a WebP encoder hands back PNG: not what covers/<id>.webp promises.
      if (!blob || blob.type !== COVER_TYPE) return null;
      return await blob.arrayBuffer();
    } finally {
      page.cleanup();
    }
  } catch {
    return null;
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    await task.destroy().catch(() => {});
  }
}
