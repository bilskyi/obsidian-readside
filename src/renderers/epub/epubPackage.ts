import { Inflate } from 'fflate';

/**
 * EPUB package reader: zip directory, container.xml, OPF (metadata, manifest, spine), nav/NCX, cover,
 * encryption. Pure: no DOM side effects (DOMParser only builds detached documents).
 *
 * Every EPUB is untrusted (the plugin opens them unattended for covers and mirrors), so no input may
 * hang the thread. The zip directory is read here, not by fflate's `unzipSync`: the declared entry
 * count is refused above the cap before the walk, every directory record must carry its signature,
 * and declared sizes are capped before anything is inflated. Entries inflate through fflate's
 * streaming `Inflate` in small chunks and stop as soon as the output passes the declared size, so a
 * lying size costs at most one chunk's worth of work. Package XML with entity declarations is refused.
 */

export interface EpubManifestItem { id: string; href: string /* zip path, resolved */; mediaType: string; properties: string[] }
export interface EpubSection { index: number /* 1-based */; href: string; linear: boolean; mediaType: string }
export interface EpubTocEntry { title: string; section: number | null; fragment: string | null; children: EpubTocEntry[] }
export interface EpubPackage {
  title: string | null;
  creator: string | null;
  language: string | null;
  sections: EpubSection[];
  toc: EpubTocEntry[];
  coverHref: string | null;
  /** Some (not all) spine items are pre-paginated; they are still rendered reflowed. A fully fixed-layout book is refused. */
  fixedLayout: boolean;
  /** Zip paths of obfuscated fonts (IDPF / Adobe): left out of `@font-face`. */
  obfuscated: ReadonlySet<string>;
  /** UTF-8 decoded (cached); null if absent. */
  text(path: string): string | null;
  /** Inflated on every call (never cached); null if absent or corrupt. */
  bytes(path: string): Uint8Array | null;
  mediaType(path: string): string | null;
  /** Null on escape, external URL or absent target. */
  resolve(fromPath: string, href: string): { path: string; fragment: string | null } | null;
  sectionOf(path: string): number | null;
}

export class EpubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpubError';
  }
}

export interface EpubLimits {
  /** Largest declared uncompressed size of one entry. */
  maxEntryBytes: number;
  /** Largest declared uncompressed size of all entries together. */
  maxTotalBytes: number;
  maxEntries: number;
}

export const EPUB_LIMITS: EpubLimits = {
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntries: 10_000,
};

/** Most spine sections (after duplicates are dropped); a longer spine is refused. Part of the text model. */
export const MAX_SPINE = 5_000;
const MAX_TOC_DEPTH = 16;
const MAX_TOC_ENTRIES = 5_000;

const unreadable = (why: string) => new EpubError(`This file isn't a readable EPUB (${why})`);
const drm = () => new EpubError('This EPUB is DRM-protected');
const tooManySections = () =>
  new EpubError(`This EPUB has more than ${MAX_SPINE.toLocaleString('en-US')} sections, more than Margin can open`);
const fixedLayout = () => new EpubError("Fixed-layout EPUBs aren't supported yet");

const OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);
const NCX_TYPE = 'application/x-dtbncx+xml';
const OPS_NS = 'http://www.idpf.org/2007/ops';

// ---------------------------------------------------------------- paths

/**
 * Normalises a zip-root-relative path (NFC, like entry names); null if it climbs above the root or holds
 * a forbidden character.
 */
export function normalizeZipPath(path: string): string | null {
  if (path.includes('\\') || path.includes('\0')) return null;
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.length ? out.join('/').normalize('NFC') : null;
}

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');

function decodeSegment(seg: string): string | null {
  try {
    const d = decodeURIComponent(seg);
    return d.includes('/') ? null : d; // an encoded "/" would smuggle a separator past normalisation
  } catch {
    return null;
  }
}

/**
 * Resolves `href` against the folder of `fromPath` to a zip path, percent-decoded and normalised.
 * Null for external or absolute URLs, escapes above the root and malformed escapes. Does not check existence.
 */
export function resolveHref(fromPath: string, href: string): { path: string; fragment: string | null } | null {
  const raw = href.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/')) return null;
  const hash = raw.indexOf('#');
  const pathPart = (hash < 0 ? raw : raw.slice(0, hash)).replace(/\?.*$/, '');
  const fragRaw = hash < 0 ? '' : raw.slice(hash + 1);
  let fragment: string | null = null;
  if (fragRaw) {
    try {
      fragment = decodeURIComponent(fragRaw);
    } catch {
      fragment = fragRaw;
    }
  }
  if (pathPart === '') {
    const self = normalizeZipPath(fromPath);
    return self ? { path: self, fragment } : null;
  }
  const segs: string[] = [];
  for (const seg of pathPart.split('/')) {
    const d = decodeSegment(seg);
    if (d === null) return null;
    segs.push(d);
  }
  const path = normalizeZipPath(dirOf(fromPath) + segs.join('/'));
  return path ? { path, fragment } : null;
}

// ---------------------------------------------------------------- xml

type ParsedDoc = Document;

function parseXml(text: string, what: string): ParsedDoc {
  // Internal entity declarations are the billion-laughs vector; no legitimate package file needs them.
  if (/<!ENTITY/i.test(text)) throw unreadable(`${what} declares XML entities`);
  let doc: ParsedDoc;
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml');
  } catch {
    throw unreadable(`${what} is not well-formed XML`);
  }
  if (!doc.documentElement || doc.getElementsByTagNameNS('*', 'parsererror').length > 0) {
    throw unreadable(`${what} is not well-formed XML`);
  }
  return doc;
}

/** XHTML that may be sloppy: XML first, then the forgiving HTML parser. Null when unusable. */
export function parseXhtml(text: string): ParsedDoc | null {
  if (/<!ENTITY/i.test(text)) return null;
  try {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.documentElement && doc.getElementsByTagNameNS('*', 'parsererror').length === 0) return doc;
  } catch {
    /* fall through */
  }
  try {
    return new DOMParser().parseFromString(text, 'text/html');
  } catch {
    return null;
  }
}

const byLocal = (root: ParentNode & { getElementsByTagNameNS: Element['getElementsByTagNameNS'] }, name: string) =>
  Array.from(root.getElementsByTagNameNS('*', name));

const childrenNamed = (el: Element, name: string) => Array.from(el.children).filter((c) => c.localName === name);

const cleanText = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

const tokens = (s: string | null) => (s ?? '').split(/\s+/).filter(Boolean);

// ---------------------------------------------------------------- zip

interface ZipEntry {
  method: number;
  /** Compressed size (bytes stored in the archive). */
  size: number;
  /** Declared uncompressed size. */
  originalSize: number;
  /** Offset of the local file header. */
  header: number;
}

/** Compressed input handed to the streaming inflater per push. */
// Deflate reaches ~1032:1, so one push can expand to ~16.5 MB before the size check runs.
export const INFLATE_CHUNK = 16 * 1024;

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX32 = 0xffffffff;

const latin1 = new TextDecoder('latin1');
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/**
 * The key an entry is stored under: NFC (macOS tools write NFD names, OPF hrefs are usually NFC), a backslash
 * read as `/` (Windows tools), repeated `/` collapsed and leading `./` dropped, so it matches a resolved href.
 * `..` segments and a leading `/` are left alone: `resolveHref` never yields such a path, so an escaping
 * name stays unreachable (zip-slip).
 */
function entryKey(name: string): string {
  let key = name.normalize('NFC').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (key.startsWith('./')) key = key.slice(2);
  return key;
}

function zipName(raw: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return new TextDecoder('utf-8').decode(raw);
  try {
    return utf8Strict.decode(raw); // many EPUB tools write UTF-8 names without setting the flag
  } catch {
    return latin1.decode(raw);
  }
}

/**
 * Reads the central directory. Throws an `EpubError` for anything that is not a well-formed zip or that
 * breaks a limit, before any entry is inflated.
 */
function readDirectory(zip: Uint8Array, limits: EpubLimits): Map<string, ZipEntry> {
  const len = zip.length;
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const u64 = (at: number) => u32(at + 4) * 2 ** 32 + u32(at);
  const notZip = () => unreadable('not a zip archive');

  // End of central directory: the last 22 + up to 65,535 (comment) bytes. A signature can also occur
  // inside a comment, so prefer the record whose comment ends exactly at the end of the file; failing
  // that, the last one.
  let eocd = -1;
  for (let at = len - 22; at >= 0 && len - at <= 22 + 0xffff; at--) {
    if (u32(at) !== SIG_EOCD) continue;
    if (eocd < 0) eocd = at;
    if (at + 22 + u16(at + 20) === len) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw notZip();
  let count = u16(eocd + 10);
  let cd = u32(eocd + 16);
  if (eocd >= 20 && u32(eocd - 20) === SIG_EOCD64_LOCATOR) {
    const at = u64(eocd - 12);
    if (at + 56 > len || u32(at) !== SIG_EOCD64) throw notZip();
    count = u64(at + 32);
    cd = u64(at + 48);
  }
  // Refuse a hostile count (a zip64 record can claim 2^64 - 1) before walking anything.
  if (count > limits.maxEntries) throw unreadable('too many files');
  if (count === 0) throw unreadable('the archive is empty');

  const entries = new Map<string, ZipEntry>();
  let total = 0;
  let at = cd;
  for (let i = 0; i < count; i++) {
    if (at + 46 > len || u32(at) !== SIG_CENTRAL) throw notZip();
    const flags = u16(at + 8);
    const method = u16(at + 10);
    let size = u32(at + 20);
    let originalSize = u32(at + 24);
    const nameLen = u16(at + 28);
    const extraLen = u16(at + 30);
    const commentLen = u16(at + 32);
    let header = u32(at + 42);
    const extra = at + 46 + nameLen;
    const next = extra + extraLen + commentLen;
    if (next > len) throw notZip();
    const name = entryKey(zipName(zip.subarray(at + 46, extra), (flags & 0x800) !== 0));
    const isDir = name.endsWith('/') || name === '';
    // Traditional PKWARE encryption: nothing here can read it, and nothing may hand out its ciphertext.
    if ((flags & 1) !== 0 && !isDir) throw drm();
    if (size === MAX32 || originalSize === MAX32 || header === MAX32) {
      // zip64 extended information: the 8-byte values present are, in order, original, compressed, offset.
      let found = false;
      for (let x = extra; x + 4 <= extra + extraLen; x += 4 + u16(x + 2)) {
        const fieldEnd = x + 4 + u16(x + 2);
        if (fieldEnd > extra + extraLen) throw notZip(); // a field may not run past the extra block
        if (u16(x) !== 1) continue;
        let v = x + 4;
        const end = fieldEnd;
        const take = () => {
          if (v + 8 > end) throw notZip();
          const n = u64(v);
          v += 8;
          return n;
        };
        if (originalSize === MAX32) originalSize = take();
        if (size === MAX32) size = take();
        if (header === MAX32) header = take();
        found = true;
        break;
      }
      if (!found) throw notZip();
    }
    if (originalSize > limits.maxEntryBytes) throw unreadable(`${name} is too large`);
    // A stored entry's real size is its compressed size: cap that too.
    if (method === 0 && size > limits.maxEntryBytes) throw unreadable(`${name} is too large`);
    // Deflate never expands by more than a few bytes per 64 KiB block; more means the declared size lies.
    if (method === 8 && size > originalSize * 1.01 + 1024) throw unreadable(`${name} declares a false size`);
    // A stored entry is its bytes: any difference between the two sizes is a lie.
    if (method === 0 && size !== originalSize) throw unreadable(`${name} declares a false size`);
    total += originalSize;
    if (total > limits.maxTotalBytes) throw unreadable('its contents are too large');
    if (!isDir) entries.set(name, { method, size, originalSize, header });
    at = next;
  }
  if (entries.size === 0) throw unreadable('the archive is empty');
  return entries;
}

/** Inflates one entry; null when corrupt, of an unsupported method, or larger than it declared. */
function readEntry(zip: Uint8Array, e: ZipEntry): Uint8Array | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  if (e.header + 30 > zip.length || view.getUint32(e.header, true) !== SIG_LOCAL) return null;
  const start = e.header + 30 + view.getUint16(e.header + 26, true) + view.getUint16(e.header + 28, true);
  const end = start + e.size;
  if (end > zip.length) return null;
  if (e.method === 0) return zip.slice(start, end);
  if (e.method !== 8) return null;

  const parts: Uint8Array[] = [];
  let produced = 0;
  let done = false;
  const inflater = new Inflate((chunk, final) => {
    parts.push(chunk);
    produced += chunk.length;
    if (final) done = true;
  });
  try {
    let pos = start;
    do {
      const stop = Math.min(pos + INFLATE_CHUNK, end);
      inflater.push(zip.subarray(pos, stop), stop >= end);
      if (produced > e.originalSize) return null; // the declared size lied: stop before it costs more
      pos = stop;
    } while (pos < end);
  } catch {
    return null;
  }
  if (!done) return null;
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(produced);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Decodes a text entry: a BOM wins, then an XML declaration naming a single-byte encoding, then UTF-8. */
function decodeText(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b);
  const head = latin1.decode(b.subarray(0, 200));
  const declared = /^\s*<\?xml[^>]*?\sencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)?.[1].toLowerCase();
  if (declared && /^(iso-8859-1|iso8859-1|latin-?1|windows-1252|cp1252)$/.test(declared)) {
    return new TextDecoder('windows-1252').decode(b); // the WHATWG decoder for all of these labels
  }
  return new TextDecoder('utf-8').decode(b);
}

// ---------------------------------------------------------------- open

export function openEpub(data: ArrayBuffer, limits: EpubLimits = EPUB_LIMITS): EpubPackage {
  const zip = new Uint8Array(data);
  let entries: Map<string, ZipEntry>;
  try {
    entries = readDirectory(zip, limits);
  } catch (e) {
    // Whatever slipped past the structural checks (e.g. a read past the end) is still "not a zip".
    if (e instanceof EpubError) throw e;
    throw unreadable('not a zip archive');
  }

  // Only decoded text is cached (sections, CSS and package files are read more than once). Bytes are
  // inflated on every call and never kept: an image comes back when its section nears the viewport
  // again, and caching it would hold every image of the book for the reader's life.
  const textCache = new Map<string, string | null>();

  const bytes = (path: string): Uint8Array | null => {
    const entry = entries.get(path);
    return entry ? readEntry(zip, entry) : null;
  };
  const text = (path: string): string | null => {
    if (textCache.has(path)) return textCache.get(path)!;
    const b = bytes(path);
    const t = b === null ? null : decodeText(b);
    textCache.set(path, t);
    return t;
  };
  const resolve = (fromPath: string, href: string) => {
    const r = resolveHref(fromPath, href);
    return r && entries.has(r.path) ? r : null;
  };
  const required = (path: string, what: string): string => {
    const t = text(path);
    if (t === null) throw unreadable(`${what} is missing`);
    return t;
  };

  // container.xml -> OPF path
  const container = parseXml(required('META-INF/container.xml', 'META-INF/container.xml'), 'META-INF/container.xml');
  const rootfiles = byLocal(container, 'rootfile');
  const rootfile =
    rootfiles.find((r) => r.getAttribute('media-type') === 'application/oebps-package+xml') ?? rootfiles[0];
  const opfRef = rootfile?.getAttribute('full-path');
  if (!opfRef) throw unreadable('META-INF/container.xml names no package file');
  const opfPath = resolve('', opfRef)?.path;
  if (!opfPath) throw unreadable('its package file is missing');

  // Encryption: anything but an obfuscated font means DRM, including an entry whose target can't be
  // resolved (we can't tell what it hides) and one naming a resource that isn't a font.
  const encryptionText = text('META-INF/encryption.xml');
  const encrypted: { path: string; algorithm: string }[] = [];
  if (encryptionText !== null) {
    const enc = parseXml(encryptionText, 'META-INF/encryption.xml');
    for (const data of byLocal(enc, 'EncryptedData')) {
      const algorithm = byLocal(data, 'EncryptionMethod')[0]?.getAttribute('Algorithm') ?? '';
      const uri = byLocal(data, 'CipherReference')[0]?.getAttribute('URI');
      const r = uri ? resolveHref('', uri) : null;
      if (!r) throw drm();
      encrypted.push({ path: r.path, algorithm });
    }
  }

  const opf = parseXml(required(opfPath, opfPath), opfPath);
  const pkg = opf.documentElement;
  if (pkg.localName !== 'package') throw unreadable(`${opfPath} is not a package document`);
  const metadata = byLocal(opf, 'metadata')[0] ?? null;

  const dc = (name: string): string | null => {
    if (!metadata) return null;
    for (const el of byLocal(metadata, name)) {
      const t = cleanText(el.textContent);
      if (t) return t;
    }
    return null;
  };
  const metas = metadata ? byLocal(metadata, 'meta') : [];

  // Manifest
  const manifest = new Map<string, EpubManifestItem>();
  const typeOfPath = new Map<string, string>();
  for (const item of byLocal(opf, 'item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (!id || !href || manifest.has(id)) continue;
    const r = resolve(opfPath, href);
    if (!r) continue; // remote, escaping or absent: never fetched
    const m: EpubManifestItem = {
      id,
      href: r.path,
      mediaType: (item.getAttribute('media-type') ?? '').trim().toLowerCase(),
      properties: tokens(item.getAttribute('properties')),
    };
    manifest.set(id, m);
    if (!typeOfPath.has(m.href)) typeOfPath.set(m.href, m.mediaType);
  }

  const isFont = (path: string) => {
    const t = typeOfPath.get(path) ?? '';
    return /^(font\/|application\/(font-|x-font|vnd\.ms-opentype))/.test(t) || /\.(ttf|otf|woff2?)$/i.test(path);
  };
  const obfuscated = new Set<string>();
  for (const e of encrypted) {
    if (!OBFUSCATION.has(e.algorithm) || !isFont(e.path)) throw drm();
    if (entries.has(e.path)) obfuscated.add(e.path);
  }

  // Fixed layout. A `refines` meta describes one item, not the book. Apple's display-options file and
  // Kindle's `<meta name="fixed-layout">` are not read (a non-goal; see the E9 checklist).
  const globalLayout = metas.find(
    (m) => m.getAttribute('property') === 'rendition:layout' && !m.hasAttribute('refines'),
  );
  if (cleanText(globalLayout?.textContent) === 'pre-paginated') throw fixedLayout();

  // Spine. A file listed twice (by the same idref, or two ids naming one href) is one section, at its
  // first place: a 1 KB zip repeating one itemref must not become thousands of sections to sanitise.
  // Part of the text model (section numbers index stored locations): see SANITIZER_VERSION.
  const spine = byLocal(opf, 'spine')[0] ?? null;
  const sections: EpubSection[] = [];
  const sectionByPath = new Map<string, number>();
  let prePaginated = 0;
  if (spine) {
    for (const ref of childrenNamed(spine, 'itemref')) {
      const item = manifest.get(ref.getAttribute('idref') ?? '');
      if (!item || sectionByPath.has(item.href)) continue;
      if (sections.length >= MAX_SPINE) throw tooManySections();
      const props = tokens(ref.getAttribute('properties'));
      if (props.includes('rendition:layout-pre-paginated')) prePaginated++;
      const index = sections.length + 1;
      sections.push({ index, href: item.href, linear: ref.getAttribute('linear')?.trim() !== 'no', mediaType: item.mediaType });
      sectionByPath.set(item.href, index);
    }
  }
  if (sections.length === 0) throw unreadable('it has no readable sections');
  if (prePaginated === sections.length) throw fixedLayout();

  const sectionOf = (path: string) => sectionByPath.get(path) ?? null;
  const mediaType = (path: string) => typeOfPath.get(path) ?? null;

  // TOC
  let tocCount = 0;
  const entry = (fromPath: string, title: string, href: string | null, children: EpubTocEntry[]): EpubTocEntry | null => {
    const r = href ? resolve(fromPath, href) : null;
    const section = r ? sectionOf(r.path) : null;
    if (!title && children.length === 0) return null;
    tocCount++;
    return { title, section, fragment: section === null ? null : (r?.fragment ?? null), children };
  };

  const navToc = (navPath: string): EpubTocEntry[] => {
    const t = text(navPath);
    const doc = t === null ? null : parseXhtml(t);
    if (!doc) return [];
    const nav = byLocal(doc, 'nav').find((n) =>
      tokens(n.getAttributeNS(OPS_NS, 'type') ?? n.getAttribute('epub:type')).includes('toc'),
    );
    const list = nav && Array.from(nav.children).find((c) => c.localName === 'ol');
    const walk = (ol: Element, depth: number): EpubTocEntry[] => {
      const out: EpubTocEntry[] = [];
      for (const li of childrenNamed(ol, 'li')) {
        if (tocCount >= MAX_TOC_ENTRIES) break;
        const head = Array.from(li.children).find((c) => c.localName === 'a' || c.localName === 'span');
        const sub = childrenNamed(li, 'ol')[0];
        const children = sub && depth < MAX_TOC_DEPTH ? walk(sub, depth + 1) : [];
        const href = head?.localName === 'a' ? head.getAttribute('href') : null;
        const e = entry(navPath, cleanText(head?.textContent), href, children);
        if (e) out.push(e);
      }
      return out;
    };
    return list ? walk(list, 1) : [];
  };

  const ncxToc = (ncxPath: string): EpubTocEntry[] => {
    const t = text(ncxPath);
    if (t === null) return [];
    let doc: ParsedDoc;
    try {
      doc = parseXml(t, ncxPath);
    } catch {
      return [];
    }
    const navMap = byLocal(doc, 'navMap')[0];
    const walk = (parent: Element, depth: number): EpubTocEntry[] => {
      const out: EpubTocEntry[] = [];
      for (const point of childrenNamed(parent, 'navPoint')) {
        if (tocCount >= MAX_TOC_ENTRIES) break;
        const children = depth < MAX_TOC_DEPTH ? walk(point, depth + 1) : [];
        const label = childrenNamed(point, 'navLabel')[0];
        const title = cleanText(label ? childrenNamed(label, 'text')[0]?.textContent : '');
        const src = childrenNamed(point, 'content')[0]?.getAttribute('src') ?? null;
        const e = entry(ncxPath, title, src, children);
        if (e) out.push(e);
      }
      return out;
    };
    return navMap ? walk(navMap, 1) : [];
  };

  let toc: EpubTocEntry[] = [];
  const navItem = [...manifest.values()].find((m) => m.properties.includes('nav'));
  if (navItem) toc = navToc(navItem.href);
  if (toc.length === 0) {
    tocCount = 0;
    const ncxItem =
      manifest.get(spine?.getAttribute('toc') ?? '') ?? [...manifest.values()].find((m) => m.mediaType === NCX_TYPE);
    if (ncxItem) toc = ncxToc(ncxItem.href);
  }

  // Cover
  const isImage = (path: string) => (typeOfPath.get(path) ?? '').startsWith('image/');
  let coverHref: string | null =
    [...manifest.values()].find((m) => m.properties.includes('cover-image') && isImage(m.href))?.href ?? null;
  if (!coverHref) {
    const id = metas.find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content');
    const item = id ? manifest.get(id) : undefined;
    if (item && isImage(item.href)) coverHref = item.href;
  }
  if (!coverHref) {
    const first = sections[0].href;
    const t = text(first);
    const doc = t === null ? null : parseXhtml(t);
    if (doc) {
      // The first <img> or SVG <image> in document order.
      const all = doc.getElementsByTagNameNS('*', '*');
      let img: Element | null = null;
      for (let i = 0; i < all.length && !img; i++) {
        const name = all[i].localName.toLowerCase();
        if (name === 'img' || name === 'image') img = all[i];
      }
      const src =
        img?.getAttribute('src') ??
        img?.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ??
        img?.getAttribute('xlink:href') ??
        img?.getAttribute('href') ??
        null;
      const r = src ? resolve(first, src) : null;
      if (r && isImage(r.path)) coverHref = r.path;
    }
  }

  return {
    title: dc('title'),
    creator: dc('creator'),
    language: dc('language'),
    sections,
    toc,
    coverHref,
    fixedLayout: prePaginated > 0,
    obfuscated,
    text,
    bytes,
    mediaType,
    resolve,
    sectionOf,
  };
}
