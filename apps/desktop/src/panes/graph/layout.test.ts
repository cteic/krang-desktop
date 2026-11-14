import { describe, expect, it } from 'vitest';

import type { Rect } from './geometry';
import { DEFAULT_LAYOUT, layoutGraph, nextLayout } from './layout';
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

function countOverlaps(rects: readonly Rect[]): number {
  // Sorted by left edge, so each box is only checked against the ones it could reach.
  const sorted = [...rects].sort((a, b) => a.x - b.x);
  let touching = 0;
  for (let a = 0; a < sorted.length; a += 1) {
    const first = sorted[a];
    if (first === undefined) {
      continue;
    }
    for (let b = a + 1; b < sorted.length; b += 1) {
      const second = sorted[b];
      if (second === undefined || second.x >= first.x + first.w) {
        break;
      }
      if (overlaps(first, second)) {
        touching += 1;
      }
    }
  }
  return touching;
}

function boundsOf(rects: readonly Rect[]): Rect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  return {
    x: left,
    y: top,
    w: Math.max(...rects.map((rect) => rect.x + rect.w)) - left,
    h: Math.max(...rects.map((rect) => rect.y + rect.h)) - top,
  };
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

  it('puts related nodes near each other, and keeps each cluster to itself', () => {
    const placed = layoutGraph(NODES, EDGES);
    const q = must(placed, 'q');
    const c1 = must(placed, 'c1');
    expect(Math.hypot(q.x - c1.x, q.y - c1.y)).toBeLessThan(300);
    // The two clusters do not run into each other: there is clear space between them.
    const big = boundsOf(['q', 'c1', 'c2', 'e1', 'e2'].map((id) => must(placed, id)));
    const small = boundsOf(['x1', 'x2'].map((id) => must(placed, id)));
    const apartX = Math.max(small.x - (big.x + big.w), big.x - (small.x + small.w));
    const apartY = Math.max(small.y - (big.y + big.h), big.y - (small.y + small.h));
    expect(Math.max(apartX, apartY)).toBeGreaterThanOrEqual(60);
  });

  it('packs a cluster tightly: its boxes fill a good share of the room it takes', () => {
    const tree = Array.from({ length: 18 }, (_, index) =>
      node(`t${String(index).padStart(2, '0')}`),
    );
    // Three hubs in a chain, each with five leaves.
    const links = tree.slice(1).map((item, index) => ({
      source: item.id,
      target: index < 2 ? 't00' : `t0${String(index % 3)}`,
    }));
    const bounds = boundsOf([...layoutGraph(tree, links).values()]);
    const boxes = tree.length * DEFAULT_LAYOUT.nodeWidth * DEFAULT_LAYOUT.nodeHeight;
    expect(boxes / (bounds.w * bounds.h)).toBeGreaterThan(0.25);
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

describe('a big graph', () => {
  // The same made-up graph every time: 2,000 nodes and 4,000 relations.
  const nodes = Array.from({ length: 2000 }, (_, index) =>
    node(`n${String(index).padStart(4, '0')}`),
  );
  let seed = 7;
  function next(): number {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor((seed / 2147483648) * nodes.length);
  }
  const edges: LayoutEdge[] = Array.from({ length: 4000 }, () => ({
    source: nodes[next()]?.id ?? '',
    target: nodes[next()]?.id ?? '',
  }));

  it('is laid out quickly, the same way every time, with no box on another', () => {
    const started = performance.now();
    const placed = layoutGraph(nodes, edges);
    const took = performance.now() - started;
    // Around a third of a second on a laptop. The bound is loose for a busy machine.
    expect(took).toBeLessThan(5000);
    expect(placed.size).toBe(nodes.length);
    expect(countOverlaps([...placed.values()])).toBe(0);
    expect(entries(layoutGraph([...nodes].reverse(), [...edges].reverse()))).toEqual(
      entries(placed),
    );
  });

  it('takes one more node without moving the rest, and quickly', () => {
    const before = nextLayout(null, nodes, edges);
    const started = performance.now();
    const after = nextLayout(
      before,
      [...nodes, node('new')],
      [...edges, { source: 'new', target: 'n0000' }],
    );
    expect(performance.now() - started).toBeLessThan(2000);
    for (const item of nodes) {
      if (before.linked.has(item.id)) {
        expect(after.rects.get(item.id)).toBe(before.rects.get(item.id));
      }
    }
    expect(countOverlaps([...after.rects.values()])).toBe(0);
  });
});

describe('packing to the shape of the pane', () => {
  // Six separate pairs, so there are clusters to arrange.
  const pairs = Array.from({ length: 12 }, (_, index) =>
    node(`p${String(index).padStart(2, '0')}`),
  );
  const links = Array.from({ length: 6 }, (_, index) => ({
    source: pairs[index * 2]?.id ?? '',
    target: pairs[index * 2 + 1]?.id ?? '',
  }));

  it('spreads the clusters sideways in a wide pane and downwards in a tall one', () => {
    const wide = boundsOf([
      ...layoutGraph(pairs, links, { ...DEFAULT_LAYOUT, aspect: 4 }).values(),
    ]);
    const tall = boundsOf([
      ...layoutGraph(pairs, links, { ...DEFAULT_LAYOUT, aspect: 0.5 }).values(),
    ]);
    expect(wide.w / wide.h).toBeGreaterThan(2);
    expect(tall.w / tall.h).toBeLessThan(1);
  });

  it('shapes one big cluster like the pane as well', () => {
    const hub = Array.from({ length: 30 }, (_, index) =>
      node(`h${String(index).padStart(2, '0')}`),
    );
    const spokes = hub.slice(1).map((item, index) => ({
      source: item.id,
      target: `h${String(Math.floor(index / 4)).padStart(2, '0')}`,
    }));
    const wide = boundsOf([...layoutGraph(hub, spokes, { ...DEFAULT_LAYOUT, aspect: 3 }).values()]);
    const square = boundsOf([
      ...layoutGraph(hub, spokes, { ...DEFAULT_LAYOUT, aspect: 1 }).values(),
    ]);
    expect(wide.w / wide.h).toBeGreaterThan(1.8);
    expect(wide.w / wide.h).toBeGreaterThan(square.w / square.h);
  });

  it('lays the graph out again for a pane of another shape, and not for a small change', () => {
    const wide = nextLayout(null, pairs, links, { ...DEFAULT_LAYOUT, aspect: 4 });
    const tall = nextLayout(wide, pairs, links, { ...DEFAULT_LAYOUT, aspect: 0.5 });
    expect(tall).not.toBe(wide);
    expect(entries(tall.rects)).toEqual(
      entries(layoutGraph(pairs, links, { ...DEFAULT_LAYOUT, aspect: 0.5 })),
    );
    // A small change of shape is not worth moving anything for.
    expect(nextLayout(wide, pairs, links, { ...DEFAULT_LAYOUT, aspect: 4.2 })).toBe(wide);
  });
});

describe('keeping the picture still while the vault changes', () => {
  it('gives back the very same layout when nothing has changed', () => {
    const first = nextLayout(null, NODES, EDGES);
    expect(nextLayout(first, [...NODES].reverse(), [...EDGES].reverse())).toBe(first);
  });

  it('leaves every placed node where it was when a node and a relation are added', () => {
    const before = nextLayout(null, NODES, EDGES);
    const after = nextLayout(
      before,
      [...NODES, node('e3')],
      [...EDGES, { source: 'e3', target: 'c2' }],
    );
    for (const id of ['q', 'c1', 'c2', 'e1', 'e2', 'x1', 'x2']) {
      expect(after.rects.get(id), id).toEqual(before.rects.get(id));
    }
    // The new node is put beside the node it relates to, on no other box.
    const added = must(after.rects, 'e3');
    const anchor = must(after.rects, 'c2');
    expect(Math.hypot(added.x - anchor.x, added.y - anchor.y)).toBeLessThan(260);
    expect(countOverlaps([...after.rects.values()])).toBe(0);
  });

  it('moves a loose node up beside its first relation, and nothing else', () => {
    const before = nextLayout(null, NODES, EDGES);
    const after = nextLayout(before, NODES, [...EDGES, { source: 'lone-b', target: 'q' }]);
    for (const id of ['q', 'c1', 'c2', 'e1', 'e2', 'x1', 'x2']) {
      expect(after.rects.get(id), id).toEqual(before.rects.get(id));
    }
    const joined = must(after.rects, 'lone-b');
    const anchor = must(after.rects, 'q');
    expect(Math.hypot(joined.x - anchor.x, joined.y - anchor.y)).toBeLessThan(260);
    expect(countOverlaps([...after.rects.values()])).toBe(0);
  });

  it('keeps the rest still when a node or a relation goes', () => {
    const before = nextLayout(null, NODES, EDGES);
    const after = nextLayout(
      before,
      NODES.filter((item) => item.id !== 'e2'),
      EDGES.filter((edge) => edge.source !== 'e2'),
    );
    expect(after.rects.has('e2')).toBe(false);
    for (const id of ['q', 'c1', 'c2', 'e1', 'x1', 'x2']) {
      expect(after.rects.get(id), id).toEqual(before.rects.get(id));
    }
  });

  it('puts a new group that touches nothing underneath, clear of the rest', () => {
    const before = nextLayout(null, NODES, EDGES);
    const after = nextLayout(
      before,
      [...NODES, node('y1'), node('y2')],
      [...EDGES, { source: 'y1', target: 'y2' }],
    );
    const lowest = Math.max(
      ...['q', 'c1', 'c2', 'e1', 'e2', 'x1', 'x2'].map((id) => {
        const rect = must(before.rects, id);
        return rect.y + rect.h;
      }),
    );
    expect(must(after.rects, 'y1').y).toBeGreaterThan(lowest);
    expect(countOverlaps([...after.rects.values()])).toBe(0);
  });

  it('does not pack again for another pane shape once a node was added in place', () => {
    const before = nextLayout(null, NODES, EDGES, { ...DEFAULT_LAYOUT, aspect: 4 });
    const grown = nextLayout(
      before,
      [...NODES, node('e3')],
      [...EDGES, { source: 'e3', target: 'c2' }],
      { ...DEFAULT_LAYOUT, aspect: 4 },
    );
    const turned = nextLayout(
      grown,
      [...NODES, node('e3')],
      [...EDGES, { source: 'e3', target: 'c2' }],
      { ...DEFAULT_LAYOUT, aspect: 0.5 },
    );
    expect(turned).toBe(grown);
  });
});
