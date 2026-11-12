import { Notice, Platform, PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
import { formatMB } from '../../src/translate/format';
import { LANGUAGES, languageName, pickDefaultTarget } from '../../src/translate/languages';

export interface MarginSettings {
  /** Keep a Markdown note per book with its notebook (spec §6). */
  mirrorEnabled: boolean;
  /** Vault folder of those notes ('' = the vault root). */
  mirrorFolder: string;
  /** Switch PDFs that open in Obsidian's viewer to Margin. */
  openPdfsInMargin: boolean;
  /** The language Translate turns text into (a catalog code, spec §A5). */
  translateTarget: string;
  /** ⌥-hover translates the word under the pointer (Settings → Translation). */
  translateHover: boolean;
}

const systemLanguage = (): string | undefined => (typeof navigator === 'undefined' ? undefined : navigator.language);

export const DEFAULT_SETTINGS: MarginSettings = {
  mirrorEnabled: true,
  mirrorFolder: 'Margin',
  openPdfsInMargin: false,
  translateTarget: pickDefaultTarget(systemLanguage()),
  translateHover: true,
};

const TARGETS = new Set(LANGUAGES.map((l) => l.code));

/**
 * The translation settings as loaded (data.json may be old, hand-edited or synced from elsewhere): a
 * target the catalog doesn't have becomes the closest match to the system language; a hover value that
 * is not a boolean becomes on. Returns whether anything changed.
 */
export function normalizeTranslationSettings(s: MarginSettings, navigatorLanguage: string | undefined = systemLanguage()): boolean {
  let changed = false;
  if (typeof s.translateTarget !== 'string' || !TARGETS.has(s.translateTarget)) {
    s.translateTarget = pickDefaultTarget(navigatorLanguage);
    changed = true;
  }
  if (typeof s.translateHover !== 'boolean') {
    s.translateHover = true;
    changed = true;
  }
  return changed;
}

/** What the Translation section needs from the plugin's translate host. */
export interface TranslationSettingsSource {
  installedSizes(): Promise<{ key: string; bytes: number }[]>;
  engineSize(): Promise<number | null>;
  downloading(key?: string): boolean;
  removePair(key: string): Promise<void>;
  removeAll(): Promise<void>;
}

const LANG = '[a-z]{2,3}(?:-[A-Z][a-z]{3})?';
const PAIR = new RegExp(`^(${LANG})-(${LANG})$`);

/** `uk-en` → `Українська → English` (the key itself if it isn't a pair key). */
export function pairTitle(key: string): string {
  const m = PAIR.exec(key);
  return m ? `${languageName(m[1])} → ${languageName(m[2])}` : key;
}

/** How long "Click again to remove all" waits for the second click. */
export const REMOVE_ALL_CONFIRM_MS = 3000;
export const NOTHING_DOWNLOADED = 'Nothing downloaded yet. Select text in a book and press L to translate it.';

/** `' Reading / Margin/ '` → `'Reading/Margin'`; `.` and `..` segments are dropped. */
export const normalizeFolder = (folder: string): string =>
  folder
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/');

/**
 * Why a (normalised) notebook folder can't be used, or null: Obsidian neither shows nor indexes hidden
 * folders, and the config folder is Obsidian's own.
 */
export function folderError(folder: string, configDir: string): string | null {
  const config = normalizeFolder(configDir);
  if (config && (folder === config || folder.startsWith(`${config}/`))) return `Notes can’t go inside Obsidian’s config folder (${config}).`;
  if (folder.split('/').some((s) => s.startsWith('.'))) return 'Notes can’t go in a folder whose name starts with a dot: Obsidian hides it.';
  return null;
}

/** How long the folder field waits after the last keystroke before it applies (or on blur, at once). */
export const FOLDER_APPLY_DELAY_MS = 800;

export interface SettingsHost extends Plugin {
  settings: MarginSettings;
  saveSettings(): Promise<void>;
  /** The translate host (null once the plugin is unloading). */
  translation?: () => TranslationSettingsSource | null;
}

export class MarginSettingTab extends PluginSettingTab {
  private readonly host: SettingsHost;
  private folderTimer: ReturnType<typeof setTimeout> | null = null;
  /** Applies what the folder field holds now (blur, the pause after typing, closing the tab). */
  private applyFolder: (() => Promise<void>) | null = null;

  constructor(app: App, host: SettingsHost) {
    super(app, host);
    this.host = host;
  }

  private cancelFolderApply(): void {
    if (this.folderTimer) clearTimeout(this.folderTimer);
    this.folderTimer = null;
  }

  hide(): void {
    // Closing settings mid-pause still applies what was typed.
    if (this.folderTimer) void this.applyFolder?.();
    super.hide();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.replaceChildren();
    const s = this.host.settings;
    const save = () => this.host.saveSettings();
    new Setting(containerEl)
      .setName('Notebook notes')
      .setDesc('Keep a Markdown note of each book’s highlights and thoughts in your vault. Margin rewrites it; edits made in the note are kept in a copy.')
      .addToggle((t) =>
        t.setValue(s.mirrorEnabled).onChange(async (v) => {
          s.mirrorEnabled = v;
          await save();
        }),
      );
    const folderDesc = 'Where the notebook notes go. Leave empty for the vault root.';
    const folderSetting = new Setting(containerEl).setName('Notebook notes folder').setDesc(folderDesc);
    folderSetting.addText((t) => {
      // Applied after a pause or on blur, never per keystroke: a half-typed name would become a folder.
      const apply = async () => {
        this.cancelFolderApply();
        const folder = normalizeFolder(t.getValue());
        const error = folderError(folder, this.app.vault.configDir);
        folderSetting.setDesc(error ? `${error} Still using “${s.mirrorFolder || '/'}”.` : folderDesc);
        if (error || folder === s.mirrorFolder) return;
        s.mirrorFolder = folder;
        await save();
      };
      this.applyFolder = apply;
      t.setPlaceholder('Margin')
        .setValue(s.mirrorFolder)
        .onChange(() => {
          this.cancelFolderApply();
          this.folderTimer = setTimeout(() => void apply(), FOLDER_APPLY_DELAY_MS);
        });
      t.inputEl.addEventListener('blur', () => void apply());
    });
    new Setting(containerEl)
      .setName('Open PDFs in Margin')
      .setDesc('Use Margin instead of Obsidian’s PDF viewer whenever a PDF opens. Off: PDFs open in Obsidian’s viewer, and “Open in Margin” is in the file menu and the command palette. EPUBs always open in Margin.')
      .addToggle((t) =>
        t.setValue(s.openPdfsInMargin).onChange(async (v) => {
          s.openPdfsInMargin = v;
          await save();
        }),
      );
    this.displayTranslation(containerEl);
  }

  /** Settings → Translation (spec §A5): target, ⌥-hover, and what is downloaded. */
  private displayTranslation(containerEl: HTMLElement): void {
    const s = this.host.settings;
    const save = () => this.host.saveSettings();
    new Setting(containerEl).setName('Translation').setHeading();
    new Setting(containerEl)
      .setName('Translate to')
      .setDesc('The language Translate turns text into. You can pick another one for a single translation from the card.')
      .addDropdown((d) => {
        for (const l of LANGUAGES) d.addOption(l.code, l.name);
        d.setValue(s.translateTarget).onChange(async (v) => {
          if (!TARGETS.has(v)) return;
          s.translateTarget = v;
          await save();
        });
      });
    const key = Platform.isMacOS ? '⌥' : 'Alt';
    new Setting(containerEl)
      .setName(`${key}-hover translates words`)
      .setDesc(`Hold ${key} and point at a word to see its translation. Works for languages you have downloaded.`)
      .addToggle((t) =>
        t.setValue(s.translateHover).onChange(async (v) => {
          s.translateHover = v;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName('Downloaded languages')
      .setDesc('Translation runs on this computer. Each language pair is downloaded once, when you first use it.');
    const list = document.createElement('div');
    list.className = 'margin-translation-downloads';
    containerEl.appendChild(list);
    void this.renderDownloads(list);
  }

  /** The downloaded pairs (each with its size and Remove), the engine's size and Remove all. */
  async renderDownloads(list: HTMLElement): Promise<void> {
    const source = this.host.translation?.() ?? null;
    if (!source) {
      list.replaceChildren();
      return;
    }
    let pairs: { key: string; bytes: number }[];
    let engine: number | null;
    try {
      [pairs, engine] = await Promise.all([source.installedSizes(), source.engineSize()]);
    } catch (e) {
      list.replaceChildren();
      new Setting(list).setName("Margin couldn't read its downloads").setDesc(e instanceof Error ? e.message : String(e));
      return;
    }
    list.replaceChildren();
    const rerender = () => void this.renderDownloads(list);
    const run = async (button: { setDisabled(d: boolean): unknown }, action: () => Promise<void>, what = 'it') => {
      button.setDisabled(true);
      try {
        await action();
      } catch (e) {
        new Notice(`Margin couldn't remove ${what}: ${e instanceof Error ? e.message : String(e)}`);
      }
      rerender();
    };
    if (!pairs.length && engine === null) {
      new Setting(list).setDesc(NOTHING_DOWNLOADED);
      return;
    }
    for (const p of pairs) {
      const busy = source.downloading(p.key);
      new Setting(list)
        .setName(pairTitle(p.key))
        .setDesc(busy ? `${formatMB(p.bytes)} MB, in use by a download` : `${formatMB(p.bytes)} MB`)
        .addButton((b) =>
          b
            .setButtonText('Remove')
            .setDisabled(busy)
            .onClick(() => run(b, () => source.removePair(p.key))),
        );
    }
    if (!pairs.length) new Setting(list).setDesc('No language pairs downloaded.');
    if (engine !== null) {
      new Setting(list)
        .setName('Translation engine')
        .setDesc(`${formatMB(engine)} MB, shared by every language pair. It is removed with the last pair.`);
    }
    const busy = source.downloading();
    let armed: ReturnType<typeof setTimeout> | null = null;
    new Setting(list)
      .setName('Remove all')
      .setDesc(busy ? 'Available when the download has finished.' : 'Removes every language pair and the engine. They download again when you next translate.')
      .addButton((b) =>
        b
          .setButtonText('Remove all')
          .setWarning()
          .setDisabled(busy)
          .onClick(() => {
            // Two steps: the first click asks, a second within a few seconds removes.
            if (!armed) {
              armed = setTimeout(() => {
                armed = null;
                b.setButtonText('Remove all');
              }, REMOVE_ALL_CONFIRM_MS);
              b.setButtonText('Click again to remove all');
              return;
            }
            clearTimeout(armed);
            armed = null;
            return run(b, () => source.removeAll(), 'the downloads');
          }),
      );
  }
}
