import { FuzzySuggestModal, Menu, Notice, type App, type TFile } from 'obsidian';
import { COVER_EXTENSIONS, type CoverChoice, type CoverExt } from '../store/types';
import type { CoverManager } from './covers';

/** Whether a vault file can be a cover. */
export const isCoverImage = (f: TFile | null): f is TFile =>
  !!f && (COVER_EXTENSIONS as readonly string[]).includes(f.extension.toLowerCase());

/** MIME type → the extension a pasted image is saved with. */
const PASTE_TYPES: Record<string, CoverExt> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

/** "Choose cover from vault…": the vault's images, fuzzy-searched by path. */
export class CoverImagePicker extends FuzzySuggestModal<TFile> {
  private readonly images: TFile[];
  private readonly onPick: (file: TFile) => void;
  private readonly onDone: (() => void) | undefined;
  constructor(app: App, onPick: (file: TFile) => void, onDone?: () => void) {
    super(app);
    this.onPick = onPick;
    this.onDone = onDone;
    this.images = app.vault.getFiles().filter(isCoverImage).sort((a, b) => b.stat.mtime - a.stat.mtime || a.path.localeCompare(b.path));
    this.setPlaceholder('Choose an image for the cover');
  }
  getItems(): TFile[] {
    return this.images;
  }
  getItemText(file: TFile): string {
    return file.path;
  }
  onChooseItem(file: TFile): void {
    this.onPick(file);
  }
  onClose(): void {
    super.onClose();
    this.onDone?.();
  }
}

/** The first image on the clipboard (a type a cover may be), or null. */
export async function clipboardImage(): Promise<{ data: ArrayBuffer; ext: CoverExt } | null> {
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const type = item.types.find((t) => t in PASTE_TYPES);
    if (!type) continue;
    const blob = await item.getType(type);
    return { data: await blob.arrayBuffer(), ext: PASTE_TYPES[type] };
  }
  return null;
}

export interface CoverMenuBook {
  bookId: string;
  title: string;
}

/** Where the menu opens: at the pointer (right-click) or under the "⋯" button. */
export type MenuAt = { clientX: number; clientY: number } | { x: number; y: number };

const fail = (what: string) => (e: unknown) => new Notice(`Readside couldn't ${what}: ${e instanceof Error ? e.message : String(e)}`);

/** The card's cover menu: choose from the vault, first page, colour tile, paste, reset. */
export function showCoverMenu(app: App, covers: CoverManager, current: CoverChoice | null, book: CoverMenuBook, at: MenuAt, opener?: HTMLElement | null): Menu {
  const menu = new Menu();
  // Keyboard users come back to the "⋯" (or card) they opened the menu from, once the menu or the picker is gone.
  const back = () => {
    if (opener?.isConnected) opener.focus();
  };
  menu.onHide(back);
  const choose = (cover: CoverChoice | null) => void covers.choose(book.bookId, cover).catch(fail('change the cover'));
  menu.addItem((item) =>
    item
      .setTitle('Choose cover from vault…')
      .setIcon('image')
      .onClick(() => new CoverImagePicker(app, (file) => choose({ kind: 'vault', path: file.path }), back).open()),
  );
  menu.addItem((item) =>
    item
      .setTitle('Paste image as cover')
      .setIcon('clipboard-paste')
      .onClick(async () => {
        try {
          const image = await clipboardImage();
          if (!image) {
            new Notice('Readside found no image on the clipboard.');
            return;
          }
          await covers.paste(book.bookId, image.data, image.ext);
        } catch (e) {
          fail('use the pasted image')(e);
        }
      }),
  );
  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle('Use first page')
      .setIcon('file-text')
      .setChecked(current?.kind === 'page')
      .onClick(() => choose({ kind: 'page' })),
  );
  menu.addItem((item) =>
    item
      .setTitle('Use colour tile')
      .setIcon('palette')
      .setChecked(current?.kind === 'tile')
      .onClick(() => choose({ kind: 'tile' })),
  );
  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle('Reset to automatic')
      .setIcon('rotate-ccw')
      .setChecked(current === null)
      .onClick(() => choose(null)),
  );
  // Duck-typed: a popout window's events come from another realm, so `instanceof MouseEvent` would be false.
  if ('clientX' in at) menu.showAtMouseEvent(at as MouseEvent);
  else menu.showAtPosition(at);
  return menu;
}
