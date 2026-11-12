import { strToU8, zipSync, type Zippable } from 'fflate';

/**
 * Test helper: builds a tiny EPUB in memory (no binary fixtures are committed).
 * Layout: OPF at `OEBPS/content.opf`, sections at `OEBPS/text/<name>`, CSS at `OEBPS/styles/<name>`,
 * cover at `OEBPS/images/<name>`, nav at `OEBPS/nav.xhtml` (v3), NCX at `OEBPS/toc.ncx` (v2).
 * `files` are extra entries keyed by raw zip path (written as is, so hostile names are possible).
 */
export interface MakeEpubOptions {
  version?: 2 | 3;
  title?: string;
  creator?: string;
  sections: { name: string; html: string; linear?: boolean }[];
  css?: Record<string, string>;
  files?: Record<string, Uint8Array | string>;
  nav?: string;
  ncx?: string;
  cover?: { name: string; bytes: Uint8Array; method: 'properties' | 'meta' | 'img' };
  fixedLayout?: boolean;
  encryption?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
/** Manifest hrefs are URLs: each segment percent-encoded. */
const urlOf = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export function xhtml(body: string, title = 'x'): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">` +
    `<head><title>${esc(title)}</title></head><body>${body}</body></html>`
  );
}

/** The zip entries of the EPUB, before zipping (tests may edit them). */
export function epubEntries(o: MakeEpubOptions): Record<string, Uint8Array> {
  const version = o.version ?? 3;
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, data: Uint8Array | string) => {
    files[path] = typeof data === 'string' ? strToU8(data) : data;
  };

  put('mimetype', 'application/epub+zip');
  put(
    'META-INF/container.xml',
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
      `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );

  const items: string[] = [];
  const spine: string[] = [];
  o.sections.forEach((s, i) => {
    const id = `s${i + 1}`;
    let html = s.html.includes('<html') ? s.html : xhtml(s.html, s.name);
    if (i === 0 && o.cover?.method === 'img') {
      html = html.replace(/<body([^>]*)>/, `<body$1><img src="../images/${urlOf(o.cover.name)}" alt="cover"/>`);
    }
    put(`OEBPS/text/${s.name}`, html);
    items.push(`<item id="${id}" href="text/${esc(urlOf(s.name))}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"${s.linear === false ? ' linear="no"' : ''}/>`);
  });
  Object.entries(o.css ?? {}).forEach(([name, css], i) => {
    put(`OEBPS/styles/${name}`, css);
    items.push(`<item id="css${i + 1}" href="styles/${esc(urlOf(name))}" media-type="text/css"/>`);
  });

  const metaExtra: string[] = [];
  if (o.cover) {
    put(`OEBPS/images/${o.cover.name}`, o.cover.bytes);
    const type = /\.png$/i.test(o.cover.name) ? 'image/png' : 'image/jpeg';
    const props = o.cover.method === 'properties' ? ' properties="cover-image"' : '';
    items.push(`<item id="cover-img" href="images/${esc(urlOf(o.cover.name))}" media-type="${type}"${props}/>`);
    if (o.cover.method === 'meta') metaExtra.push('<meta name="cover" content="cover-img"/>');
  }
  if (o.fixedLayout) metaExtra.push('<meta property="rendition:layout">pre-paginated</meta>');

  const navPoints = o.sections
    .map((s, i) => `<navPoint id="n${i + 1}"><navLabel><text>${esc(s.name)}</text></navLabel><content src="text/${esc(urlOf(s.name))}"/></navPoint>`)
    .join('');
  if (version === 3) {
    const navLis = o.sections.map((s) => `<li><a href="text/${esc(urlOf(s.name))}">${esc(s.name)}</a></li>`).join('');
    put('OEBPS/nav.xhtml', o.nav ?? xhtml(`<nav epub:type="toc"><ol>${navLis}</ol></nav>`, 'Contents'));
    items.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
  }
  if (version === 2 || o.ncx !== undefined) {
    put(
      'OEBPS/toc.ncx',
      o.ncx ??
        `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/>` +
          `<docTitle><text>${esc(o.title ?? '')}</text></docTitle><navMap>${navPoints}</navMap></ncx>`,
    );
    items.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
  }

  const dcs = [
    o.title !== undefined ? `<dc:title>${esc(o.title)}</dc:title>` : '',
    o.creator !== undefined ? `<dc:creator>${esc(o.creator)}</dc:creator>` : '',
    '<dc:language>en</dc:language>',
    '<dc:identifier id="uid">urn:uuid:test</dc:identifier>',
  ].join('');
  put(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="${version === 3 ? '3.0' : '2.0'}" unique-identifier="uid">` +
      `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${dcs}${metaExtra.join('')}</metadata>` +
      `<manifest>${items.join('')}</manifest>` +
      `<spine${version === 2 || o.ncx !== undefined ? ' toc="ncx"' : ''}>${spine.join('')}</spine></package>`,
  );
  if (o.encryption !== undefined) put('META-INF/encryption.xml', o.encryption);
  for (const [path, data] of Object.entries(o.files ?? {})) put(path, data);
  return files;
}

/** Zips entries (deflated) into an ArrayBuffer. */
export function zipEntries(files: Record<string, Uint8Array>, level: 0 | 6 = 6): ArrayBuffer {
  const z = zipSync(files as Zippable, { level });
  return z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength) as ArrayBuffer;
}

export function makeEpub(o: MakeEpubOptions): ArrayBuffer {
  return zipEntries(epubEntries(o));
}
