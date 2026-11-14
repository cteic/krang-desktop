import { describe, expect, it } from 'vitest';

import { segmentHitsRect } from './geometry';
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

describe('a small graph with labelled relations', () => {
  /** As wide as a label of nine letters is drawn. */
  const LABEL = 62;
  // Eight nodes and eleven relations, tangled enough to put lines under boxes.
  const small = ['que', 'clm1', 'clm2', 'hyp', 'res1', 'res2', 'res3', 'exp'].map((id) => node(id));
  const pairs: [string, string][] = [
    ['res1', 'clm1'],
    ['clm1', 'que'],
    ['clm2', 'que'],
    ['que', 'hyp'],
    ['exp', 'res2'],
    ['exp', 'res1'],
    ['exp', 'res3'],
    ['hyp', 'exp'],
    ['res2', 'hyp'],
    ['res3', 'hyp'],
    ['res1', 'hyp'],
  ];
  const labelled: LayoutEdge[] = pairs.map(([source, target]) => ({
    source,
    target,
    labelWidth: LABEL,
  }));

  function middle(rect: Rect): { x: number; y: number } {
    return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  }

  /** How many times a line runs under a box that is at neither of its ends. */
  function linesUnderBoxes(placed: Map<string, Rect>, edges: readonly LayoutEdge[]): number {
    let count = 0;
    for (const edge of edges) {
      const from = middle(must(placed, edge.source));
      const to = middle(must(placed, edge.target));
      for (const [id, rect] of placed) {
        if (id !== edge.source && id !== edge.target && segmentHitsRect(from, to, rect)) {
          count += 1;
        }
      }
    }
    return count;
  }

  /** The clear space between two boxes, sideways and up and down. */
  function gaps(a: Rect, b: Rect): { x: number; y: number } {
    return {
      x: Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)),
      y: Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h)),
    };
  }

  it('leaves room for the label between every two related boxes', () => {
    const placed = layoutGraph(small, labelled, { ...DEFAULT_LAYOUT, aspect: 2 });
    for (const edge of labelled) {
      const gap = gaps(must(placed, edge.source), must(placed, edge.target));
      // Side by side with the label and some line between them, or one above the other.
      expect(gap.x >= LABEL + 30 || gap.y >= 40, `${edge.source} to ${edge.target}`).toBe(true);
    }
    expect(countOverlaps([...placed.values()])).toBe(0);
  });

  it('runs no line under a box that is not its own', () => {
    for (const aspect of [1, 1.41, 2, 2.83]) {
      const placed = layoutGraph(small, labelled, { ...DEFAULT_LAYOUT, aspect });
      expect(linesUnderBoxes(placed, labelled), `aspect ${String(aspect)}`).toBe(0);
    }
  });

  it('keeps the lines of a tree of thirty nodes clear too', () => {
    const tree = Array.from({ length: 30 }, (_, index) =>
      node(`t${String(index).padStart(2, '0')}`),
    );
    const links: LayoutEdge[] = tree.slice(1).map((item, index) => ({
      source: item.id,
      target: `t${String(Math.floor(index / 2)).padStart(2, '0')}`,
      labelWidth: LABEL,
    }));
    const placed = layoutGraph(tree, links, { ...DEFAULT_LAYOUT, aspect: 2 });
    expect(linesUnderBoxes(placed, links)).toBe(0);
    expect(countOverlaps([...placed.values()])).toBe(0);
  });

  it('spreads a few nodes out, so they fill more of a large pane', () => {
    const bounds = boundsOf([
      ...layoutGraph(small, labelled, { ...DEFAULT_LAYOUT, aspect: 2 }).values(),
    ]);
    const bare = boundsOf([
      ...layoutGraph(
        small,
        pairs.map(([source, target]) => ({ source, target })),
        { ...DEFAULT_LAYOUT, aspect: 2 },
      ).values(),
    ]);
    expect(bounds.w * bounds.h).toBeGreaterThan(bare.w * bare.h * 1.3);
    // Not so far that the boxes are lost in it.
    const boxes = small.length * DEFAULT_LAYOUT.nodeWidth * DEFAULT_LAYOUT.nodeHeight;
    expect(boxes / (bounds.w * bounds.h)).toBeGreaterThan(0.1);
  });

  it('is the same picture every time, whatever order the input comes in', () => {
    const first = layoutGraph(small, labelled, { ...DEFAULT_LAYOUT, aspect: 2 });
    expect(entries(layoutGraph(small, labelled, { ...DEFAULT_LAYOUT, aspect: 2 }))).toEqual(
      entries(first),
    );
    expect(
      entries(
        layoutGraph([...small].reverse(), [...labelled].reverse(), {
          ...DEFAULT_LAYOUT,
          aspect: 2,
        }),
      ),
    ).toEqual(entries(first));
  });

  it('adds a node without moving the rest, with room for the label beside it', () => {
    const before = nextLayout(null, small, labelled);
    const after = nextLayout(
      before,
      [...small, node('new')],
      [...labelled, { source: 'new', target: 'clm2', labelWidth: LABEL }],
    );
    for (const item of small) {
      expect(after.rects.get(item.id), item.id).toBe(before.rects.get(item.id));
    }
    const gap = gaps(must(after.rects, 'new'), must(after.rects, 'clm2'));
    expect(gap.x >= LABEL + 30 || gap.y >= 24).toBe(true);
    expect(countOverlaps([...after.rects.values()])).toBe(0);
  });

  it('keeps a big graph quick when its relations carry labels', () => {
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
      labelWidth: LABEL,
    }));
    const started = performance.now();
    const placed = layoutGraph(nodes, edges);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(countOverlaps([...placed.values()])).toBe(0);
  });
});
