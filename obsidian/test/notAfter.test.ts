import { describe, expect, it } from 'vitest';
import { matchesNotAfter, replaceNotAfter } from '../../src/lib/notAfter';
import { hugeLength, zoomedLengths } from '../../src/renderers/epub/scopeCss';
import { quoteText } from '../src/mirror/generate';

// The regexes these replaced, with real lookbehind (Node parses it; older iOS WebKit does not).
const OLD_NUMBER_UNIT = /(?<![\w.])([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]*|%)/gi;
const NUMBER_UNIT = /([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]*|%)/gi;
const OLD_ABSOLUTE = /(?<![\w.#-])([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|pt|pc|in|cm|mm|q|rem)(?![\w%-])/gi;
const ABSOLUTE = /([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|pt|pc|in|cm|mm|q|rem)(?![\w%-])/gi;

const SAMPLES = [
  '12px', '1.5em 2px', 'a-1px', 'a12px', '-3.5pt', 'calc(100% - 2rem)', '#1a2b3c 10px', 'x.5px .5px',
  '1e3px', '+4mm 0', 'font-1px', 'url(a1.png) 2px', '--x: 3px', '50%1px', '0.75 1.2', 'h1 12pt', '1px1px',
];

// Deterministic fuzz: strings over the characters that matter here.
function* fuzz(n: number): Generator<string> {
  const chars = 'a1.-+#%e pxtm(),5';
  let seed = 7;
  for (let i = 0; i < n; i++) {
    let s = '';
    const len = 1 + (i % 14);
    for (let j = 0; j < len; j++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      s += chars[seed % chars.length];
    }
    yield s;
  }
}

describe('matchesNotAfter / replaceNotAfter', () => {
  const inputs = [...SAMPLES, ...fuzz(3000)];

  it('finds exactly what the lookbehind regex found', () => {
    for (const s of inputs) {
      const want = [...s.matchAll(OLD_NUMBER_UNIT)].map((m) => [m.index, m[0]]);
      const got = matchesNotAfter(s, NUMBER_UNIT, /[\w.]/).map((m) => [m.index, m[0]]);
      expect(got, s).toEqual(want);
    }
  });

  it('replaces exactly what the lookbehind regex replaced', () => {
    const fn = (_m: string, num: string, unit: string) => `<${num}|${unit}>`;
    for (const s of inputs) {
      expect(replaceNotAfter(s, ABSOLUTE, /[\w.#-]/, fn), s).toBe(s.replace(OLD_ABSOLUTE, fn));
    }
  });

  it('scopeCss helpers keep their results', () => {
    expect(zoomedLengths('margin: 12px a-1px')).toBe('margin: calc(12px * var(--epub-scale)) a-1px');
    expect(hugeLength('width', '99999px')).toBe(true);
    expect(hugeLength('width', '12px')).toBe(false);
  });
});

describe('quoteText', () => {
  it('escapes every [ that follows a [, as before', () => {
    const old = (s: string) => s.replace(/(?<=\[)\[/g, '\\[');
    for (const s of ['[[link]]', '[[[x', 'a [b] [[c', '![[img.png]]', '[', '[][[]']) {
      expect(quoteText(s)).toBe(old(s).replace(/!\[/g, '!\\['));
    }
  });
});
