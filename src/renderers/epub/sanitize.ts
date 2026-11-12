import { EPUB_TEXT_MODEL } from '../../lib/location';
import type { BookBudget } from './budget';
import { parseXhtml, type EpubPackage } from './epubPackage';

/**
 * Section XHTML → a fresh, inert DOM tree built from an allowlist (spec §B5).
 *
 * Book content is untrusted. The parsed document is never adopted or serialised into the page: every
 * output node is created here with `createElement`/`createTextNode`, only allowlisted elements and
 * attributes are copied, and every URL is rewritten or removed. Images get no `src` here; the
 * renderer sets a `blob:` URL from the zip entry listed in `images`. Stylesheets are returned as
 * zip paths / text for `scopeCss`, never placed in the DOM.
 */

export interface SanitizeContext {
  section: number;
  path: string;
  pkg: Pick<EpubPackage, 'resolve' | 'sectionOf' | 'mediaType'>;
  /** The reader's document (nodes are created here). */
  doc: Document;
  /** The book's shared work budget (spent here); unbounded beyond the per-section caps when absent. */
  budget?: BookBudget;
}

export interface SanitizedSection {
  /** `div.epub-section` */
  root: HTMLElement;
  images: { el: HTMLImageElement; path: string }[];
  /** Zip paths of `<link rel="stylesheet">` targets, in document order. */
  stylesheets: string[];
  /** Text of `<style>` elements, in document order. */
  inlineCss: string[];
  /** `stylesheets` and `inlineCss` interleaved in document order: the cascade order to inject them in. */
  sources: ({ link: string } | { inline: string })[];
  lang: string | null;
}

/**
 * The EPUB text model: stored locations hold a section number and offsets into `indexText` of this
 * output, stamped with this version (`EpubLocationValue.v`, `EPUB_TEXT_MODEL` in lib/location, which this
 * is). Bump it whenever the section list or the text for the same book can change. That covers:
 * - this file's output: the allowlists, attribute rewriting, class prefixing, `BLOCKS` (separateBlocks'
 *   line breaks), `MAX_DEPTH` and `MAX_NODES`;
 * - the spine rules in epubPackage.ts: duplicate files dropped (first occurrence kept) and the
 *   `MAX_SPINE` cap (section numbers);
 * - the per-book budget in budget.ts (where a large book's text stops).
 * A bump needs a migration of stored locations written under the older model: re-anchor ranges by their
 * quote, and snap points to the nearest block start.
 * 2: book classes are written `ec-<token>`; ordered `sources`.
 * 3: a `"\n"` text node at every block boundary that had no whitespace (separateBlocks). No EPUB
 *    annotations existed under 2, so none are migrated. The spine dedupe, its cap and the book budget
 *    arrived before any EPUB user data and are part of 3.
 */
export const SANITIZER_VERSION = EPUB_TEXT_MODEL;

/** Deeper content is dropped (the walk is recursive; hostile books nest thousands deep). */
export const MAX_DEPTH = 200;
/** Output nodes (elements + text) per section; the rest of the section is dropped. */
export const MAX_NODES = 100_000;

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const OPS_NS = 'http://www.idpf.org/2007/ops';

const ELEMENTS = new Set(
  (
    'p div span section article aside header footer nav main h1 h2 h3 h4 h5 h6 em strong i b u s small sub sup ' +
    'mark abbr cite q dfn code kbd samp var pre blockquote br hr wbr ul ol li dl dt dd figure figcaption table ' +
    'thead tbody tfoot tr th td caption colgroup col a img ruby rt rp bdi bdo time del ins'
  ).split(' '),
);

/** Dropped together with everything inside, in any namespace. `svg` is handled separately. */
const BLOCKED = new Set(
  (
    'script style noscript iframe frame frameset object embed applet video audio source track canvas form ' +
    'input button select textarea option optgroup link meta base template math svg head title portal ' +
    'dialog slot foreignobject param picture map area marquee'
  ).split(' '),
);

/** Output elements laid out as blocks: text either side of one is a separate run of text. */
const BLOCKS = new Set(
  (
    'p div section article aside header footer nav main h1 h2 h3 h4 h5 h6 pre blockquote hr ul ol li dl dt dd ' +
    'figure figcaption table thead tbody tfoot tr th td caption'
  ).split(' '),
);

/** Elements that never hold content: children (possible in XHTML) are not copied. */
const VOID = new Set(['br', 'hr', 'wbr', 'img', 'col']);

const LANG_RE = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/;
const INT_RE = /^-?\d{1,6}$/;

const isHtml = (el: Element) => el.namespaceURI === XHTML_NS || el.namespaceURI === null;

/** Browsers ignore ASCII whitespace and control characters inside URLs (`java\tscript:`). */
const squash = (s: string) => s.replace(/[\u0000-\u0020\u007f]+/g, '');

function plainAttr(el: Element, name: string): string | null {
  const a = el.attributes.getNamedItemNS(null, name);
  return a ? a.value : null;
}

/** A prefixed attribute: real namespace (XML parse) or literal `prefix:name` (HTML fallback parse). */
function nsAttr(el: Element, ns: string, local: string, prefix: string): string | null {
  return el.getAttributeNS(ns, local) ?? plainAttr(el, `${prefix}:${local}`);
}

function langOf(el: Element | null): string | null {
  if (!el) return null;
  const v = (nsAttr(el, XML_NS, 'lang', 'xml') ?? plainAttr(el, 'lang'))?.trim() ?? '';
  return LANG_RE.test(v) ? v : null;
}

/** Book class tokens, each prefixed `ec-` so a book can never wear a host class (`popover`, `modal-bg` …). */
const classTokens = (v: string | null) =>
  (v ?? '')
    .split(/\s+/)
    .filter((t) => /^-?[_a-zA-Z][\w-]{0,63}$/.test(t))
    .map((t) => `ec-${t}`)
    .join(' ');

export function sanitizeSection(xhtml: string, ctx: SanitizeContext): SanitizedSection {
  const { doc, section, path, pkg } = ctx;
  const root = doc.createElement('div');
  root.className = 'epub-section';
  const out: SanitizedSection = { root, images: [], stylesheets: [], inlineCss: [], sources: [], lang: null };

  const budget = ctx.budget;
  /** The book's budget ran out in (or before) this section: it shows only what fit, and says so. */
  const truncate = () => root.setAttribute('data-epub-truncated', '');
  if (budget && budget.nodes <= 0) {
    truncate();
    return out;
  }

  const parsed = parseXhtml(xhtml);
  if (!parsed || !parsed.documentElement) return out;

  const html = parsed.documentElement;
  const body =
    Array.from(html.children).find((c) => c.localName.toLowerCase() === 'body' && isHtml(c)) ??
    (parsed as Document).body ??
    null;
  const head = Array.from(html.children).find((c) => c.localName.toLowerCase() === 'head' && isHtml(c)) ?? null;

  out.lang = langOf(body) ?? langOf(html);
  if (out.lang) root.setAttribute('lang', out.lang);
  if (body) {
    const cls = classTokens(plainAttr(body, 'class'));
    if (cls) root.className = `epub-section ${cls}`;
    const dir = plainAttr(body, 'dir') ?? plainAttr(html, 'dir');
    if (dir && /^(ltr|rtl|auto)$/i.test(dir.trim())) root.setAttribute('dir', dir.trim().toLowerCase());
  }

  let nodes = 0;
  const seenIds = new Set<string>();
  /** Room for one more output node (per-section cap and the book's budget); spends it when there is. */
  const take = (): boolean => {
    if (nodes >= MAX_NODES) return false;
    if (budget) {
      if (budget.nodes <= 0) {
        truncate();
        return false;
      }
      budget.nodes--;
    }
    nodes++;
    return true;
  };

  const recordStyle = (el: Element): boolean => {
    if (!isHtml(el)) return false;
    const name = el.localName.toLowerCase();
    if (name === 'style') {
      const css = el.textContent ?? '';
      if (css.trim()) {
        out.inlineCss.push(css);
        out.sources.push({ inline: css });
      }
      return true;
    }
    if (name === 'link') {
      const rel = (plainAttr(el, 'rel') ?? '').toLowerCase().split(/\s+/);
      const href = plainAttr(el, 'href');
      if (rel.includes('stylesheet') && !rel.includes('alternate') && href) {
        const r = pkg.resolve(path, href);
        if (r && !out.stylesheets.includes(r.path)) {
          out.stylesheets.push(r.path);
          out.sources.push({ link: r.path });
        }
      }
      return true;
    }
    return false;
  };

  if (head) for (const el of Array.from(head.getElementsByTagNameNS('*', '*'))) recordStyle(el);

  const newId = (raw: string | null): string | null => {
    const v = raw?.trim();
    if (!v || /\s/.test(v) || v.length > 256) return null;
    const id = `e${section}-${v}`;
    if (seenIds.has(id)) return null;
    seenIds.add(id);
    return id;
  };

  const makeImg = (src: string | null, alt: string | null): HTMLImageElement => {
    const img = doc.createElement('img');
    if (alt !== null) img.setAttribute('alt', alt);
    if (src !== null) {
      const r = pkg.resolve(path, src);
      const type = r ? pkg.mediaType(r.path) : null;
      if (r && type && type.toLowerCase().startsWith('image/')) out.images.push({ el: img, path: r.path });
    }
    return img;
  };

  const setHref = (a: HTMLElement, raw: string) => {
    const squashed = squash(raw);
    if (!squashed) return;
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(squashed)?.[1]?.toLowerCase();
    if (scheme) {
      if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') return;
      let url: URL;
      try {
        url = new URL(squashed);
      } catch {
        return;
      }
      if (url.protocol !== `${scheme}:`) return;
      a.setAttribute('href', url.href);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      return;
    }
    const r = pkg.resolve(path, raw.trim());
    const target = r ? pkg.sectionOf(r.path) : null;
    if (r === null || target === null) return;
    const frag = r.fragment && !/\s/.test(r.fragment) ? `#e${target}-${r.fragment}` : '';
    a.setAttribute('data-epub-target', `${target}${frag}`);
  };

  const copyAttrs = (src: Element, dst: HTMLElement, name: string) => {
    const id = newId(plainAttr(src, 'id') ?? (name === 'a' ? plainAttr(src, 'name') : null));
    if (id) dst.setAttribute('id', id);
    const cls = classTokens(plainAttr(src, 'class'));
    if (cls) dst.setAttribute('class', cls);
    const lang = langOf(src);
    if (lang) dst.setAttribute('lang', lang);
    const dir = plainAttr(src, 'dir')?.trim().toLowerCase();
    if (dir === 'ltr' || dir === 'rtl' || dir === 'auto') dst.setAttribute('dir', dir);
    for (const k of ['title', 'datetime'] as const) {
      const v = plainAttr(src, k);
      if (v !== null) dst.setAttribute(k, v.slice(0, 1024));
    }
    for (const k of ['colspan', 'rowspan', 'start', 'value'] as const) {
      const v = plainAttr(src, k)?.trim();
      if (v && INT_RE.test(v)) dst.setAttribute(k, v);
    }
    if (plainAttr(src, 'reversed') !== null && name === 'ol') dst.setAttribute('reversed', '');
    const type = nsAttr(src, OPS_NS, 'type', 'epub');
    if (type) {
      const t = type.split(/\s+/).filter((x) => /^[\w:.-]{1,64}$/.test(x)).join(' ');
      if (t) dst.setAttribute('data-epub-type', t);
    }
  };

  /** `<svg>` holding an `<image>` (covers) → one `<img>`; anything else in the svg is discarded. */
  const fromSvg = (svg: Element): HTMLImageElement | null => {
    const image = Array.from(svg.getElementsByTagNameNS('*', 'image')).find(
      (e) => e.namespaceURI === SVG_NS || e.namespaceURI === null,
    );
    if (!image) return null;
    const href = nsAttr(image, XLINK_NS, 'href', 'xlink') ?? plainAttr(image, 'href');
    const title = Array.from(svg.children).find((c) => c.localName === 'title')?.textContent?.trim();
    return makeImg(href, title || '');
  };

  const walk = (src: Node, dst: Node, depth: number): void => {
    for (let child = src.firstChild; child; child = child.nextSibling) {
      if (nodes >= MAX_NODES || (budget && budget.nodes <= 0)) {
        if (budget && budget.nodes <= 0) truncate();
        return;
      }
      if (child.nodeType === 3 || child.nodeType === 4) {
        // Text and CDATA: copied as text, never parsed.
        if (!take()) return;
        dst.appendChild(doc.createTextNode((child as CharacterData).data));
        continue;
      }
      if (child.nodeType !== 1) continue; // comments, processing instructions, doctypes
      const el = child as Element;
      const name = el.localName.toLowerCase();
      if (recordStyle(el)) continue;
      if (name === 'svg' && el.namespaceURI === SVG_NS) {
        const img = fromSvg(el);
        if (img && take()) dst.appendChild(img);
        continue;
      }
      if (BLOCKED.has(name)) continue;
      if (el.namespaceURI === OPS_NS && name === 'case') continue; // epub:switch shows its default
      if (depth >= MAX_DEPTH) continue;
      if (!isHtml(el) || !ELEMENTS.has(name)) {
        // Unknown element: dropped, its content kept.
        walk(el, dst, depth + 1);
        continue;
      }
      if (!take()) return;
      const node =
        name === 'img' ? makeImg(plainAttr(el, 'src'), plainAttr(el, 'alt')) : doc.createElement(name);
      copyAttrs(el, node, name);
      if (name === 'a') {
        const href = plainAttr(el, 'href');
        if (href !== null) setHref(node, href);
      }
      dst.appendChild(node);
      if (!VOID.has(name)) walk(el, node, depth + 1);
    }
  };

  if (body) walk(body, root, 0);
  separateBlocks(doc, root);
  return out;
}

const endsBlank = (n: Node) => (n.nodeType === 3 ? /\s$/.test((n as Text).data) : n.nodeName === 'BR');
const startsBlank = (n: Node) => (n.nodeType === 3 ? /^\s/.test((n as Text).data) : n.nodeName === 'BR');

/**
 * `<p>end.</p><p>Next</p>` is two runs of text, but its text nodes read "end.Next": search, quotes and the
 * whitespace-insensitive matching would join words across paragraphs, cells and list items. A `"\n"` text
 * node goes on each side of a block element that has content there without whitespace (or a `<br/>`)
 * between. Between blocks it is collapsible whitespace and lays out as nothing. Not inside `<pre>`,
 * where it would show.
 */
function separateBlocks(doc: Document, root: HTMLElement): void {
  const stack: Element[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    if (el.localName === 'pre') continue;
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      const child = c as Element;
      stack.push(child);
      if (!BLOCKS.has(child.localName)) continue;
      const prev = child.previousSibling;
      if (prev && !endsBlank(prev)) el.insertBefore(doc.createTextNode('\n'), child);
      const next = child.nextSibling;
      if (next && !startsBlank(next)) el.insertBefore(doc.createTextNode('\n'), next);
    }
  }
}
