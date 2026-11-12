import { FuzzySuggestModal, type App, type TFile } from 'obsidian';

/** A vault file Margin opens: its extension is `pdf` in any case (`Scan.PDF` too). */
export function isPdf(file: TFile | null | undefined): file is TFile {
  return !!file && file.extension.toLowerCase() === 'pdf';
}

/** A vault file Margin reads: a PDF or an EPUB, the extension in any case (`Moby.EPUB` too). */
export function isBook(file: TFile | null | undefined): file is TFile {
  if (!file) return false;
  const ext = file.extension.toLowerCase();
  return ext === 'pdf' || ext === 'epub';
}

/** A vault EPUB (extension in any case). */
export function isEpub(file: TFile | null | undefined): file is TFile {
  return !!file && file.extension.toLowerCase() === 'epub';
}

/** Vault books (PDFs and EPUBs): the ones opened in Margin first, newest first, then the rest by path. `opened`: path → ISO time. */
export function recentFirst(files: TFile[], opened: ReadonlyMap<string, string>): TFile[] {
  return files
    .filter((f) => isBook(f))
    .sort((a, b) => {
      const x = opened.get(a.path) ?? '';
      const y = opened.get(b.path) ?? '';
      if (x !== y) return x < y ? 1 : -1;
      return a.path.localeCompare(b.path);
    });
}

const WIKI = /!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
/** `[x](path)` or `[x](<path with spaces>)`. */
const MARKDOWN = /!?\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))\)/g;

/** The PDF a wiki or Markdown link under the cursor points to (`ch` within the link), else null. */
export function pdfLinkAt(line: string, ch: number): string | null {
  const target = linkTargetAt(line, ch);
  return target && /\.pdf$/i.test(target) ? target : null;
}

/** The book (PDF or EPUB) a wiki or Markdown link under the cursor points to (`ch` within the link), else null. */
export function bookLinkAt(line: string, ch: number): string | null {
  const target = linkTargetAt(line, ch);
  return target && /\.(pdf|epub)$/i.test(target) ? target : null;
}

/** The vault path a wiki or Markdown link under the cursor names (subpath dropped); null for a URL or no link. */
function linkTargetAt(line: string, ch: number): string | null {
  for (const [re, markdown] of [
    [WIKI, false],
    [MARKDOWN, true],
  ] as const) {
    for (const m of line.matchAll(re)) {
      const start = m.index ?? 0;
      if (ch < start || ch > start + m[0].length) continue;
      let target = (m[1] ?? m[2]).trim();
      if (markdown) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null; // a URL, not a vault file
        try {
          target = decodeURIComponent(target);
        } catch {
          // keep it as written
        }
        target = target.replace(/#.*$/, '');
      }
      return target;
    }
  }
  return null;
}

/** The picker of vault books (PDFs and EPUBs). */
export class PdfPicker extends FuzzySuggestModal<TFile> {
  private readonly files: TFile[];
  private readonly choose: (file: TFile) => void;

  constructor(app: App, files: TFile[], choose: (file: TFile) => void) {
    super(app);
    this.files = files;
    this.choose = choose;
    this.setPlaceholder('Open a book in Margin');
  }
  getItems(): TFile[] {
    return this.files;
  }
  getItemText(file: TFile): string {
    return file.path;
  }
  onChooseItem(file: TFile): void {
    this.choose(file);
  }
}
