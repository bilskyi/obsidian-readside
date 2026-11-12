import { describe, expect, it } from 'vitest';
import { FIT_GUTTER } from '../../src/renderers/pdf/layout';
import {
  EPUB_COLUMN,
  epubFit,
  FIT_MAX,
  FIT_MIN,
  NARROW_FIT_SCALE,
  NARROW_MIN_COLUMN,
} from '../../src/renderers/epub/EpubRenderer';

describe('epubFit', () => {
  it('a wide pane: the full column at 100 %', () => {
    expect(epubFit(1200)).toEqual({ scale: FIT_MAX, column: EPUB_COLUMN, narrow: false });
  });

  it('a medium pane: the column scales down to fit', () => {
    const fit = epubFit(600);
    expect(fit.narrow).toBe(false);
    expect(fit.scale).toBeCloseTo((600 - FIT_GUTTER) / EPUB_COLUMN);
    expect(fit.column).toBeCloseTo(600 - FIT_GUTTER);
  });

  it('exactly at FIT_MIN: still the scaled column', () => {
    const fit = epubFit(EPUB_COLUMN * FIT_MIN + FIT_GUTTER);
    expect(fit).toEqual({ scale: FIT_MIN, column: EPUB_COLUMN * FIT_MIN, narrow: false });
  });

  it('a phone (366 px fit area): a narrow column the screen\'s width, text at a readable size', () => {
    const fit = epubFit(366);
    expect(fit).toEqual({ scale: NARROW_FIT_SCALE, column: 366 - FIT_GUTTER, narrow: true });
    // Fits: the lane keeps half a gutter each side.
    expect(fit.column + FIT_GUTTER).toBeLessThanOrEqual(366);
  });

  it('never narrower than NARROW_MIN_COLUMN', () => {
    expect(epubFit(200).column).toBe(NARROW_MIN_COLUMN);
  });

  it('an unmeasured pane (0 wide) keeps the scaled column, not a narrow one', () => {
    expect(epubFit(0).narrow).toBe(false);
  });
});
