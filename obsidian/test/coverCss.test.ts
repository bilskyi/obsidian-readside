import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'obsidian/src/shelf/shelf.css'), 'utf8');
const rule = (selector: string) => {
  const m = new RegExp(`(?:^|\\n)${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`no rule ${selector}`);
  return m[1];
};
const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

describe('cover title legibility over a white first page', () => {
  const scrim = rule('.shelf-cover.has-image::after');
  const gradient = /linear-gradient\(to bottom, transparent, rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\) (\d+)%, rgb\(\d+ \d+ \d+ \/ ([\d.]+)\)\)/.exec(scrim)!;
  const [r, g, b] = gradient.slice(1, 4).map(Number);
  const midAlpha = Number(gradient[4]);
  const midStop = Number(gradient[5]) / 100;
  const endAlpha = Number(gradient[6]);
  const inset = Number(/inset:\s*(\d+)% 0 0/.exec(scrim)![1]) / 100;

  it('starts at 25%, about 0.6 alpha by 35% of the scrim, about 0.85 at the foot', () => {
    expect(inset).toBeLessThanOrEqual(0.25);
    expect(midStop).toBeLessThanOrEqual(0.35);
    expect(midAlpha).toBeGreaterThanOrEqual(0.6);
    expect(endAlpha).toBeGreaterThanOrEqual(0.85);
  });

  it('the first line of a three-line title (16px × 1.25 line, 12px padding, 150px cover) has at least 4.5:1 for the light text', () => {
    expect(/-webkit-line-clamp:\s*3/.test(rule('.shelf-cover.has-image .shelf-cover-title'))).toBe(true);
    const height = 150;
    const titleTop = height - 12 - 3 * 16 * 1.25; // 78px
    const t = (titleTop - height * inset) / (height * (1 - inset)); // how far down the scrim
    const alpha = t >= midStop ? midAlpha + ((endAlpha - midAlpha) * (t - midStop)) / (1 - midStop) : (midAlpha * t) / midStop;
    const page = 255 * (1 - alpha);
    const bg = lum(page + r * alpha, page + g * alpha, page + b * alpha);
    const rgbText = /color:\s*#fbfaf7/.test(rule('.shelf-cover-title')) ? lum(0xfb, 0xfa, 0xf7) : 0;
    expect((rgbText + 0.05) / (bg + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});
