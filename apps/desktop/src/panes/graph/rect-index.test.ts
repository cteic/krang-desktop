import { describe, expect, it } from 'vitest';

import { RectIndex } from './rect-index';

describe('RectIndex', () => {
  it('finds a box that overlaps one it holds, near or far from the origin', () => {
    const index = new RectIndex();
    index.add({ x: 0, y: 0, w: 100, h: 40 });
    index.add({ x: -5000, y: 9000, w: 600, h: 40 });
    expect(index.hits({ x: 90, y: 30, w: 50, h: 50 })).toBe(true);
    // A wide box is found from any cell it covers.
    expect(index.hits({ x: -4450, y: 9010, w: 10, h: 10 })).toBe(true);
  });

  it('finds nothing where no box is, and boxes that only touch do not overlap', () => {
    const index = new RectIndex();
    expect(index.hits({ x: 0, y: 0, w: 10, h: 10 })).toBe(false);
    index.add({ x: 0, y: 0, w: 100, h: 40 });
    expect(index.hits({ x: 100, y: 0, w: 20, h: 40 })).toBe(false);
    expect(index.hits({ x: 300, y: 300, w: 20, h: 20 })).toBe(false);
  });
});
