import { describe, expect, it } from 'vitest';

import { columnsFor, isNarrowHeader, NAME_MIN } from './columns';

describe('columnsFor', () => {
  it('shows every column in a wide pane, and before the width is known', () => {
    expect(columnsFor(900)).toEqual({ size: true, modified: true });
    expect(columnsFor(null)).toEqual({ size: true, modified: true });
    expect(columnsFor(0)).toEqual({ size: true, modified: true });
  });

  it('drops the date first, then the size, as the pane narrows', () => {
    expect(columnsFor(383)).toEqual({ size: true, modified: false });
    expect(columnsFor(270)).toEqual({ size: true, modified: false });
    expect(columnsFor(267)).toEqual({ size: false, modified: false });
    expect(columnsFor(120)).toEqual({ size: false, modified: false });
  });

  it('never leaves the name less than its minimum while another column shows', () => {
    const fixed = { kind: 22, size: 58, modified: 116, actions: 78 };
    for (let width = 150; width <= 700; width += 1) {
      const shown = columnsFor(width);
      const taken =
        fixed.kind +
        fixed.actions +
        (shown.size ? fixed.size : 0) +
        (shown.modified ? fixed.modified : 0);
      if (shown.size || shown.modified) {
        expect(width - taken, String(width)).toBeGreaterThanOrEqual(NAME_MIN);
      }
      // The date never shows without the size.
      expect(shown.modified && !shown.size).toBe(false);
    }
  });
});

describe('isNarrowHeader', () => {
  it('is true only for a known, narrow width', () => {
    expect(isNarrowHeader(270)).toBe(true);
    expect(isNarrowHeader(320)).toBe(false);
    expect(isNarrowHeader(null)).toBe(false);
    expect(isNarrowHeader(0)).toBe(false);
  });
});
