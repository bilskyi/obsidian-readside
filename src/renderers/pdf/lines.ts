import { indexText } from './textOffsets';

/** One text line of a rendered text layer: its start offset (the "\n" model) and vertical extent in client coordinates. */
export interface LineBox {
  start: number;
  top: number;
  bottom: number;
}

/**
 * Lines of a pdf.js text layer, in text order. A line starts at offset 0, after every <br> (pdf.js
 * emits one per `hasEOL` item), and where a run's middle sits outside the current line (runs pdf.js
 * didn't mark with an EOL). Whitespace-only runs and runs without a box are skipped.
 */
export function measureLines(container: HTMLElement): LineBox[] {
  const lines: LineBox[] = [];
  let cur: LineBox | null = null;
  let afterBreak = true;
  for (const seg of indexText(container).segments) {
    if (seg.br) {
      afterBreak = true;
      continue;
    }
    if (!seg.node.data.trim()) continue;
    const el = seg.node.parentElement;
    if (!el || el === container) continue;
    const box = el.getBoundingClientRect();
    if (box.height <= 0) continue;
    const mid = (box.top + box.bottom) / 2;
    const outside = cur !== null && Math.abs(mid - (cur.top + cur.bottom) / 2) > (cur.bottom - cur.top) / 2;
    if (afterBreak || cur === null || outside) {
      cur = { start: seg.start, top: box.top, bottom: box.bottom };
      lines.push(cur);
      afterBreak = false;
    } else {
      cur.top = Math.min(cur.top, box.top);
      cur.bottom = Math.max(cur.bottom, box.bottom);
    }
  }
  return lines;
}

/** The line whose box is nearest `y` (distance 0 inside it; the first one on ties); null without lines. */
export function nearestLine(lines: readonly LineBox[], y: number): LineBox | null {
  let best: LineBox | null = null;
  let bestDistance = Infinity;
  for (const l of lines) {
    const d = y < l.top ? l.top - y : y > l.bottom ? y - l.bottom : 0;
    if (d < bestDistance) {
      best = l;
      bestDistance = d;
    }
  }
  return best;
}

/** The line holding text offset `offset`: the last one starting at or before it. */
export function lineAtOffset(lines: readonly LineBox[], offset: number): LineBox | null {
  let hit: LineBox | null = null;
  for (const l of lines) {
    if (l.start > offset) break;
    hit = l;
  }
  return hit;
}
