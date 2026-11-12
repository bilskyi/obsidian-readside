/**
 * The pdf.js library the renderer uses, installed by the host: desktop installs `pdfjs-dist` with its
 * worker (main.tsx); the Obsidian plugin installs the library Obsidian's loadPdfJs() returns (pdf.js
 * 5.3 in Obsidian 1.12). The renderer only uses API present in both: getDocument, TextLayer,
 * RenderingCancelledException and the outline/destination calls.
 */
export type PdfjsLib = typeof import('pdfjs-dist');

/** Extra getDocument options the host needs (asset URLs, eval policy). Desktop passes none. */
export type PdfDocOptions = Record<string, unknown>;

let lib: PdfjsLib | null = null;
let docOptions: PdfDocOptions = {};

export function setPdfjs(next: PdfjsLib | null, options: PdfDocOptions = {}): void {
  lib = next;
  docOptions = next ? { ...options } : {};
}

export function pdfjsDocOptions(): PdfDocOptions {
  return docOptions;
}

export function pdfjs(): PdfjsLib {
  if (!lib) throw new Error('pdf.js is not installed: call setPdfjs() first');
  return lib;
}
