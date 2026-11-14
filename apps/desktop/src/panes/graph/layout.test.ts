import { describe, expect, it } from 'vitest';

import type { Rect } from './geometry';
import { DEFAULT_LAYOUT, layoutGraph } from './layout';
import type { LayoutEdge, LayoutNode } from './layout';

function node(id: string, group = 'a'): LayoutNode {
  return { id, group, label: id };
}

const NODES: LayoutNode[] = [
  node('q'),
  node('c1'),
  node('c2'),
  node('e1'),
  node('e2'),
  node('x1'),
  node('x2'),
  node('lone-b', 'b'),
  node('lone-a2', 'a'),
  node('lone-a1', 'a'),
];

const EDGES: LayoutEdge[] = [
  { source: 'c1', target: 'q' },
  { source: 'c2', target: 'q' },
  { source: 'e1', target: 'c1' },
  { source: 'e2', target: 'c1' },
  { source: 'x1', target: 'x2' },
];

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function entries(placed: Map<string, Rect>): [string, Rect][] {
  return [...placed.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

function must(placed: Map<string, Rect>, id: string): Rect {
  const rect = placed.get(id);
  if (rect === undefined) {
    throw new Error(`${id} was not placed`);
  }
  return rect;
}

describe('layoutGraph', () => {
  it('places every node, with finite positions and the asked size', () => {
    const placed = layoutGraph(NODES, EDGES);
    expect(placed.size).toBe(NODES.length);
    for (const rect of placed.values()) {
      expect(Number.isFinite(rect.x) && Number.isFinite(rect.y)).toBe(true);
      expect(rect.w).toBe(DEFAULT_LAYOUT.nodeWidth);
      expect(rect.h).toBe(DEFAULT_LAYOUT.nodeHeight);
    }
  });

  it('gives the same picture every time', () => {
    expect(entries(layoutGraph(NODES, EDGES))).toEqual(entries(layoutGraph(NODES, EDGES)));
  });

  it('does not depend on the order the notes and relations arrive in', () => {
    const shuffled = [...NODES].reverse();
    const reversed = [...EDGES].reverse();
    expect(entries(layoutGraph(shuffled, reversed))).toEqual(entries(layoutGraph(NODES, EDGES)));
  });

  it('leaves no two boxes overlapping', () => {
    const rects = [...layoutGraph(NODES, EDGES).values()];
    for (let a = 0; a < rects.length; a += 1) {
      for (let b = a + 1; b < rects.length; b += 1) {
        const first = rects[a];
        const second = rects[b];
        expect(first !== undefined && second !== undefined && overlaps(first, second)).toBe(false);
      }
    }
  });

  it('keeps a dense cluster free of overlaps too', () => {
    const hub = Array.from({ length: 24 }, (_, index) =>
      node(`n${String(index).padStart(2, '0')}`),
    );
    const spokes = hub.slice(1).map((item) => ({ source: item.id, target: 'n00' }));
    const rects = [...layoutGraph(hub, spokes).values()];
    let touching = 0;
    for (let a = 0; a < rects.length; a += 1) {
      for (let b = a + 1; b < rects.length; b += 1) {
        const first = rects[a];
        const second = rects[b];
        if (first !== undefined && second !== undefined && overlaps(first, second)) {
          touching += 1;
        }
      }
    }
    expect(touching).toBe(0);
  });

  it('puts related nodes nearer each other than unrelated clusters', () => {
    const placed = layoutGraph(NODES, EDGES);
    const q = must(placed, 'q');
    const c1 = must(placed, 'c1');
    const x1 = must(placed, 'x1');
    const near = Math.hypot(q.x - c1.x, q.y - c1.y);
    const far = Math.hypot(q.x - x1.x, q.y - x1.y);
    expect(near).toBeLessThan(far);
    expect(near).toBeLessThan(500);
  });

  it('puts nodes with no relations in a grid underneath, by group then name', () => {
    const placed = layoutGraph(NODES, EDGES);
    const lowestRelated = Math.max(
      ...['q', 'c1', 'c2', 'e1', 'e2', 'x1', 'x2'].map((id) => {
        const rect = must(placed, id);
        return rect.y + rect.h;
      }),
    );
    const a1 = must(placed, 'lone-a1');
    const a2 = must(placed, 'lone-a2');
    const b = must(placed, 'lone-b');
    expect(a1.y).toBeGreaterThan(lowestRelated);
    expect(a1.y).toBe(a2.y);
    expect(a2.y).toBe(b.y);
    expect(a1.x).toBeLessThan(a2.x);
    expect(a2.x).toBeLessThan(b.x);
  });

  it('copes with no relations, no nodes, and relations to missing nodes', () => {
    expect(layoutGraph([], []).size).toBe(0);
    const alone = layoutGraph([node('a'), node('b')], [{ source: 'a', target: 'ghost' }]);
    expect(must(alone, 'a')).toEqual({ x: 0, y: 0, w: 176, h: 60 });
    expect(must(alone, 'b').y).toBe(0);
    // A relation from a node to itself does not make it "related".
    const loop = layoutGraph([node('a')], [{ source: 'a', target: 'a' }]);
    expect(must(loop, 'a')).toEqual({ x: 0, y: 0, w: 176, h: 60 });
  });
});
