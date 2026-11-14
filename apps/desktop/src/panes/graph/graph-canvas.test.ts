import { describe, expect, it } from 'vitest';

import { MIN_TEXT_PX, readableFrom } from './graph-canvas';

describe('readableFrom', () => {
  it('is the smallest text size that still reads at a zoom', () => {
    expect(readableFrom([14], 1)).toBe(14);
    expect(readableFrom([16, 25, 48], 1)).toBe(16);
    // At a third of full size, 16 would be about 5 px on screen and 25 about 8.
    expect(readableFrom([16, 25, 48], 0.33)).toBe(25);
    expect(readableFrom([16, 25, 48], 0.2)).toBe(48);
  });

  it('is infinite when nothing reads, so only boxes are drawn', () => {
    expect(readableFrom([14], 0.3)).toBe(Infinity);
    expect(readableFrom([], 1)).toBe(Infinity);
  });

  it('draws text from exactly the smallest size that reads', () => {
    expect(readableFrom([14], MIN_TEXT_PX / 14)).toBe(14);
  });

  it('holds still while the zoom changes a little', () => {
    expect(readableFrom([16, 25], 0.5)).toBe(readableFrom([16, 25], 0.55));
  });
});
