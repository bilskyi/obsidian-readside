/**
 * Negative lookbehind without lookbehind syntax. iOS WebKit before 16.4 can't parse `(?<!…)` or `(?<=…)`
 * at all, so one such literal in main.js would stop the whole plugin from loading on those devices.
 *
 * `re` is tried at each position as a regex engine would; a match whose first character comes right after
 * a character matching `notAfter` is skipped and the search resumes one position later, exactly what
 * `(?<!notAfter)re` does.
 */
export function matchesNotAfter(value: string, re: RegExp, notAfter: RegExp): RegExpExecArray[] {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = g.exec(value)) !== null) {
    if (m.index > 0 && notAfter.test(value[m.index - 1])) {
      g.lastIndex = m.index + 1;
      continue;
    }
    out.push(m);
    if (m[0] === '') g.lastIndex++;
  }
  return out;
}

/** `value.replace(/(?<!notAfter)re/g, fn)`, without lookbehind (see matchesNotAfter). */
export function replaceNotAfter(value: string, re: RegExp, notAfter: RegExp, fn: (match: string, ...groups: string[]) => string): string {
  let out = '';
  let at = 0;
  for (const m of matchesNotAfter(value, re, notAfter)) {
    out += value.slice(at, m.index) + fn(m[0], ...m.slice(1));
    at = m.index + m[0].length;
  }
  return out + value.slice(at);
}
