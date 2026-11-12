import type { Color } from '../../lib/types';

/** The SVG filter that gives underlines their pencil grain (spec §5.3); defined once per scroller. */
export const PENCIL_FILTER_ID = 'margin-pencil';

/** A little fractal noise displacing the band's edges, like a pencil line on paper. */
export const PENCIL_FILTER_SVG =
  `<filter id="${PENCIL_FILTER_ID}" x="-2%" y="-50%" width="104%" height="200%" color-interpolation-filters="sRGB">` +
  '<feTurbulence type="fractalNoise" baseFrequency="0.9 0.08" numOctaves="2" seed="7" result="grain"/>' +
  '<feDisplacementMap in="SourceGraphic" in2="grain" scale="2.4" xChannelSelector="R" yChannelSelector="G"/>' +
  '</filter>';

/**
 * The hidden <svg class="pdf-defs"> holding the pencil filter, built with DOM APIs from Margin's own
 * markup (never book content): parsed as SVG, then imported, so no innerHTML is involved.
 */
export function pencilDefs(): Element {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'pdf-defs');
  svg.setAttribute('aria-hidden', 'true');
  const parsed = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg"><defs>${PENCIL_FILTER_SVG}</defs></svg>`,
    'image/svg+xml',
  );
  const defs = parsed.documentElement.firstElementChild;
  if (defs && defs.localName === 'defs') svg.appendChild(document.importNode(defs, true));
  return svg;
}

export interface HighlightState {
  /** The pointer is over it. */
  hover: boolean;
  /** Its popover is open or its margin note has focus. */
  active: boolean;
  /** Created moments ago: it inks in. */
  fresh: boolean;
}

/** Class list of one highlight rect. */
export function highlightClass(color: Color, s: HighlightState): string {
  return ['hl', `hl-${color}`, s.hover && 'is-hover', s.active && 'is-active', s.fresh && 'is-new'].filter(Boolean).join(' ');
}

/** Index of the first rect containing (x, y), edges included; -1 when none does. */
export function hitIndex(rects: readonly { left: number; right: number; top: number; bottom: number }[], x: number, y: number): number {
  return rects.findIndex((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
}
