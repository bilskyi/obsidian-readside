import { describe, expect, it } from 'vitest';
import { placeOver } from '../../src/lib/floating';

const bounds = { left: 0, top: 0, right: 400, bottom: 800 };
const size = { width: 200, height: 40 };
const mid = { top: 400, bottom: 420, left: 100, width: 100 };

describe('placeOver', () => {
  it('goes above the selection by default (desktop)', () => {
    const p = placeOver(mid, size, bounds, 8);
    expect(p.below).toBe(false);
    expect(p.top).toBe(400 - 8 - 40);
  });

  it('goes below when it does not fit above', () => {
    const p = placeOver({ ...mid, top: 20, bottom: 40 }, size, bounds, 8);
    expect(p.below).toBe(true);
    expect(p.top).toBe(40 + 8);
  });

  it('with preferBelow (touch) goes below, clear of the handles', () => {
    const p = placeOver(mid, size, bounds, 28, undefined, true);
    expect(p.below).toBe(true);
    expect(p.top).toBe(420 + 28);
  });

  it('with preferBelow goes above when it does not fit below', () => {
    const p = placeOver({ ...mid, top: 740, bottom: 760 }, size, bounds, 28, undefined, true);
    expect(p.below).toBe(false);
    expect(p.top).toBe(740 - 28 - 40);
  });
});
