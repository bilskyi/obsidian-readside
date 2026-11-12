/**
 * Scopes Margin's shared stylesheets under `.margin-app` for the Obsidian plugin (spec §8). Pure:
 * esbuild's bundled CSS goes in, the plugin's styles.css comes out.
 * - `:root` → `.margin-app`; inside `@media (prefers-color-scheme: dark)` → `.theme-dark .margin-app`,
 *   and that media wrapper is removed (Obsidian's theme decides, not the OS);
 * - rules for `html`, `body` and `#root` are dropped;
 * - every other selector gets the `.margin-app ` prefix — class selectors too, since Obsidian has its
 *   own `.popover`, `.notice`, `.search-result`…;
 * - `@keyframes x` → `@keyframes margin-x`, and `animation` / `animation-name` values follow.
 */
export const SCOPE = '.margin-app';
const DARK_ROOT = `.theme-dark ${SCOPE}`;
const KEYFRAME_PREFIX = 'margin-';
const DARK_MEDIA = /^@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)$/i;
const NESTING_AT = /^@(media|supports|container|layer)\b/i;
const KEYFRAMES = /^@(-webkit-)?keyframes\s+(\S+)$/i;
const DOCUMENT_LEVEL = /^(html|body|#root)(?![\w-])/;
const ALREADY = /^\.margin-app(?![\w-])/;

interface Block {
  prelude: string;
  /** null: a statement that ends in `;` */
  body: string | null;
}

/** Index just past the string starting at `i` (a quote). */
function skipString(css: string, i: number): number {
  const q = css[i];
  let j = i + 1;
  while (j < css.length && css[j] !== q) {
    if (css[j] === '\\') j++;
    j++;
  }
  return j + 1;
}

function stripComments(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      const end = skipString(css, i);
      out += css.slice(i, end);
      i = end;
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The top-level statements of a stylesheet (comments already gone). */
function split(css: string): Block[] {
  const out: Block[] = [];
  let i = 0;
  let start = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      i = skipString(css, i);
    } else if (c === ';') {
      const prelude = css.slice(start, i).trim();
      if (prelude) out.push({ prelude, body: null });
      start = ++i;
    } else if (c === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < css.length && depth > 0) {
        const d = css[j];
        if (d === '"' || d === "'") {
          j = skipString(css, j);
          continue;
        }
        if (d === '{') depth++;
        else if (d === '}') depth--;
        j++;
      }
      out.push({ prelude: css.slice(start, i).trim(), body: css.slice(i + 1, j - 1) });
      i = start = j;
    } else if (c === '}') {
      start = ++i;
    } else {
      i++;
    }
  }
  return out;
}

/** A selector list split at its top-level commas. */
function selectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '"' || c === "'") {
      i = skipString(list, i) - 1;
    } else if (c === '(' || c === '[') {
      depth++;
    } else if (c === ')' || c === ']') {
      depth--;
    } else if (c === ',' && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}

function scopeSelector(sel: string, root: string): string | null {
  if (DOCUMENT_LEVEL.test(sel)) return null;
  if (sel.startsWith(':root')) return root + sel.slice(':root'.length);
  if (ALREADY.test(sel)) return root === SCOPE ? sel : `.theme-dark ${sel}`;
  return `${root} ${sel}`;
}

function renameAnimations(body: string, names: ReadonlySet<string>): string {
  if (names.size === 0) return body;
  return body.replace(/(^|;)(\s*)(animation(?:-name)?\s*:)([^;]*)/gi, (_m, sep: string, ws: string, prop: string, value: string) =>
    sep + ws + prop + value.replace(/(^|[^\w-])([A-Za-z_][\w-]*)/g, (w: string, pre: string, word: string) =>
      names.has(word) ? pre + KEYFRAME_PREFIX + word : w,
    ),
  );
}

function scopeSheet(css: string, root: string, names: ReadonlySet<string>): string {
  let out = '';
  for (const b of split(css)) {
    if (b.body === null) {
      if (!/^@import\b/i.test(b.prelude)) out += `${b.prelude};\n`;
      continue;
    }
    if (b.prelude.startsWith('@')) {
      if (DARK_MEDIA.test(b.prelude)) {
        out += scopeSheet(b.body, DARK_ROOT, names);
        continue;
      }
      const kf = KEYFRAMES.exec(b.prelude);
      if (kf) {
        const name = kf[2].startsWith(KEYFRAME_PREFIX) ? kf[2] : KEYFRAME_PREFIX + kf[2];
        out += `@${kf[1] ?? ''}keyframes ${name} {${b.body}}\n`;
        continue;
      }
      if (NESTING_AT.test(b.prelude)) {
        const inner = scopeSheet(b.body, root, names);
        if (inner.trim()) out += `${b.prelude} {\n${inner}}\n`;
        continue;
      }
      out += `${b.prelude} {${b.body}}\n`;
      continue;
    }
    const sels = selectors(b.prelude)
      .map((s) => scopeSelector(s, root))
      .filter((s): s is string => s !== null);
    if (sels.length) out += `${sels.join(', ')} {${renameAnimations(b.body, names)}}\n`;
  }
  return out;
}

export function scopeCss(css: string): string {
  const clean = stripComments(css);
  const names = new Set<string>();
  for (const m of clean.matchAll(/@(?:-webkit-)?keyframes\s+([^\s{]+)/gi)) {
    if (!m[1].startsWith(KEYFRAME_PREFIX)) names.add(m[1]);
  }
  return scopeSheet(clean, SCOPE, names);
}

/** Every style-rule selector in a stylesheet, inside @media/@supports too (keyframes and @font-face skipped). */
export function listSelectors(css: string): string[] {
  const out: string[] = [];
  for (const b of split(stripComments(css))) {
    if (b.body === null) continue;
    if (b.prelude.startsWith('@')) {
      if (NESTING_AT.test(b.prelude)) out.push(...listSelectors(b.body));
      continue;
    }
    out.push(...selectors(b.prelude));
  }
  return out;
}
