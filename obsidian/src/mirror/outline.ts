import { epubLocation } from '../../../src/lib/location';
import type { Format, OutlineEntry } from '../../../src/lib/types';
import { openEpub, type EpubPackage, type EpubTocEntry } from '../../../src/renderers/epub/epubPackage';
import { sanitizeSection } from '../../../src/renderers/epub/sanitize';
import { pointToOffset } from '../../../src/renderers/pdf/textOffsets';
import { normalizeOutline, type OutlineDoc, type RawOutlineNode } from '../../../src/renderers/pdf/pdfOutline';
import { pdfjsDocOptions, type PdfjsLib } from '../../../src/renderers/pdf/pdfjsProvider';

/**
 * An EPUB's outline, as the reader builds it (EpubRenderer.getOutline): its TOC, each entry at its section,
 * and an entry that names a fragment also at that element's text offset (`at`), so two entries in one
 * section split it. Only sections a fragment entry points into are sanitised; no pdf.js, no rendering.
 */
export function epubOutline(pkg: EpubPackage, doc: Document = document): OutlineEntry[] {
  const roots = new Map<number, HTMLElement | null>();
  const rootOf = (section: number): HTMLElement | null => {
    if (!roots.has(section)) {
      const s = pkg.sections[section - 1];
      let root: HTMLElement | null = null;
      try {
        root = s ? sanitizeSection(pkg.text(s.href) ?? '', { section, path: s.href, pkg, doc }).root : null;
      } catch {
        root = null;
      }
      roots.set(section, root);
    }
    return roots.get(section) ?? null;
  };
  const offsetOf = (section: number, fragment: string): number | null => {
    const root = rootOf(section);
    if (!root) return null;
    const id = `e${section}-${fragment}`;
    const el = Array.from(root.querySelectorAll<HTMLElement>('[id]')).find((c) => c.id === id);
    return el ? pointToOffset(root, el, 0) : null;
  };
  const entry = (e: EpubTocEntry): OutlineEntry => {
    const out: OutlineEntry = { title: e.title, page: e.section, children: e.children.map(entry) };
    if (e.section !== null && e.fragment) {
      const offset = offsetOf(e.section, e.fragment);
      if (offset !== null) out.at = epubLocation({ section: e.section, start: offset, end: offset });
    }
    return out;
  };
  return pkg.toc.map(entry);
}

/**
 * Each book's outline (the mirror's sections), read once per session: a PDF's with the host's pdf.js, an
 * EPUB's from its TOC; [] if unreadable.
 */
export class OutlineCache {
  private readonly readBytes: (path: string) => Promise<ArrayBuffer>;
  private readonly lib: () => PdfjsLib;
  private cache = new Map<string, { version: string | undefined; outline: Promise<OutlineEntry[]> }>();

  constructor(readBytes: (path: string) => Promise<ArrayBuffer>, lib: () => PdfjsLib) {
    this.readBytes = readBytes;
    this.lib = lib;
  }

  /**
   * `version` (the book's content hash): a different one reads the outline again. A failure is not kept.
   * `format`: an EPUB's outline is its TOC (no pdf.js); a PDF's (the default) comes from pdf.js.
   */
  get(bookId: string, path: string, version?: string, format: Format = 'pdf'): Promise<OutlineEntry[]> {
    const hit = this.cache.get(bookId);
    if (hit && hit.version === version) return hit.outline;
    const entry = { version, outline: Promise.resolve<OutlineEntry[]>([]) };
    const load = format === 'epub' ? this.loadEpub(path) : this.load(path);
    entry.outline = load.catch((e: unknown) => {
      // Not cached: a transient failure (pdf.js not ready, a read error) is tried again next time.
      if (this.cache.get(bookId) === entry) this.cache.delete(bookId);
      console.warn(`margin: no outline for ${path}`, e);
      return [];
    });
    this.cache.set(bookId, entry);
    return entry.outline;
  }

  forget(bookId: string): void {
    this.cache.delete(bookId);
  }

  clear(): void {
    this.cache.clear();
  }

  private async loadEpub(path: string): Promise<OutlineEntry[]> {
    return epubOutline(openEpub(await this.readBytes(path)));
  }

  private async load(path: string): Promise<OutlineEntry[]> {
    const data = new Uint8Array(await this.readBytes(path));
    const doc = await this.lib().getDocument({ ...pdfjsDocOptions(), data }).promise;
    try {
      const raw = (await doc.getOutline()) as unknown as RawOutlineNode[] | null;
      return await normalizeOutline(doc as unknown as OutlineDoc, raw);
    } finally {
      void doc.destroy();
    }
  }
}
