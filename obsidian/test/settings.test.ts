import { describe, expect, it, vi } from 'vitest';
import { App, Plugin, PluginSettingTab, Setting, type TextComponent, type ToggleComponent } from 'obsidian';
import { DEFAULT_SETTINGS, folderError, FOLDER_APPLY_DELAY_MS, MarginSettingTab, normalizeFolder, type SettingsHost } from '../src/settings';
import { manifest } from './helpers';

function tab() {
  const app = new App();
  const host = Object.assign(new Plugin(app, manifest), { settings: { ...DEFAULT_SETTINGS }, saveSettings: vi.fn(async () => {}) }) as unknown as SettingsHost & {
    saveSettings: ReturnType<typeof vi.fn>;
  };
  const t = new MarginSettingTab(app, host);
  t.display();
  const setting = (name: string) => Setting.all.find((s) => s.name === name)!;
  return { host, setting, t };
}

describe('settings tab', () => {
  it('shows the three settings with their current values', () => {
    const { setting } = tab();
    expect((setting('Notebook notes').components[0] as ToggleComponent).getValue()).toBe(true);
    expect((setting('Notebook notes folder').components[0] as TextComponent).getValue()).toBe('Readside');
    expect((setting('Open PDFs in Readside').components[0] as ToggleComponent).getValue()).toBe(false);
  });

  it('saves each change', async () => {
    const { host, setting } = tab();
    await (setting('Notebook notes').components[0] as ToggleComponent).toggle(false);
    await (setting('Open PDFs in Readside').components[0] as ToggleComponent).toggle(true);
    expect(host.settings).toMatchObject({ mirrorEnabled: false, openPdfsInMargin: true });
    expect(host.saveSettings).toHaveBeenCalledTimes(2);
  });

  it('stores the folder normalised, on blur', async () => {
    const { host, setting } = tab();
    const text = setting('Notebook notes folder').components[0] as TextComponent;
    await text.type(' Reading / ./Readside/.. / ');
    expect(host.settings.mirrorFolder).toBe('Readside');
    text.inputEl.dispatchEvent(new Event('blur'));
    await vi.waitFor(() => expect(host.settings.mirrorFolder).toBe('Reading/Readside'));
    expect(host.saveSettings).toHaveBeenCalledTimes(1);
    expect(normalizeFolder('\\a\\\\b/')).toBe('a/b');
    expect(normalizeFolder('./../a/./b/..')).toBe('a/b');
  });

  it('applies the folder only after a pause in typing, never per keystroke', async () => {
    vi.useFakeTimers();
    try {
      const { host, setting } = tab();
      const text = setting('Notebook notes folder').components[0] as TextComponent;
      await text.type('R');
      await text.type('Re');
      await vi.advanceTimersByTimeAsync(FOLDER_APPLY_DELAY_MS - 1);
      await text.type('Reading');
      await vi.advanceTimersByTimeAsync(FOLDER_APPLY_DELAY_MS - 1);
      expect(host.saveSettings).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(host.settings.mirrorFolder).toBe('Reading');
      expect(host.saveSettings).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closing settings mid-pause applies what was typed', async () => {
    const { host, setting, t } = tab();
    await (setting('Notebook notes folder').components[0] as TextComponent).type('Later');
    t.hide();
    await vi.waitFor(() => expect(host.settings.mirrorFolder).toBe('Later'));
  });

  it('hide() hands on to PluginSettingTab.hide', () => {
    const { t } = tab();
    const parent = vi.spyOn(PluginSettingTab.prototype, 'hide');
    try {
      t.hide();
      expect(parent).toHaveBeenCalledTimes(1);
    } finally {
      parent.mockRestore();
    }
  });

  it('refuses the config folder and dot folders: the description says why, the previous folder stays', async () => {
    const { host, setting } = tab();
    const s = setting('Notebook notes folder');
    const text = s.components[0] as TextComponent;
    for (const bad of ['.obsidian', '.obsidian/plugins/x', '.hidden', 'Notes/.private']) {
      await text.type(bad);
      text.inputEl.dispatchEvent(new Event('blur'));
      await Promise.resolve();
      expect(host.settings.mirrorFolder).toBe('Readside');
      expect(s.desc).toMatch(/config folder|starts with a dot/);
      expect(s.desc).toContain('Still using “Readside”');
    }
    expect(folderError('.obsidian/x', '.obsidian')).toMatch(/config folder/);
    expect(folderError('Custom/conf', 'Custom/conf')).toMatch(/config folder/);
    expect(folderError('Reading', '.obsidian')).toBeNull();
    await text.type('Reading');
    text.inputEl.dispatchEvent(new Event('blur'));
    await vi.waitFor(() => expect(host.settings.mirrorFolder).toBe('Reading'));
    expect(s.desc).toBe('Where the notebook notes go. Leave empty for the vault root.');
    expect(host.saveSettings).toHaveBeenCalledTimes(1);
  });
});

// ---- T7: Settings → Translation ----
import { ButtonComponent, DropdownComponent, Notice } from 'obsidian';
import { LANGUAGES, pickDefaultTarget } from '../../src/translate/languages';
import { NOTHING_DOWNLOADED, normalizeTranslationSettings, pairTitle, type MarginSettings, type TranslationSettingsSource } from '../src/settings';

class FakeSource implements TranslationSettingsSource {
  pairs: { key: string; bytes: number }[] = [];
  engine: number | null = null;
  busy = new Set<string>();
  removed: string[] = [];
  fail: string | null = null;
  async installedSizes() {
    return this.pairs.map((p) => ({ ...p }));
  }
  async engineSize() {
    return this.engine;
  }
  downloading(key?: string) {
    return key === undefined ? this.busy.size > 0 : this.busy.has(key);
  }
  async removePair(key: string) {
    if (this.fail) throw new Error(this.fail);
    this.removed.push(key);
    this.pairs = this.pairs.filter((p) => p.key !== key);
    if (!this.pairs.length) this.engine = null;
  }
  async removeAll() {
    this.removed.push('*');
    this.pairs = [];
    this.engine = null;
  }
}

function translationTab(source: FakeSource | null, settings: Partial<MarginSettings> = {}) {
  const app = new App();
  const host = Object.assign(new Plugin(app, manifest), {
    settings: { ...DEFAULT_SETTINGS, ...settings },
    saveSettings: vi.fn(async () => {}),
    translation: () => source,
  }) as unknown as SettingsHost & { saveSettings: ReturnType<typeof vi.fn> };
  const t = new MarginSettingTab(app, host);
  t.display();
  const setting = (name: string) => Setting.all.find((s) => s.name === name);
  const list = () => t.containerEl.querySelector('.margin-translation-downloads')!;
  const inList = () => Setting.all.filter((s) => list().contains(s.settingEl));
  return { host, setting, t, list, inList };
}

describe('settings: translation defaults (T7)', () => {
  it('the default target is the closest catalog match to the system language; hover is on', () => {
    expect(DEFAULT_SETTINGS.translateTarget).toBe(pickDefaultTarget(navigator.language));
    expect(DEFAULT_SETTINGS.translateHover).toBe(true);
  });

  it('a stored target the catalog lacks, or none, becomes the system default; a valid one is kept', () => {
    const s = { ...DEFAULT_SETTINGS, translateTarget: 'xx' };
    expect(normalizeTranslationSettings(s, 'uk-UA')).toBe(true);
    expect(s.translateTarget).toBe('uk');
    const none = { ...DEFAULT_SETTINGS, translateTarget: undefined as unknown as string, translateHover: 'yes' as unknown as boolean };
    expect(normalizeTranslationSettings(none, 'de-AT')).toBe(true);
    expect(none).toMatchObject({ translateTarget: 'de', translateHover: true });
    const kept = { ...DEFAULT_SETTINGS, translateTarget: 'fr', translateHover: false };
    expect(normalizeTranslationSettings(kept, 'uk-UA')).toBe(false);
    expect(kept).toMatchObject({ translateTarget: 'fr', translateHover: false });
  });

  it('pair titles use endonyms', () => {
    expect(pairTitle('uk-en')).toBe('Українська → English');
    expect(pairTitle('bogus')).toBe('bogus');
  });
});

describe('settings tab: Translation (T7)', () => {
  it('has a Translation heading, "Translate to" with every catalog language by endonym, and the hover toggle', async () => {
    const { setting, host } = translationTab(new FakeSource(), { translateTarget: 'uk' });
    expect(setting('Translation')?.heading).toBe(true);
    const dd = setting('Translate to')!.components[0] as DropdownComponent;
    expect(dd.options).toEqual(LANGUAGES.map((l) => ({ value: l.code, label: l.name })));
    expect(dd.options.find((o) => o.value === 'uk')?.label).toBe('Українська');
    expect(dd.getValue()).toBe('uk');
    await dd.choose('de');
    expect(host.settings.translateTarget).toBe('de');
    expect(host.saveSettings).toHaveBeenCalledTimes(1);
    const hover = setting('⌥-hover translates words')!.components[0] as ToggleComponent;
    expect(hover.getValue()).toBe(true);
    await hover.toggle(false);
    expect(host.settings.translateHover).toBe(false);
    expect(host.saveSettings).toHaveBeenCalledTimes(2);
  });

  it('says "Nothing downloaded yet" when nothing is', async () => {
    const { inList } = translationTab(new FakeSource());
    await vi.waitFor(() => expect(inList().map((s) => s.desc)).toEqual([NOTHING_DOWNLOADED]));
    expect(NOTHING_DOWNLOADED.startsWith('Nothing downloaded yet')).toBe(true);
  });

  it('lists each pair with its size and Remove, the engine size and Remove all; Remove removes and redraws', async () => {
    const source = new FakeSource();
    source.pairs = [
      { key: 'en-uk', bytes: 35_538_228 },
      { key: 'uk-en', bytes: 21_941_581 },
    ];
    source.engine = 4_960_506;
    const { inList } = translationTab(source);
    await vi.waitFor(() => expect(inList().length).toBe(4));
    expect(inList().map((s) => [s.name, s.desc.split(',')[0]])).toEqual([
      ['English → Українська', '35.5 MB'],
      ['Українська → English', '21.9 MB'],
      ['Translation engine', '5 MB'],
      ['Remove all', expect.any(String)],
    ]);
    const remove = inList()[1].components[0] as ButtonComponent;
    expect(remove.text).toBe('Remove');
    await remove.click();
    expect(source.removed).toEqual(['uk-en']);
    await vi.waitFor(() => expect(inList().map((s) => s.name)).toEqual(['English → Українська', 'Translation engine', 'Remove all']));
    // Copy: sentence case, no all-caps words.
    const translation = Setting.all.slice(Setting.all.findIndex((s) => s.name === 'Translation'));
    expect(translation.length).toBeGreaterThan(5);
    for (const s of translation) expect(`${s.name} ${s.desc}`).not.toMatch(/\b[A-Z]{3,}\b/);
  });

  it('Remove all removes everything and shows the empty state', async () => {
    const source = new FakeSource();
    source.pairs = [{ key: 'uk-en', bytes: 21_941_581 }];
    source.engine = 4_960_506;
    const { inList } = translationTab(source);
    await vi.waitFor(() => expect(inList().length).toBe(3));
    const all = inList()[2].components[0] as ButtonComponent;
    expect(all.text).toBe('Remove all');
    await all.click(); // the first click asks
    expect(all.text).toBe('Click again to remove all');
    expect(source.removed).toEqual([]);
    await all.click();
    expect(source.removed).toEqual(['*']);
    await vi.waitFor(() => expect(inList().map((s) => s.desc)).toEqual([NOTHING_DOWNLOADED]));
  });

  it('while a download runs, the pair it needs and Remove all are disabled', async () => {
    const source = new FakeSource();
    source.pairs = [
      { key: 'en-de', bytes: 10_000_000 },
      { key: 'uk-en', bytes: 21_941_581 },
    ];
    source.engine = 4_960_506;
    source.busy.add('en-de');
    const { inList } = translationTab(source);
    await vi.waitFor(() => expect(inList().length).toBe(4));
    const [ende, uken, , all] = inList();
    expect((ende.components[0] as ButtonComponent).disabled).toBe(true);
    expect((uken.components[0] as ButtonComponent).disabled).toBe(false);
    expect((all.components[0] as ButtonComponent).disabled).toBe(true);
    await (ende.components[0] as ButtonComponent).click();
    expect(source.removed).toEqual([]);
  });

  it('a failed Remove says why and the list stays', async () => {
    const source = new FakeSource();
    source.pairs = [{ key: 'uk-en', bytes: 21_941_581 }];
    source.fail = 'disk says no';
    const { inList } = translationTab(source);
    await vi.waitFor(() => expect(inList().length).toBe(2));
    await (inList()[0].components[0] as ButtonComponent).click();
    expect(Notice.messages).toContain("Readside couldn't remove it: disk says no");
    await vi.waitFor(() => expect(inList().map((s) => s.name)[0]).toBe('Українська → English'));
  });

  it('without a translate host (unloading) the list is empty', async () => {
    const { list, setting } = translationTab(null);
    await Promise.resolve();
    expect(list().childElementCount).toBe(0);
    expect(setting('Translate to')).toBeTruthy();
  });
});

// ---- T7 review fixes ----
import { REMOVE_ALL_CONFIRM_MS } from '../src/settings';

describe('Settings → Translation: two-step Remove all (T7 review)', () => {
  it('the first click only asks; without a second click within the wait it goes back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const source = new FakeSource();
      source.pairs = [{ key: 'uk-en', bytes: 21_941_581 }];
      source.engine = 4_960_506;
      const { inList } = translationTab(source);
      await vi.waitFor(() => expect(inList().length).toBe(3));
      const all = inList()[2].components[0] as ButtonComponent;
      await all.click();
      expect(all.text).toBe('Click again to remove all');
      vi.advanceTimersByTime(REMOVE_ALL_CONFIRM_MS - 1);
      expect(all.text).toBe('Click again to remove all');
      vi.advanceTimersByTime(1);
      expect(all.text).toBe('Remove all');
      await all.click(); // asks again, does not remove
      expect(source.removed).toEqual([]);
      expect(REMOVE_ALL_CONFIRM_MS).toBe(3000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed Remove all says "Readside couldn\'t remove the downloads: …"', async () => {
    const source = new FakeSource();
    source.pairs = [{ key: 'uk-en', bytes: 21_941_581 }];
    source.removeAll = async () => {
      throw new Error('disk says no');
    };
    const { inList } = translationTab(source);
    await vi.waitFor(() => expect(inList().length).toBe(2));
    const all = inList()[1].components[0] as ButtonComponent;
    await all.click();
    await all.click();
    expect(Notice.messages).toContain("Readside couldn't remove the downloads: disk says no");
  });

  it('copy uses a straight apostrophe', async () => {
    const source = new FakeSource();
    source.installedSizes = async () => {
      throw new Error('nope');
    };
    const { inList } = translationTab(source);
    await vi.waitFor(() => expect(inList().map((s) => s.name)).toEqual(["Readside couldn't read its downloads"]));
  });
});
