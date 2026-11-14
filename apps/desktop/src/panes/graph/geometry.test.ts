import { describe, expect, it } from 'vitest';

import {
  boundsOf,
  centerOn,
  clipToRect,
  curveHitsRect,
  curvePoint,
  edgeShape,
  fitTransform,
  IDENTITY,
  MAX_ZOOM,
  MIN_ZOOM,
  panBy,
  rectsOverlap,
  revealRect,
  segmentHitsRect,
  zoomAt,
} from './geometry';
import type { Rect } from './geometry';

const LEFT: Rect = { x: 0, y: 0, w: 100, h: 40 };
const RIGHT: Rect = { x: 300, y: 0, w: 100, h: 40 };

function numbers(text: string): number[] {
  return (text.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
}

describe('boundsOf', () => {
  it('is the box around every box', () => {
    expect(boundsOf([LEFT, RIGHT, { x: -50, y: 100, w: 10, h: 10 }])).toEqual({
      x: -50,
      y: 0,
      w: 450,
      h: 110,
    });
  });

  it('is null for nothing', () => {
    expect(boundsOf([])).toBeNull();
  });
});

describe('clipToRect', () => {
  it('finds where a line from the middle leaves the box', () => {
    expect(clipToRect(LEFT, { x: 500, y: 20 })).toEqual({ x: 100, y: 20 });
    expect(clipToRect(LEFT, { x: 50, y: -300 })).toEqual({ x: 50, y: 0 });
    // Towards a corner, the nearer side wins.
    expect(clipToRect(LEFT, { x: 150, y: 120 })).toEqual({ x: 70, y: 40 });
  });

  it('stays in the middle when that is the target', () => {
    expect(clipToRect(LEFT, { x: 50, y: 20 })).toEqual({ x: 50, y: 20 });
  });
});

describe('edgeShape', () => {
  it('draws a straight line from box edge to box edge, stopping at the arrowhead', () => {
    const shape = edgeShape(LEFT, RIGHT);
    expect(shape.path).toBe('M 100 20 L 289 20');
    // The tip touches the target box. The other two corners sit behind it.
    expect(shape.head).toBe('300,20 289,25 289,15');
    expect(shape.label).toEqual({ x: 200, y: 20 });
  });

  it('points the arrowhead at the target whichever way the line runs', () => {
    const shape = edgeShape(RIGHT, LEFT);
    expect(shape.path).toBe('M 300 20 L 111 20');
    expect(numbers(shape.head).slice(0, 2)).toEqual([100, 20]);
  });

  it('bows the line when asked, so two relations between one pair stay apart', () => {
    const up = edgeShape(LEFT, RIGHT, 40);
    const down = edgeShape(LEFT, RIGHT, -40);
    expect(up.path.includes(' Q ')).toBe(true);
    expect(up.label.y).toBeGreaterThan(20);
    expect(down.label.y).toBeLessThan(20);
    expect(up.label.x).toBeCloseTo(200, 0);
  });

  it('draws a relation from a box to itself as a loop above it', () => {
    const shape = edgeShape(LEFT, LEFT);
    expect(shape.path.startsWith('M 60 0 C ')).toBe(true);
    expect(numbers(shape.head).slice(0, 2)).toEqual([90, 0]);
    expect(shape.label.y).toBeLessThan(0);
    expect(numbers(shape.path).every(Number.isFinite)).toBe(true);
  });
});

describe('fitTransform', () => {
  it('centres the drawing and scales it down to fit, with a margin', () => {
    const fit = fitTransform({ x: 0, y: 0, w: 2000, h: 500 }, { w: 1064, h: 800 }, 32);
    expect(fit.k).toBe(0.5);
    expect(fit.x).toBe(32);
    expect(fit.y).toBe(275);
  });

  it('never zooms in past full size', () => {
    const fit = fitTransform({ x: 100, y: 100, w: 50, h: 20 }, { w: 800, h: 600 });
    expect(fit.k).toBe(1);
    expect(fit.x).toBe(275);
    expect(fit.y).toBe(190);
  });

  it('zooms in as far as it is allowed, to fill the pane with a small drawing', () => {
    const fit = fitTransform({ x: 0, y: 0, w: 400, h: 100 }, { w: 828, h: 600 }, 14, 1.25);
    expect(fit.k).toBe(1.25);
    expect(fitTransform({ x: 0, y: 0, w: 400, h: 100 }, { w: 628, h: 600 }, 14, 4).k).toBe(1.5);
  });

  it('does nothing without a drawing or without room', () => {
    expect(fitTransform(null, { w: 800, h: 600 })).toEqual(IDENTITY);
    expect(fitTransform({ x: 0, y: 0, w: 10, h: 10 }, { w: 0, h: 0 })).toEqual(IDENTITY);
  });

  it('stops at the smallest zoom for a huge drawing', () => {
    expect(fitTransform({ x: 0, y: 0, w: 1e7, h: 1e7 }, { w: 800, h: 600 }).k).toBe(MIN_ZOOM);
  });
});

describe('zoomAt', () => {
  it('keeps the point under the pointer still', () => {
    const start = { x: 10, y: 20, k: 1 };
    const point = { x: 110, y: 220 };
    const zoomed = zoomAt(start, point, 2);
    expect(zoomed.k).toBe(2);
    // The drawing point under the pointer is the same before and after.
    expect((point.x - zoomed.x) / zoomed.k).toBe((point.x - start.x) / start.k);
    expect((point.y - zoomed.y) / zoomed.k).toBe((point.y - start.y) / start.k);
  });

  it('stays within the zoom limits', () => {
    expect(zoomAt(IDENTITY, { x: 0, y: 0 }, 1000).k).toBe(MAX_ZOOM);
    expect(zoomAt(IDENTITY, { x: 0, y: 0 }, 0.0001).k).toBe(MIN_ZOOM);
  });
});

describe('centerOn', () => {
  it('puts the middle of a box in the middle of the pane, at the same zoom', () => {
    const moved = centerOn(
      { x: 5, y: 5, k: 2 },
      { x: 100, y: 40, w: 20, h: 20 },
      { w: 800, h: 600 },
    );
    expect(moved).toEqual({ x: 180, y: 200, k: 2 });
    const view = { x: 5, y: 5, k: 2 };
    expect(centerOn(view, { x: 0, y: 0, w: 1, h: 1 }, { w: 0, h: 0 })).toBe(view);
  });
});

describe('panBy and revealRect', () => {
  it('moves the view', () => {
    expect(panBy({ x: 1, y: 2, k: 3 }, 10, -5)).toEqual({ x: 11, y: -3, k: 3 });
  });

  it('leaves the view alone when the box is in sight', () => {
    const view = { x: 0, y: 0, k: 1 };
    expect(revealRect(view, { x: 100, y: 100, w: 50, h: 50 }, { w: 800, h: 600 })).toBe(view);
  });

  it('pans just far enough to show a box that is out of sight', () => {
    const view = { x: 0, y: 0, k: 2 };
    const moved = revealRect(view, { x: 500, y: -40, w: 100, h: 30 }, { w: 800, h: 600 }, 24);
    // Right edge was at 1200, now 24 inside the 800 wide pane. Top was at -80, now at 24.
    expect(moved).toEqual({ x: -424, y: 104, k: 2 });
  });

  it('does nothing in a pane with no size', () => {
    const view = { x: 0, y: 0, k: 1 };
    expect(revealRect(view, { x: 5000, y: 0, w: 1, h: 1 }, { w: 0, h: 0 })).toBe(view);
  });
});

describe('segmentHitsRect', () => {
  const box: Rect = { x: 100, y: 100, w: 100, h: 40 };

  it('is true for a line through a box, into it, or inside it', () => {
    expect(segmentHitsRect({ x: 0, y: 120 }, { x: 300, y: 120 }, box)).toBe(true);
    expect(segmentHitsRect({ x: 150, y: 0 }, { x: 150, y: 110 }, box)).toBe(true);
    expect(segmentHitsRect({ x: 120, y: 110 }, { x: 130, y: 120 }, box)).toBe(true);
    // Corner to corner, across the diagonal.
    expect(segmentHitsRect({ x: 90, y: 90 }, { x: 210, y: 150 }, box)).toBe(true);
  });

  it('is false for a line that passes by or stops short', () => {
    expect(segmentHitsRect({ x: 0, y: 90 }, { x: 300, y: 90 }, box)).toBe(false);
    expect(segmentHitsRect({ x: 0, y: 120 }, { x: 90, y: 120 }, box)).toBe(false);
    expect(segmentHitsRect({ x: 90, y: 0 }, { x: 90, y: 300 }, box)).toBe(false);
    // Past a corner, close but clear.
    expect(segmentHitsRect({ x: 60, y: 100 }, { x: 100, y: 60 }, box)).toBe(false);
  });
});

describe('rectsOverlap', () => {
  it('is true only when two boxes share some area', () => {
    expect(rectsOverlap(LEFT, { x: 90, y: 30, w: 50, h: 50 })).toBe(true);
    expect(rectsOverlap(LEFT, { x: 100, y: 0, w: 50, h: 40 })).toBe(false);
    expect(rectsOverlap(LEFT, RIGHT)).toBe(false);
  });
});

describe('the open part of a line', () => {
  it('runs from the edge of one box to the edge of the other', () => {
    const { curve } = edgeShape(LEFT, RIGHT);
    expect(curve?.start).toEqual({ x: 100, y: 20 });
    expect(curve?.end).toEqual({ x: 300, y: 20 });
    expect(curve === null ? null : curvePoint(curve, 0.5)).toEqual(edgeShape(LEFT, RIGHT).label);
    expect(curve === null ? null : curvePoint(curve, 0)).toEqual({ x: 100, y: 20 });
    expect(curve === null ? null : curvePoint(curve, 1)).toEqual({ x: 300, y: 20 });
  });

  it('knows when it touches a box, bowed or straight', () => {
    const between: Rect = { x: 180, y: 0, w: 40, h: 40 };
    const straight = edgeShape(LEFT, RIGHT).curve;
    const bowed = edgeShape(LEFT, RIGHT, 120).curve;
    expect(straight !== null && curveHitsRect(straight, between)).toBe(true);
    // Bowed by 120, the middle of the line is 60 off the straight one.
    expect(bowed !== null && curveHitsRect(bowed, between)).toBe(false);
  });

  it('has none for a relation from a box to itself', () => {
    expect(edgeShape(LEFT, LEFT).curve).toBeNull();
  });
});
