import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSelectors, scopeCss } from '../src/css/scope';

const read = (f: string) => readFileSync(resolve(process.cwd(), 'obsidian/src/css', f), 'utf8');

describe('bridge.css', () => {
  it('maps Margin’s tokens to the Obsidian theme', () => {
    const bridge = read('bridge.css');
    const pairs = [
      ['--window', '--background-primary'],
      ['--surface', '--background-primary'],
      ['--text', '--text-normal'],
      ['--text-2', '--text-muted'],
      ['--separator', '--background-modifier-border'],
      ['--accent', '--interactive-accent'],
      ['--accent-fill', '--interactive-accent'],
      ['--on-accent', '--text-on-accent'],
      ['--hover', '--background-modifier-hover'],
      ['--danger', '--text-error'],
    ];
    for (const [token, obsidian] of pairs) expect(bridge).toMatch(new RegExp(`${token}:\\s*var\\(${obsidian}\\)`));
    expect(bridge).toMatch(/font-family:\s*var\(--font-interface\)/);
    // The desk (behind the pages) is a shade of the theme's background toward its text colour.
    expect(bridge).toMatch(/--desk:\s*color-mix\(in srgb, var\(--background-primary\) 88%, var\(--text-normal\)\)/);
  });

  it('a dark theme gets a desk darker than the page, declared after the shared --desk so it wins', () => {
    const bridge = read('bridge.css');
    const shared = bridge.search(/--desk:\s*color-mix\(in srgb, var\(--background-primary\) 88%/);
    const dark = /\.theme-dark \.margin-app\s*\{[^}]*--desk:\s*color-mix\(in srgb, var\(--background-primary\) 75%, black\)/.exec(bridge);
    expect(shared).toBeGreaterThanOrEqual(0);
    expect(dark).not.toBeNull();
    expect(dark!.index).toBeGreaterThan(shared);
    expect(/\.theme-light \.margin-app\s*\{[^}]*75%, black/.test(bridge)).toBe(false);
  });

  it('surfaces are never darker than the window: light uses the page background, dark lifts it toward the text', () => {
    const bridge = read('bridge.css');
    expect(bridge).not.toMatch(/--surface:\s*var\(--background-secondary\)/);
    expect(bridge).toMatch(/\.theme-dark \.margin-app\s*\{[^}]*--surface:\s*color-mix\(in srgb, var\(--background-primary\) 92%, var\(--text-normal\)\)/);
    expect(/\.theme-light \.margin-app\s*\{[^}]*--surface:/.test(bridge)).toBe(false);
  });

  it('the margin column is a faint ink tint of the page background (97% light, 96% dark), not a slab', () => {
    const bridge = read('bridge.css');
    expect(bridge).toMatch(/\.theme-light \.margin-app\s*\{[^}]*--margin-bg:\s*color-mix\(in srgb, var\(--background-primary\) 97%, var\(--ink\)\)/);
    expect(bridge).toMatch(/\.theme-dark \.margin-app\s*\{[^}]*--margin-bg:\s*color-mix\(in srgb, var\(--background-primary\) 96%, var\(--ink\)\)/);
  });

  it('pressed is a neutral text wash, stronger than Obsidian’s hover and independent of the theme accent', () => {
    const bridge = read('bridge.css');
    const m = /--pressed:\s*color-mix\(in srgb, var\(--text-normal\) (\d+)%, transparent\)/.exec(bridge);
    expect(m).not.toBeNull();
    // Obsidian's --background-modifier-hover is a ~7.5% wash of the text colour.
    expect(Number(m![1])).toBeGreaterThan(10);
  });

  it('leaves the derived focus ring, the note colours and --warning to Margin', () => {
    expect(read('bridge.css')).not.toMatch(/--focus-ring\s*:|--note-[a-z-]+\s*:|--warning\s*:/);
  });

  it('keeps the Marginalia accents: ink, pencil and the highlight palette are not bridged', () => {
    expect(read('bridge.css')).not.toMatch(/--ink\s*:|--pencil\s*:|--hl-[a-z-]+\s*:/);
  });

  it('names both theme classes, so it outranks the .theme-dark .margin-app block', () => {
    expect(listSelectors(read('bridge.css'))).toEqual(expect.arrayContaining(['.theme-light .margin-app', '.theme-dark .margin-app']));
  });
});

describe('reset.css and bridge.css', () => {
  it('style nothing outside .margin-app', () => {
    for (const s of [...listSelectors(read('reset.css')), ...listSelectors(read('bridge.css'))]) {
      expect(s).toMatch(/^(\.theme-(light|dark) )?\.margin-app(?![\w-])/);
    }
  });

  it('reset neutralises Obsidian’s global button and field styles and its .popover / .notice classes', () => {
    const sels = listSelectors(read('reset.css'));
    for (const s of ['.margin-app button', '.margin-app textarea', '.margin-app input', '.margin-app .popover', '.margin-app .notice']) {
      expect(sels).toContain(s);
    }
  });

  it('turns text selection back on for the page text (Obsidian sets body { user-select: none })', () => {
    const css = read('reset.css');
    const rule = /\.margin-app \.textLayer,\s*\.margin-app \.textLayer :is\(span, br\)\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/(^|[\s;])user-select:\s*text/);
    expect(rule![1]).toMatch(/-webkit-user-select:\s*text/);
  });
});

/** Specificity [ids, classes/attributes/pseudo-classes, elements] of a simple selector; :where() counts 0. */
function specificity(sel: string): [number, number, number] {
  let s = sel.replace(/:where\([^)]*\)/g, '').replace(/::[\w-]+/g, ' x');
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length;
  s = s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:[\w-]+(\([^)]*\))?/g, ' ');
  const elements = (s.match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return [ids, classes, elements];
}
const beats = (a: string, b: string) => {
  const [x, y] = [specificity(a), specificity(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false; // a tie goes to the later file: Margin's CSS loads after reset.css
};

describe('reset.css field states', () => {
  const resetSels = listSelectors(read('reset.css'));
  const FIELD_STATES = [
    '.margin-app input:where([type=text], [type=search]):hover',
    '.margin-app textarea:hover',
    '.margin-app input:focus',
    '.margin-app input:focus-visible',
    '.margin-app :where(textarea):focus',
    '.margin-app :where(textarea):focus-visible',
    '.margin-app[data-margin-root]:focus-visible',
  ];

  it('neutralise Obsidian’s hover, focus and root-focus styles', () => {
    for (const s of FIELD_STATES) expect(resetSels).toContain(s);
    // Ties Obsidian's `input[type='text']:focus` (0,2,1) and wins by loading later.
    expect(specificity('.margin-app input:focus')).toEqual([0, 2, 1]);
    expect(specificity("input[type='text']:focus")).toEqual([0, 2, 1]);
    expect(specificity('.margin-app .popover textarea:focus-visible')).toEqual([0, 3, 1]);
    expect(specificity('.margin-app input:where([type=text], [type=search]):hover')).toEqual([0, 2, 1]);
    // Textareas: (0,2,0) beats Obsidian's `textarea:focus` (0,1,1) and no more.
    expect(resetSels).not.toContain('.margin-app textarea:focus');
    expect(resetSels).not.toContain('.margin-app textarea:focus-visible');
    expect(specificity('.margin-app :where(textarea):focus')).toEqual([0, 2, 0]);
    expect(beats('.margin-app :where(textarea):focus', 'textarea:focus')).toBe(true);
    expect(beats('.margin-app :where(textarea):focus-visible', 'textarea:focus-visible')).toBe(true);
  });

  it('a textarea with no ring of its own keeps Margin’s generic focus ring', () => {
    const margin = listSelectors(scopeCss(readFileSync(resolve(process.cwd(), 'src/App.css'), 'utf8')));
    const generic = margin.find((s) => /^\.margin-app :where\([^)]*\btextarea\b[^)]*\):focus-visible$/.test(s));
    expect(generic).toBeDefined();
    for (const r of resetSels.filter((s) => /textarea/.test(s) && !/:hover/.test(s))) expect(beats(r, generic!), `${r} vs ${generic}`).toBe(false);
  });

  it('lose to Margin’s own focus rings and to .page-input’s background', () => {
    const shared = ['App.css', 'features/reader/search/search.css', 'features/notebook/notebook.css', 'features/reader/toolbar/toolbar.css']
      .map((f) => readFileSync(resolve(process.cwd(), 'src', f), 'utf8'))
      .join('\n');
    const margin = listSelectors(scopeCss(shared));
    const rings = [
      '.margin-app .search-field:focus-visible',
      '.margin-app .nb-label-field:focus-visible',
      '.margin-app .page-input:focus-visible',
      '.margin-app .popover textarea:focus-visible',
      '.margin-app .thought-editor:focus-within',
    ];
    for (const ring of rings) {
      expect(margin).toContain(ring);
      for (const r of FIELD_STATES) expect(beats(r, ring), `${r} vs ${ring}`).toBe(false);
    }
    // .page-input has no type attribute, so the typed hover rule cannot reach it at all.
    expect(margin).toContain('.margin-app .page-input');
    const pageInput = readFileSync(resolve(process.cwd(), 'src/features/reader/toolbar/PageNav.tsx'), 'utf8').match(/<input\b(?:(?!\/>)[\s\S])*className="page-input"(?:(?!\/>)[\s\S])*\/>/)![0];
    expect(pageInput).not.toMatch(/\btype=/);
  });
});
