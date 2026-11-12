import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { MAX_SUGGESTIONS } from '../../src/features/notebook/linkSuggest';
import { suggestNotes } from '../src/linkSuggest';
import MarginPlugin from '../src/main';
import { makeApp, manifest, pdfBytes } from './helpers';

async function vault(paths: string[]): Promise<App> {
  const app = makeApp();
  for (const [i, p] of paths.entries()) {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    if (dir && !app.vault.getFolderByPath(dir)) await app.vault.createFolder(dir);
    const f = await app.vault.create(p, `# ${p}`);
    f.stat.mtime = i + 1;
  }
  app.vault.addBinary('Books/Walden.pdf', pdfBytes());
  return app;
}

describe('suggestNotes: the vault’s notes for [[', () => {
  it('fuzzy-matches note names, best first, and leaves out PDFs and other files', async () => {
    const app = await vault(['Reading/Walden notes.md', 'Walking.md', 'Thoreau.md', 'Inbox/Daily.md']);
    const out = suggestNotes(app, 'wal');
    expect(out.map((s) => s.label)).toEqual(['Walking', 'Walden notes']);
    expect(out.every((s) => s.label !== 'Walden')).toBe(true);
    expect(out[1]).toEqual({ label: 'Walden notes', insert: 'Walden notes', detail: 'Reading' });
    expect(out[0]).toEqual({ label: 'Walking', insert: 'Walking' });
  });

  it('a match in the folder only ranks below any match in the name', async () => {
    const app = await vault(['Thoreau/Journal.md', 'Thoroughfare.md']);
    expect(suggestNotes(app, 'thor').map((s) => s.label)).toEqual(['Thoroughfare', 'Journal']);
  });

  it('inserts the path when two notes share a name, so the link is not ambiguous', async () => {
    const app = await vault(['A/Ideas.md', 'B/Ideas.md']);
    expect(suggestNotes(app, 'ideas').map((s) => s.insert).sort()).toEqual(['A/Ideas', 'B/Ideas']);
  });

  it('a bare [[ lists the most recently changed notes, at most MAX_SUGGESTIONS', async () => {
    const app = await vault(Array.from({ length: 12 }, (_, i) => `N${i}.md`));
    const out = suggestNotes(app, '');
    expect(out).toHaveLength(MAX_SUGGESTIONS);
    expect(out[0].label).toBe('N11');
    expect(out[1].label).toBe('N10');
  });

  it('the plugin hands the view this source', async () => {
    const app = await vault(['Walden notes.md']);
    const plugin = new MarginPlugin(app, manifest);
    expect(plugin.host.linkSuggest?.('wald').map((s) => s.insert)).toEqual(['Walden notes']);
  });
});

describe('suggestNotes: awkward names and per-[[ cost', () => {
  it('a note named with # | ^ [ ] is offered as a Markdown link to its path; others stay wikilinks', async () => {
    const app = await vault(['Dev/C# tips.md', 'Plain.md', 'Q[1] review.md', 'A|B.md', 'x^y.md']);
    const out = suggestNotes(app, '', 10);
    const by = (label: string) => out.find((s) => s.label === label)!;
    expect(by('C# tips').replace).toBe('[C# tips](<Dev/C# tips.md>)');
    expect(by('Q[1] review').replace).toBe('[Q\\[1\\] review](<Q[1] review.md>)');
    expect(by('A|B').replace).toBe('[A|B](<A|B.md>)');
    expect(by('x^y').replace).toBe('[x^y](<x^y.md>)');
    expect(by('Plain').replace).toBeUndefined();
  });

  it('reads the vault’s file list once per session (one [[), not on every keystroke', async () => {
    const app = await vault(['Walden notes.md', 'Walking.md']);
    const files = vi.spyOn(app.vault, 'getMarkdownFiles');
    const session = {};
    suggestNotes(app, 'w', undefined, session);
    suggestNotes(app, 'wa', undefined, session);
    suggestNotes(app, 'wal', undefined, session);
    expect(files).toHaveBeenCalledTimes(1);
    suggestNotes(app, 'w', undefined, {});
    expect(files).toHaveBeenCalledTimes(2);
    const plugin = new MarginPlugin(app, manifest);
    const s2 = {};
    plugin.host.linkSuggest?.('w', s2);
    plugin.host.linkSuggest?.('wa', s2);
    expect(files).toHaveBeenCalledTimes(3);
  });
});
