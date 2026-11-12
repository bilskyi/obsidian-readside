/**
 * Book CSS → CSS that is safe to inject next to Obsidian's (spec §B5).
 *
 * The browser's own CSS parser reads the book CSS into a detached, constructed `CSSStyleSheet`
 * (`replaceSync`; constructed sheets never fetch `@import` or anything else). The output is then
 * written from scratch from the allowlisted parts only: every selector is prefixed with the book
 * scope, declarations are filtered by name and value, `@font-face` families are renamed per book and
 * their `src` points only at `blob:` URLs created from zip fonts. Nothing else survives.
 *
 * Every selector lands inside `<scope> .epub-section`, and book class names are rewritten `.ec-<name>`
 * to match the sanitiser's `class="ec-<name>"`, so book rules never reach Margin's or Obsidian's UI and
 * host rules never match book elements by class.
 *
 * For E4: host CSS can still style the section's *container*; the renderer must give `.epub-section`
 * `contain: layout paint; isolation: isolate; position: relative` so nothing inside it (a float, a huge
 * box, a stacking context) paints or positions outside the column.
 *
 * All work is bounded per call: each zip stylesheet is inlined at most once, imported text, examined
 * rules, leading `@import`s and group nesting all have caps (see the constants below).
 */

import { ZOOM_MAX } from '../pdf/zoom';
import type { BookBudget } from './budget';

export interface ScopeCssContext {
  /** e.g. `.margin-epub[data-book="3"]` (trusted, from the renderer). */
  scope: string;
  /** 8 chars; fonts are renamed `margin-epub-<bookKey>-<family>`. */
  bookKey: string;
  /** Zip path → `blob:` URL for a usable font; null when absent, not a font or obfuscated. */
  fontUrl: (path: string) => string | null;
  /**
   * `href` as written in the stylesheet at zip path `fromPath` → its zip entry, or null (remote,
   * escaping, absent). Same contract as `EpubPackage.resolve`, so `pkg.resolve` can be passed as is.
   */
  resolve: (fromPath: string, href: string) => { path: string } | null;
  /** Text of a zip CSS file, or null. */
  readCss: (path: string) => string | null;
  /**
   * familyKey → renamed family, shared by every `scopeCss` call for one book so a face declared in
   * `fonts.css` renames the uses in `style.css`. Scope the sheets in document order (a use is renamed
   * only if its face was seen in this or an earlier call). Per call when absent.
   */
  families?: Map<string, string>;
  /**
   * The book's shared work budget (`cssRules`, `cssChars` are spent here, across calls); once spent, later
   * sheets come out empty. Only the per-call caps apply when absent.
   */
  budget?: BookBudget;
}

/** `@import` nesting limit (the top stylesheet is depth 0). */
export const MAX_IMPORT_DEPTH = 4;
/** Larger stylesheets are ignored. */
export const MAX_CSS_CHARS = 2 * 1024 * 1024;
/** Total characters of `@import`ed text read per `scopeCss` call. */
export const MAX_IMPORTED_CHARS = 4 * 1024 * 1024;
/** Rules examined (and so emitted) per `scopeCss` call; the rest is dropped. */
export const MAX_RULES = 50_000;
/** Leading `@import` statements honoured per sheet. */
export const MAX_IMPORTS_PER_SHEET = 64;
/** `@media`/`@supports` nesting kept; deeper groups are dropped. */
export const MAX_GROUP_DEPTH = 16;
/** A declaration whose length could exceed this many px is dropped. */
export const MAX_LENGTH_PX = 10_000;

const RULE_STYLE = 1;
const RULE_MEDIA = 4;
const RULE_FONT_FACE = 5;
const RULE_SUPPORTS = 12;

type Decl = [name: string, value: string];
type Node =
  | { kind: 'style'; selectors: string[]; decls: Decl[] }
  | { kind: 'group'; at: 'media' | 'supports'; cond: string; children: Node[] }
  | { kind: 'face'; family: string; src: string; descs: Decl[] };

const DISPLAY = new Set([
  'block', 'inline', 'inline-block', 'list-item', 'none', 'table', 'inline-table', 'table-row',
  'table-cell', 'table-row-group', 'table-header-group', 'table-footer-group', 'table-column',
  'table-column-group', 'table-caption',
]);

const EXACT = new Set([
  'text-align', 'text-align-all', 'text-align-last', 'text-indent', 'text-transform', 'letter-spacing', 'word-spacing',
  'line-height', 'white-space', 'white-space-collapse', 'text-wrap', 'text-wrap-mode', 'hyphens',
  '-webkit-hyphens', 'text-decoration-line', 'text-decoration-style', 'text-decoration-thickness',
  'text-decoration-skip-ink', 'text-underline-offset', 'text-underline-position', 'width', 'max-width',
  'height', 'max-height', 'display', 'float', 'clear', 'vertical-align', 'baseline-shift',
  'alignment-baseline', 'baseline-source', 'white-space-trim', 'text-wrap-style', 'list-style-type',
  'list-style-position', 'list-style-image', 'border-collapse', 'border-spacing', 'caption-side',
  'table-layout', 'direction', 'unicode-bidi', 'writing-mode',
]);

/** Values may call only these functions (no `url()`, `expression()`, `var()`, `image-set()`, `attr()` …). */
const FUNCTIONS = new Set(['calc', 'min', 'max', 'clamp']);

/** Publisher colours are dropped by default: the column uses the reader theme. */
function allowedProperty(name: string): boolean {
  if (!/^-?[a-z]+(?:-[a-z]+)*$/.test(name)) return false;
  if (name === 'color' || name.endsWith('-color')) return false;
  if (EXACT.has(name)) return true;
  if (name.startsWith('font-')) return true;
  if (name.startsWith('margin-') || name.startsWith('padding-')) return true;
  if (name.startsWith('border-')) return !name.startsWith('border-image');
  return false;
}

function safeValue(value: string): boolean {
  if (!value || value.length > 1000) return false;
  if (/[{};<>\\@!]|\/\*/.test(value)) return false;
  // Every "(" opens an allowed function, or nests inside one (`calc((1px + 2px) * 2)`).
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === ')') depth = Math.max(0, depth - 1);
    if (c !== '(') continue;
    const name = /[\w-]*$/.exec(value.slice(0, i))![0].toLowerCase();
    if (name ? !FUNCTIONS.has(name) : depth === 0) return false;
    depth++;
  }
  return true;
}

/** Approximate px per unit; font- and viewport-relative units are taken at a generous 16px / 20px. */
const PX_PER: Record<string, number> = {
  px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6,
  // rem is the column's base font, 18 px at 100 % (as zoomedLengths rewrites it).
  em: 16, rem: 18, ex: 16, rex: 16, ch: 16, rch: 16, ic: 16, ric: 16, cap: 16, rcap: 16, lh: 16, rlh: 16,
};

/**
 * A value whose length could exceed `MAX_LENGTH_PX` (`width:1e9px`, `font-size:99999pt`,
 * `calc(100px*100*100)`); `font-size`/`line-height` as drawn at ZOOM_MAX. Percentages are bounded by the
 * container and pass. The CSS parser usually simplifies numeric `calc()` first; the `*`/`/` rules cover
 * one that does not.
 */
export function hugeLength(name: string, value: string): boolean {
  if (name === 'font-family') return false; // names, not lengths
  if (value.includes('/')) return true; // division only appears in calc() here: `calc(1px / 0.00001)`
  const stars = (value.match(/\*/g) ?? []).length;
  if (stars > 1) return true;
  let maxPx = 0;
  let maxFactor = 1;
  for (const m of value.matchAll(/(?<![\w.])([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]*|%)/gi)) {
    const n = Math.abs(Number(m[1]));
    if (!Number.isFinite(n)) return true;
    const unit = m[2].toLowerCase();
    if (unit === '%') continue;
    if (unit === '') {
      // Unitless: a factor in calc(), a line-height multiple, a font-weight …
      if (stars) maxFactor = Math.max(maxFactor, n);
      else maxPx = Math.max(maxPx, name === 'line-height' ? n * 16 : n);
      continue;
    }
    const per = PX_PER[unit] ?? (/^[sld]?v(?:w|h|i|b|min|max)$|^cq/.test(unit) ? 20 : 1);
    maxPx = Math.max(maxPx, n * per);
  }
  // A text size is drawn at the zoom (zoomedLengths, the scaled base font): checked at the largest one.
  const zoom = ZOOMED.has(name) ? ZOOM_MAX / 100 : 1;
  return maxPx * maxFactor * zoom > MAX_LENGTH_PX;
}

function allowedValue(name: string, value: string): boolean {
  if (!safeValue(value)) return false;
  if (hugeLength(name, value)) return false;
  const v = value.trim().toLowerCase();
  if (name === 'display') return DISPLAY.has(v);
  if (name === 'writing-mode') return v === 'horizontal-tb';
  if (name === 'list-style-image') return v === 'none';
  return true;
}

/**
 * Text sizes follow the reader's zoom. The renderer scales the column's base font (and its width), so
 * relative sizes (`em`, `%`, unitless line heights) follow it already; an absolute size (`12pt`, `14px`,
 * `1.2rem`) would not, and at 200 % the book's small print would stay small (and an absolute line height
 * would overlap its scaled text). Those are written as `calc(<px> * var(--epub-scale))`, `--epub-scale`
 * being the zoom the renderer sets on the book scope; `rem` counts the column's base font (18 px at
 * 100 %), the size a book means by "the reader's default".
 *
 * Chosen over CSS `zoom` on the page box: `zoom` changes what `getBoundingClientRect`/`offset*` report
 * inside the box, differently in Chromium (standardised zoom, 128+) and WebKit (Tauri), and every rect
 * the renderer reads (selection, highlights, lines, anchors) would need correcting per engine. Other
 * absolute lengths (widths, margins, borders) keep their size, as they do in a reflowable reader that
 * scales only the text.
 */
const ZOOMED = new Set(['font-size', 'line-height']);
const ABSOLUTE_PX: Record<string, number> = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, rem: 18 };

export function zoomedLengths(value: string): string {
  return value.replace(/(?<![\w.#-])([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|pt|pc|in|cm|mm|q|rem)(?![\w%-])/gi, (m, num: string, unit: string) => {
    const px = Number(num) * ABSOLUTE_PX[unit.toLowerCase()];
    if (!Number.isFinite(px) || px === 0) return m;
    return `calc(${Math.round(px * 1e4) / 1e4}px * var(--epub-scale))`;
  });
}

// ---------------------------------------------------------------- lexical helpers

/** Splits at top-level commas (outside parens, brackets and strings). */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** A family name without quotes, whitespace collapsed, lowercased: the matching key. */
const familyName = (raw: string) =>
  raw
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')
    .replace(/\s+/g, ' ');
const familyKey = (raw: string) => familyName(raw).toLowerCase();

/** Generic families (and CSS-wide keywords) are never renamed, nor declared by a book face. */
const GENERIC = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'emoji', 'math', 'fangsong',
  'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'default',
]);
const isGeneric = (key: string) => GENERIC.has(key) || key.startsWith('ui-');

const quote = (s: string) => `"${s.replace(/["\\]/g, '')}"`;

/** Leading `@charset`, `@import` and `@layer` statements. Constructed sheets ignore `@import`, so it is read here. */
function leadingImports(css: string): { href: string; media: string }[] {
  const out: { href: string; media: string }[] = [];
  let i = 0;
  const skipSpace = () => {
    for (;;) {
      while (i < css.length && /\s/.test(css[i])) i++;
      if (css.startsWith('/*', i)) {
        const end = css.indexOf('*/', i + 2);
        i = end < 0 ? css.length : end + 2;
      } else if (css.startsWith('<!--', i)) i += 4;
      else if (css.startsWith('-->', i)) i += 3;
      else return;
    }
  };
  const readString = (): string | null => {
    const q = css[i];
    let s = '';
    for (i++; i < css.length; i++) {
      const c = css[i];
      if (c === q) {
        i++;
        return s;
      }
      if (c === '\\' || c === '\n') return null; // escapes in an import href are not worth decoding
      s += c;
    }
    return null;
  };
  /** Up to the terminating `;` (outside strings/parens); null on `{` or end. */
  const readToSemicolon = (): string | null => {
    let depth = 0;
    let q = '';
    const start = i;
    for (; i < css.length; i++) {
      const c = css[i];
      if (q) {
        if (c === q) q = '';
        continue;
      }
      if (c === '"' || c === "'") q = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === '{' || c === '}') return null;
      else if (c === ';' && depth <= 0) {
        const text = css.slice(start, i);
        i++;
        return text;
      }
    }
    return null;
  };
  for (;;) {
    if (out.length >= MAX_IMPORTS_PER_SHEET) return out;
    skipSpace();
    const at = /^@([a-z-]+)/i.exec(css.slice(i, i + 32));
    if (!at) return out;
    const kw = at[1].toLowerCase();
    if (kw === 'charset' || kw === 'layer') {
      if (readToSemicolon() === null) return out;
      continue;
    }
    if (kw !== 'import') return out;
    i += at[0].length;
    skipSpace();
    let href: string | null = null;
    if (css[i] === '"' || css[i] === "'") href = readString();
    else if (/^url\(/i.test(css.slice(i, i + 4))) {
      i += 4;
      skipSpace();
      if (css[i] === '"' || css[i] === "'") href = readString();
      else {
        const m = /^[^)\s"'\\]*/.exec(css.slice(i))!;
        href = m[0];
        i += m[0].length;
      }
      skipSpace();
      if (css[i] !== ')') href = null;
      else i++;
    }
    const rest = readToSemicolon();
    if (rest === null) return out;
    if (href !== null) out.push({ href, media: rest.trim() });
  }
}

/** `@media` is kept only for width-type queries on screen. */
export function allowedMedia(text: string): boolean {
  const queries = text.split(',').map((q) => q.trim().toLowerCase());
  if (queries.length === 0 || queries.some((q) => q === '')) return false;
  return queries.every((q) => {
    const parts = q.replace(/^only\s+/, '').split(/\s+and\s+/);
    if (parts[0] === 'all' || parts[0] === 'screen') parts.shift();
    return parts.every((p) => {
      const m = /^\((.*)\)$/.exec(p.trim());
      if (!m) return false;
      const inner = m[1].trim();
      const colon = /^((?:min-|max-)?(?:width|height|aspect-ratio)|orientation)\s*:\s*([\w.%/ -]+)$/.exec(inner);
      if (colon) return true;
      return /^[\w.%\s<>=]+$/.test(inner) && /[<>]/.test(inner) && /\b(width|height)\b/.test(inner);
    });
  });
}

/**
 * `.name` → `.ec-name` outside attribute brackets and strings (the sanitiser writes `class="ec-name"`).
 * Null when a `.` is not followed by a plain ASCII class name.
 */
function prefixClasses(sel: string): string | null {
  let out = '';
  let bracket = 0;
  let quote = '';
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[') bracket++;
    else if (c === ']') bracket = Math.max(0, bracket - 1);
    else if (c === '.' && bracket === 0) {
      const m = /^-?[_a-zA-Z][\w-]*/.exec(sel.slice(i + 1));
      if (!m) return null;
      out += `.ec-${m[0]}`;
      i += m[0].length;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * `html`, `body`, `:root` → the section root; everything else lands inside it
 * (`<scope> .epub-section <sel>`). Book classes become `.ec-<name>`.
 */
function scopeSelector(sel: string, scope: string): string | null {
  const trimmed = sel.trim();
  if (!trimmed || /[{};<@\\]|\/\*/.test(trimmed)) return null;
  // Matching on the raw class attribute would bypass the `ec-` prefix (and could match host markup).
  if (/\[\s*(?:[\w*-]*\|)?class(?![\w-])/i.test(trimmed)) return null;
  const s = prefixClasses(trimmed);
  if (s === null) return null;
  let rest = s;
  let mapped = false;
  const top = /^(?:html|:root)(?![\w-])/i;
  if (top.test(rest)) {
    rest = rest.replace(top, '');
    mapped = true;
    const toBody = /^\s*>?\s*(?=body(?![\w-]))/i.exec(rest);
    if (toBody) rest = rest.slice(toBody[0].length);
  }
  if (/^body(?![\w-])/i.test(rest)) {
    rest = rest.slice(4);
    mapped = true;
  }
  if (mapped) {
    // The section root's siblings are Margin's UI, not book content.
    if (/^\s*[+~]/.test(rest)) return null;
    return `${scope} .epub-section${rest}`;
  }
  if (/^\s*[>+~]/.test(rest)) return null;
  return `${scope} .epub-section ${s}`;
}

/** Padding on the inline sides of the section root: each value is capped at `MAX_ROOT_PADDING`. */
const SIDE_PADDING = new Set(['padding-left', 'padding-right', 'padding-inline', 'padding-inline-start', 'padding-inline-end']);
export const MAX_ROOT_PADDING = '25%';

/** A scoped selector that matches the section root itself (`body`, `body.x`, `html > body:first-child`). */
function targetsRoot(scoped: string, scope: string): boolean {
  const head = `${scope} .epub-section`;
  if (!scoped.startsWith(head)) return false;
  // A descendant, child or sibling combinator after the root means another element (attribute values
  // with spaces count too: a false positive only caps that rule's padding).
  return !/[\s>+~]/.test(scoped.slice(head.length));
}

/** `min(<v>, 25%)` per value (`padding-inline` may hold two); CSS-wide keywords stay as they are. */
function capPadding(value: string): string {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of value.trim()) {
    if (c === '(') depth++;
    if (c === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(c) && depth === 0) {
      if (cur) parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) parts.push(cur);
  return parts.map((p) => (/^[a-z-]+$/i.test(p) ? p : `min(${p}, ${MAX_ROOT_PADDING})`)).join(' ');
}

// ---------------------------------------------------------------- parsing

let warnedNoReplaceSync = false;

function parseSheet(css: string): CSSRuleList | null {
  if (typeof CSSStyleSheet !== 'function' || !('replaceSync' in CSSStyleSheet.prototype)) {
    if (!warnedNoReplaceSync) {
      warnedNoReplaceSync = true;
      console.warn('[margin] CSSStyleSheet.replaceSync is unavailable: EPUB book styles are not applied');
    }
    return null;
  }
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    return sheet.cssRules;
  } catch {
    return null;
  }
}

export function scopeCss(css: string, cssPath: string, ctx: ScopeCssContext): string {
  const key = ctx.bookKey.replace(/[^A-Za-z0-9_-]/g, '');
  /** familyKey → renamed family, for faces that survive (shared per book when the caller passes one). */
  const families = ctx.families ?? new Map<string, string>();
  /** Per-call budget: every zip stylesheet is inlined once; imported text and examined rules are capped. */
  const visited = new Set<string>([cssPath]);
  let importedChars = 0;
  let rulesLeft = MAX_RULES;
  const budget = ctx.budget;

  /** A zip path for `href` written in the stylesheet at `base`, or null (remote, data:, escaping, absent). */
  const zipPath = (base: string, href: string): string | null => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href.trim())) return null;
    return ctx.resolve(base, href)?.path ?? null;
  };

  const faceOf = (style: CSSStyleDeclaration, base: string): Node | null => {
    const family = familyName(style.getPropertyValue('font-family'));
    if (!family || /[^\p{L}\p{N} _.-]/u.test(family) || isGeneric(family.toLowerCase())) return null;
    const srcs: string[] = [];
    for (const item of splitTopLevel(style.getPropertyValue('src'))) {
      const m = /^url\(\s*(?:"([^"\\]*)"|'([^'\\]*)'|([^)\s"'\\]*))\s*\)\s*(.*)$/i.exec(item);
      if (!m) continue; // local(), or anything unexpected
      const href = m[1] ?? m[2] ?? m[3] ?? '';
      const path = href ? zipPath(base, href) : null;
      const url = path ? ctx.fontUrl(path) : null;
      if (!url || !/^blob:[^"\\\s()]+$/.test(url)) continue;
      const format = /^format\(\s*"?([a-z0-9-]+)"?\s*\)$/i.exec(m[4].trim());
      srcs.push(`url(${quote(url)})${format ? ` format(${quote(format[1].toLowerCase())})` : ''}`);
    }
    if (srcs.length === 0) return null;
    const name = `margin-epub-${key}-${family.replace(/[^\p{L}\p{N}_-]+/gu, '-')}`;
    families.set(family.toLowerCase(), name);
    const descs: Decl[] = [];
    for (const d of ['font-weight', 'font-style', 'font-stretch', 'unicode-range', 'font-display']) {
      const v = style.getPropertyValue(d).trim();
      if (v && /^[\w\s.%+?,-]+$/.test(v)) descs.push([d, v]);
    }
    return { kind: 'face', family: name, src: srcs.join(', '), descs };
  };

  const fromRules = (rules: CSSRuleList, base: string, groupDepth: number): Node[] => {
    const out: Node[] = [];
    for (let ri = 0; ri < rules.length; ri++) {
      if (rulesLeft <= 0) break;
      if (budget) {
        if (budget.cssRules <= 0) break;
        budget.cssRules--;
      }
      rulesLeft--;
      const rule = rules[ri];
      if (rule.type === RULE_STYLE) {
        const r = rule as CSSStyleRule;
        const selectors = splitTopLevel(r.selectorText)
          .map((s) => scopeSelector(s, ctx.scope))
          .filter((s): s is string => s !== null);
        const decls: Decl[] = [];
        for (let i = 0; i < r.style.length; i++) {
          const name = r.style[i].toLowerCase();
          const value = r.style.getPropertyValue(name).trim();
          if (allowedProperty(name) && allowedValue(name, value)) decls.push([name, value]);
        }
        if (!selectors.length || !decls.length) continue;
        // The section root's side padding is capped (epub.css's section guard makes it border-box): a
        // `body { padding-left: 90% }` would leave no column. Root selectors get their own rule for that.
        const root = selectors.filter((sel) => targetsRoot(sel, ctx.scope));
        if (root.length && decls.some(([k]) => SIDE_PADDING.has(k))) {
          const rest = selectors.filter((sel) => !root.includes(sel));
          if (rest.length) out.push({ kind: 'style', selectors: rest, decls });
          out.push({ kind: 'style', selectors: root, decls: decls.map(([k, v]) => [k, SIDE_PADDING.has(k) ? capPadding(v) : v]) });
        } else out.push({ kind: 'style', selectors, decls });
      } else if (rule.type === RULE_MEDIA) {
        const r = rule as CSSMediaRule;
        if (groupDepth >= MAX_GROUP_DEPTH || !allowedMedia(r.media.mediaText)) continue;
        const children = fromRules(r.cssRules, base, groupDepth + 1);
        if (children.length) out.push({ kind: 'group', at: 'media', cond: r.media.mediaText, children });
      } else if (rule.type === RULE_SUPPORTS) {
        const r = rule as CSSSupportsRule;
        if (groupDepth >= MAX_GROUP_DEPTH || /[{};\\<@]|url\(|\/\*/i.test(r.conditionText)) continue;
        const children = fromRules(r.cssRules, base, groupDepth + 1);
        if (children.length) out.push({ kind: 'group', at: 'supports', cond: r.conditionText, children });
      } else if (rule.type === RULE_FONT_FACE) {
        const face = faceOf((rule as CSSFontFaceRule).style, base);
        if (face) out.push(face);
      }
      // Everything else (@import, @keyframes, @page, @namespace, @layer, @container, …) is dropped.
    }
    return out;
  };

  const fromText = (text: string, base: string, depth: number): Node[] => {
    if (text.length > MAX_CSS_CHARS) return [];
    if (budget) {
      if (text.length > budget.cssChars) return []; // never parsed
      budget.cssChars -= text.length;
    }
    const out: Node[] = [];
    for (const imp of leadingImports(text)) {
      if (depth >= MAX_IMPORT_DEPTH || rulesLeft <= 0) break;
      if (imp.media && !allowedMedia(imp.media)) continue;
      const path = zipPath(base, imp.href);
      if (!path || visited.has(path)) continue;
      visited.add(path);
      const imported = ctx.readCss(path);
      if (imported === null || imported.length > MAX_IMPORTED_CHARS - importedChars) continue;
      importedChars += imported.length;
      const nodes = fromText(imported, path, depth + 1);
      if (!nodes.length) continue;
      if (imp.media) out.push({ kind: 'group', at: 'media', cond: imp.media, children: nodes });
      else for (const n of nodes) out.push(n);
    }
    if (rulesLeft <= 0) return out;
    const rules = parseSheet(text);
    if (rules) for (const n of fromRules(rules, base, 0)) out.push(n);
    return out;
  };

  const tree = fromText(css, cssPath, 0);

  /** Book families declared by a surviving `@font-face` are renamed; others (system fonts) stay. */
  const rewriteFamilies = (value: string): string =>
    splitTopLevel(value)
      .map((f) => {
        const k = familyKey(f);
        const renamed = isGeneric(k) ? undefined : families.get(k);
        return renamed ? quote(renamed) : f;
      })
      .join(', ');

  const write = (nodes: Node[]): string =>
    nodes
      .map((n) => {
        if (n.kind === 'face') {
          const descs = n.descs.map(([k, v]) => `${k}:${v};`).join('');
          return `@font-face{font-family:${quote(n.family)};src:${n.src};${descs}}`;
        }
        if (n.kind === 'group') {
          const inner = write(n.children);
          return inner ? `@${n.at} ${n.cond}{${inner}}` : '';
        }
        const decls = n.decls
          .map(([k, v]) => `${k}:${k === 'font-family' ? rewriteFamilies(v) : ZOOMED.has(k) ? zoomedLengths(v) : v};`)
          .join('');
        return `${n.selectors.join(', ')}{${decls}}`;
      })
      .filter(Boolean)
      .join('\n');

  return write(tree);
}
