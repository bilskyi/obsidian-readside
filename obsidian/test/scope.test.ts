import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSelectors, scopeCss } from '../src/css/scope';

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const scoped = (css: string) => squash(scopeCss(css));

describe('scopeCss', () => {
  it(':root becomes .margin-app', () => {
    expect(scoped(':root { --window: #fff; }')).toBe('.margin-app { --window: #fff; }');
  });

  it('the dark color-scheme media goes; its :root becomes .theme-dark .margin-app and its rules follow', () => {
    expect(scoped('@media (prefers-color-scheme: dark) { :root { --window: #000; } .x { color: red; } }')).toBe(
      '.theme-dark .margin-app { --window: #000; } .theme-dark .margin-app .x { color: red; }',
    );
  });

  it('html, body and #root rules are dropped; a mixed list keeps the rest; * is scoped', () => {
    expect(
      scoped('html, body, #root { height: 100%; } body { overflow: hidden; } * { box-sizing: border-box; } html, .x { color: red; }'),
    ).toBe('.margin-app * { box-sizing: border-box; } .margin-app .x { color: red; }');
  });

  it('prefixes every selector, element and class alike, without splitting :where() lists', () => {
    expect(scoped('button, .popover:hover, :where(a, b) .c { color: red; }')).toBe(
      '.margin-app button, .margin-app .popover:hover, .margin-app :where(a, b) .c { color: red; }',
    );
  });

  it('other @media and @supports keep their wrapper and scope their rules', () => {
    expect(
      scoped('@media (prefers-reduced-motion: reduce) { :root { --d: 1ms; } .popover { animation: none; } } @supports (color: AccentColor) { :root { --accent: AccentColor; } }'),
    ).toBe(
      '@media (prefers-reduced-motion: reduce) { .margin-app { --d: 1ms; } .margin-app .popover { animation: none; } } @supports (color: AccentColor) { .margin-app { --accent: AccentColor; } }',
    );
  });

  it('@container keeps its wrapper and scopes its rules like @media, the dark theme inside too', () => {
    expect(scoped('.bar { container: bar / inline-size; } @container bar (max-width: 744px) { .label, :root .x { display: none; } }')).toBe(
      '.margin-app .bar { container: bar / inline-size; } @container bar (max-width: 744px) { .margin-app .label, .margin-app .x { display: none; } }',
    );
    expect(scoped('@media (prefers-color-scheme: dark) { @container bar (max-width: 1px) { .y { color: red; } } }')).toBe(
      '@container bar (max-width: 1px) { .theme-dark .margin-app .y { color: red; } }',
    );
    expect(listSelectors('@container bar (max-width: 1px) { .margin-app .z { color: red; } }')).toEqual(['.margin-app .z']);
  });

  it('renames keyframes and the animations that use them, not look-alike custom properties', () => {
    expect(
      scoped('@keyframes note-in { from { opacity: 0; } to { opacity: 1; } } .n { animation: note-in var(--dur-med) var(--ease-out); --note-in-x: 1; } .m { animation-name: note-in, other; }'),
    ).toBe(
      '@keyframes margin-note-in { from { opacity: 0; } to { opacity: 1; } } .margin-app .n { animation: margin-note-in var(--dur-med) var(--ease-out); --note-in-x: 1; } .margin-app .m { animation-name: margin-note-in, other; }',
    );
  });

  it('comments go; braces inside strings survive', () => {
    expect(scoped('.a::before { content: "}{"; } /* .b { */ .c { color: red; }')).toBe(
      '.margin-app .a::before { content: "}{"; } .margin-app .c { color: red; }',
    );
  });

  it('handles minified input', () => {
    expect(scoped(':root{--a:1}@media (prefers-color-scheme:dark){:root{--a:2}}.b{color:red}')).toBe(
      '.margin-app {--a:1} .theme-dark .margin-app {--a:2} .margin-app .b {color:red}',
    );
  });

  it('leaves selectors that are already scoped alone', () => {
    expect(scoped('.margin-app .x { color: red; }')).toBe('.margin-app .x { color: red; }');
  });

  it('scoping every stylesheet under src/ leaves nothing outside .margin-app', () => {
    const root = resolve(process.cwd(), 'src');
    const css = (readdirSync(root, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.css'))
      .sort()
      .map((f) => readFileSync(join(root, f), 'utf8'))
      .join('\n');
    const out = scopeCss(css);
    const sels = listSelectors(out);
    expect(sels.length).toBeGreaterThan(50);
    for (const s of sels) expect(s).toMatch(/^(\.theme-dark )?\.margin-app(?![\w-])/);
    expect(out).not.toMatch(/:root|prefers-color-scheme/);
    for (const m of out.matchAll(/@(?:-webkit-)?keyframes\s+([^\s{]+)/g)) expect(m[1].startsWith('margin-')).toBe(true);
    for (const s of sels) expect(s).not.toMatch(/^(\.theme-dark )?\.margin-app (html|body|#root)(?![\w-])/);
  });
});
