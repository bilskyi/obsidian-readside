import type { OutlineEntry } from '../../lib/types';

/** The part of PDFDocumentProxy that outline resolution uses (a fake in tests). */
export interface OutlineDoc {
  numPages: number;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: { num: number; gen: number }): Promise<number>;
}

/** A pdf.js `getOutline()` node, reduced to what we read. */
export interface RawOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: RawOutlineNode[];
}

const isRef = (v: unknown): v is { num: number; gen: number } =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as { num?: unknown }).num === 'number' &&
  typeof (v as { gen?: unknown }).gen === 'number';

/** Most destination lookups in flight at once while resolving an outline (big books have thousands of entries). */
export const OUTLINE_CONCURRENCY = 8;

/** Runs at most `n` tasks at once, the rest in submission order. */
function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= n) return;
    const start = queue.shift();
    if (start) {
      active++;
      start();
    }
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}

/** Per-outline lookup state: page indexes cached per ref (`num:gen`), shared by every entry. */
interface Resolver {
  doc: OutlineDoc;
  pageIndex: Map<string, Promise<number>>;
}

function pageIndexOf(r: Resolver, ref: { num: number; gen: number }): Promise<number> {
  const key = `${ref.num}:${ref.gen}`;
  let p = r.pageIndex.get(key);
  if (!p) {
    p = r.doc.getPageIndex(ref);
    r.pageIndex.set(key, p);
  }
  return p;
}

async function destPage(r: Resolver, dest: RawOutlineNode['dest']): Promise<number | null> {
  try {
    const explicit = typeof dest === 'string' ? await r.doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const target: unknown = explicit[0];
    // Usually a page reference; some writers put a 0-based page index there instead.
    const index = isRef(target) ? await pageIndexOf(r, target) : Number.isInteger(target) ? (target as number) : null;
    if (index === null || index < 0 || index >= r.doc.numPages) return null;
    return index + 1;
  } catch {
    return null;
  }
}

/** 1-based page of an outline destination (named or explicit), or null when it can't be resolved. */
export function resolveDestPage(doc: OutlineDoc, dest: RawOutlineNode['dest']): Promise<number | null> {
  return destPage({ doc, pageIndex: new Map() }, dest);
}

/** True when some node in the tree has a title that is more than whitespace. */
const anyTitled = (nodes: readonly RawOutlineNode[] | null | undefined): boolean =>
  (nodes ?? []).some((n) => !!n.title?.trim() || anyTitled(n.items));

/**
 * pdf.js outline → OutlineEntry tree in document order (titles trimmed; unresolvable destinations get
 * page null). An outline in which no entry has a title (a lone empty node, say) is no table of contents:
 * []. Otherwise an untitled entry among titled ones is shown as "Untitled". At most OUTLINE_CONCURRENCY destinations resolve at once; each ref is looked up once.
 */
export async function normalizeOutline(
  doc: OutlineDoc,
  raw: readonly RawOutlineNode[] | null | undefined,
): Promise<OutlineEntry[]> {
  if (!anyTitled(raw)) return [];
  const r: Resolver = { doc, pageIndex: new Map() };
  const limit = limiter(OUTLINE_CONCURRENCY);
  // Only the lookup holds a slot; children are resolved outside it, so a parent never waits on a slot
  // its own children need.
  const walk = (nodes: readonly RawOutlineNode[] | null | undefined): Promise<OutlineEntry[]> =>
    Promise.all(
      (nodes ?? []).map(async (n) => {
        const [page, children] = await Promise.all([limit(() => destPage(r, n.dest)), walk(n.items)]);
        return { title: n.title?.trim() || 'Untitled', page, children };
      }),
    );
  return walk(raw);
}
