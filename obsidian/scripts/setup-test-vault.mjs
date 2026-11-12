// Prepares obsidian/test-vault: a sample PDF (with an outline) and the plugin folder whose
// main.js / styles.css / manifest.json are symlinks into obsidian/dist. Idempotent.
// With --epub it also downloads two public-domain EPUBs into Books/ (pinned URLs, sha256-verified).
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vault = join(here, '..', 'test-vault');
const dist = join(here, '..', 'dist');
const pluginDir = join(vault, '.obsidian', 'plugins', 'margin-reader');

const PAGES = [
  { title: 'Economy', lines: ['Walden', 'Economy', 'Simplify, simplify. Our life is frittered away by detail.'] },
  { title: 'Where I Lived', lines: ['Where I Lived, and What I Lived For', 'I went to the woods because I wished to live deliberately.'] },
  { title: 'Conclusion', lines: ['Conclusion', 'Rather than love, than money, than fame, give me truth.'] },
];

// Sample EPUBs, downloaded once and pinned. Books/ is gitignored: never commit the files.
// Standard Ebooks shows an HTML "download started" page unless the URL carries ?source=download.
const EPUBS = [
  {
    file: 'Pride and Prejudice.epub',
    url: 'https://www.gutenberg.org/cache/epub/1342/pg1342-images-3.epub',
    sha256: 'fd519471687295a8b2492d9e413bc24bee21ade9808d8af29899a16e8599064e',
    size: 24864457,
  },
  {
    file: 'The Picture of Dorian Gray.epub',
    url: 'https://standardebooks.org/ebooks/oscar-wilde/the-picture-of-dorian-gray/downloads/oscar-wilde_the-picture-of-dorian-gray.epub?source=download',
    sha256: '8613aa7fd5874c4b9fce62245220545711bff0cc128cc914648ff0e20241ec78',
    size: 634177,
  },
];

async function downloadEpubs() {
  for (const e of EPUBS) {
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) {
      throw new Error(`--epub refused: ${e.file} has no pinned sha256 (${e.sha256}); record it from a download first`);
    }
  }
  for (const e of EPUBS) {
    const dest = join(vault, 'Books', e.file);
    const check = (buf) => buf.length === e.size && createHash('sha256').update(buf).digest('hex') === e.sha256;
    if (existsSync(dest) && check(readFileSync(dest))) {
      console.log(`  ${e.file}: already present, verified`);
      continue;
    }
    const res = await fetch(e.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${e.file}: HTTP ${res.status} from ${e.url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!check(buf)) throw new Error(`${e.file}: size or sha256 mismatch (got ${buf.length} bytes); not written`);
    writeFileSync(`${dest}.part`, buf);
    renameSync(`${dest}.part`, dest);
    console.log(`  ${e.file}: downloaded, verified`);
  }
}

const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);

function samplePdf() {
  const objs = [];
  const add = (s) => objs.push(s) && objs.length;
  const catalog = add('');
  const pages = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageRefs = [];
  for (const p of PAGES) {
    const text = p.lines.map((l, i) => `BT /F1 ${i === 0 ? 20 : 12} Tf 72 ${720 - i * 28} Td (${esc(l)}) Tj ET`).join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream`);
    pageRefs.push(
      add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`),
    );
  }
  const outlines = add('');
  const items = PAGES.map(() => add(''));
  items.forEach((id, i) => {
    const prev = i > 0 ? `/Prev ${items[i - 1]} 0 R ` : '';
    const next = i < items.length - 1 ? `/Next ${items[i + 1]} 0 R ` : '';
    objs[id - 1] = `<< /Title (${esc(PAGES[i].title)}) /Parent ${outlines} 0 R ${prev}${next}/Dest [${pageRefs[i]} 0 R /XYZ 0 792 0] >>`;
  });
  objs[outlines - 1] = `<< /Type /Outlines /First ${items[0]} 0 R /Last ${items[items.length - 1]} 0 R /Count ${items.length} >>`;
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R /Outlines ${outlines} 0 R /PageMode /UseOutlines >>`;
  objs[pages - 1] = `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

mkdirSync(join(vault, 'Books'), { recursive: true });
writeFileSync(join(vault, 'Books', 'Walden.pdf'), samplePdf());
const wantEpub = process.argv.includes('--epub');
if (wantEpub) await downloadEpubs();

mkdirSync(pluginDir, { recursive: true });
for (const f of ['main.js', 'styles.css', 'manifest.json']) {
  const link = join(pluginDir, f);
  if (existsSync(link) || (() => { try { return lstatSync(link).isSymbolicLink(); } catch { return false; } })()) unlinkSync(link);
  symlinkSync(relative(pluginDir, join(dist, f)), link);
}
console.log(`test vault ready: ${vault}\n  sample: Books/Walden.pdf${wantEpub ? ', ' + EPUBS.map((e) => 'Books/' + e.file).join(', ') : ' (add --epub for two sample EPUBs)'}\n  plugin: .obsidian/plugins/margin-reader → obsidian/dist (run pnpm build:obsidian or pnpm dev:obsidian)`);
