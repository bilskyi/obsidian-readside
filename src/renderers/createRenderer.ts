import type { Format } from '../lib/types';
import { EpubRenderer } from './epub/EpubRenderer';
import { PdfRenderer } from './pdf/PdfRenderer';
import type { RendererAdapter } from './types';

/** The renderer for a book's format, built into `host`: PDF and EPUB; null for formats the reader can't render. */
export function createRenderer(format: Format, host: HTMLElement): RendererAdapter | null {
  if (format === 'pdf') return new PdfRenderer(host);
  if (format === 'epub') return new EpubRenderer(host);
  return null;
}
