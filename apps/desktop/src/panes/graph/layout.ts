import type { Point, Rect } from './geometry';

/**
 * Places the nodes of the "all nodes" view. The same notes and relations
 * always give the same picture: nothing here is random, and the order the
 * input arrives in does not matter.
 *
 * Nodes that relate to each other are pulled into clusters by a spring
 * simulation, one cluster per connected group. Nodes with no relations go
 * in a grid underneath, grouped by type.
 */

export interface LayoutNode {
  id: string;
  /** Orders the grid of unrelated nodes. */
  group: string;
  /** Orders nodes within a group. */
  label: string;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = { nodeWidth: 176, nodeHeight: 60 };

const ITERATIONS = 300;
const SPACING = 88;
/** Boxes are wider than tall, so clusters are stretched sideways to match. */
const STRETCH = 1.9;
const GAP_X = 28;
const GAP_Y = 22;
const CLUSTER_GAP = 70;
const SEPARATION_PASSES = 120;

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** Splits the related nodes into connected groups, largest first. */
function clusters(ids: readonly string[], edges: readonly LayoutEdge[]): string[][] {
  const neighbours = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) {
    neighbours.get(edge.source)?.push(edge.target);
    neighbours.get(edge.target)?.push(edge.source);
  }
  const seen = new Set<string>();
  const found: string[][] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    const members: string[] = [];
    const queue = [id];
    seen.add(id);
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) {
        break;
      }
      members.push(next);
      for (const other of neighbours.get(next) ?? []) {
        if (!seen.has(other)) {
          seen.add(other);
          queue.push(other);
        }
      }
    }
    found.push(members.sort(compareText));
  }
  return found.sort((a, b) => b.length - a.length || compareText(a[0] ?? '', b[0] ?? ''));
}

/** Spring simulation of one cluster. Returns a centre point per member. */
function simulate(members: readonly string[], edges: readonly LayoutEdge[]): Point[] {
  const count = members.length;
  const indexOf = new Map(members.map((id, index) => [id, index]));
  const radius = (SPACING * count) / (2 * Math.PI) + SPACING / 2;
  const points: Point[] = members.map((_, index) => {
    const angle = (2 * Math.PI * index) / count;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
  const links: [number, number][] = [];
  for (const edge of edges) {
    const a = indexOf.get(edge.source);
    const b = indexOf.get(edge.target);
    if (a !== undefined && b !== undefined && a !== b) {
      links.push([a, b]);
    }
  }

  for (let step = 0; step < ITERATIONS; step += 1) {
    const heat = radius * 0.12 * (1 - step / ITERATIONS) + 1;
    const moves: Point[] = points.map(() => ({ x: 0, y: 0 }));
    for (let a = 0; a < count; a += 1) {
      for (let b = a + 1; b < count; b += 1) {
        const pa = points[a];
        const pb = points[b];
        const ma = moves[a];
        const mb = moves[b];
        if (pa === undefined || pb === undefined || ma === undefined || mb === undefined) {
          continue;
        }
        // Two nodes on one spot are nudged apart the same way every time.
        const dx = pa.x - pb.x || 0.01 * (a - b);
        const dy = pa.y - pb.y || 0.01;
        const distance = Math.hypot(dx, dy);
        const push = (SPACING * SPACING) / distance;
        ma.x += (dx / distance) * push;
        ma.y += (dy / distance) * push;
        mb.x -= (dx / distance) * push;
        mb.y -= (dy / distance) * push;
      }
    }
    for (const [a, b] of links) {
      const pa = points[a];
      const pb = points[b];
      const ma = moves[a];
      const mb = moves[b];
      if (pa === undefined || pb === undefined || ma === undefined || mb === undefined) {
        continue;
      }
      const dx = pa.x - pb.x;
      const dy = pa.y - pb.y;
      const distance = Math.hypot(dx, dy) || 0.01;
      const pull = (distance * distance) / SPACING;
      ma.x -= (dx / distance) * pull;
      ma.y -= (dy / distance) * pull;
      mb.x += (dx / distance) * pull;
      mb.y += (dy / distance) * pull;
    }
    points.forEach((point, index) => {
      const move = moves[index];
      if (move === undefined) {
        return;
      }
      const size = Math.hypot(move.x, move.y) || 1;
      const limited = Math.min(size, heat);
      point.x += (move.x / size) * limited;
      point.y += (move.y / size) * limited;
    });
  }
  return points.map((point) => ({ x: point.x * STRETCH, y: point.y }));
}

/** Pushes overlapping boxes apart until none touch, or the passes run out. */
function separate(rects: Rect[]): void {
  for (let pass = 0; pass < SEPARATION_PASSES; pass += 1) {
    let moved = false;
    for (let a = 0; a < rects.length; a += 1) {
      for (let b = a + 1; b < rects.length; b += 1) {
        const ra = rects[a];
        const rb = rects[b];
        if (ra === undefined || rb === undefined) {
          continue;
        }
        const dx = rb.x + rb.w / 2 - (ra.x + ra.w / 2);
        const dy = rb.y + rb.h / 2 - (ra.y + ra.h / 2);
        const overlapX = (ra.w + rb.w) / 2 + GAP_X - Math.abs(dx);
        const overlapY = (ra.h + rb.h) / 2 + GAP_Y - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) {
          continue;
        }
        moved = true;
        if (overlapX < overlapY) {
          const shift = (overlapX / 2 + 0.5) * (dx < 0 ? -1 : 1);
          ra.x -= shift;
          rb.x += shift;
        } else {
          const shift = (overlapY / 2 + 0.5) * (dy < 0 ? -1 : 1);
          ra.y -= shift;
          rb.y += shift;
        }
      }
    }
    if (!moved) {
      return;
    }
  }
}

interface Block {
  ids: string[];
  rects: Rect[];
  w: number;
  h: number;
}

function blockOf(ids: string[], rects: Rect[]): Block {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
  return {
    ids,
    rects: rects.map((rect) => ({ ...rect, x: rect.x - left, y: rect.y - top })),
    w: right - left,
    h: bottom - top,
  };
}

/**
 * Lays out every node. Returns a box per node id. An edge that names a
 * node not in `nodes` is ignored.
 */
export function layoutGraph(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  options: LayoutOptions = DEFAULT_LAYOUT,
): Map<string, Rect> {
  const { nodeWidth, nodeHeight } = options;
  const known = new Set(nodes.map((node) => node.id));
  // Sorted, because the order forces are added up in changes the last few
  // digits of the result, and the picture must not depend on input order.
  const real = edges
    .filter(
      (edge) => known.has(edge.source) && known.has(edge.target) && edge.source !== edge.target,
    )
    .sort((a, b) => compareText(a.source, b.source) || compareText(a.target, b.target));
  const related = new Set(real.flatMap((edge) => [edge.source, edge.target]));
  const relatedIds = [...related].sort(compareText);

  const blocks = clusters(relatedIds, real).map((members) => {
    const rects = simulate(members, real).map((point) => ({
      x: point.x - nodeWidth / 2,
      y: point.y - nodeHeight / 2,
      w: nodeWidth,
      h: nodeHeight,
    }));
    separate(rects);
    return blockOf(members, rects);
  });

  // Clusters go in rows, like words on a page.
  const area = blocks.reduce(
    (sum, block) => sum + (block.w + CLUSTER_GAP) * (block.h + CLUSTER_GAP),
    0,
  );
  const widest = Math.max(0, ...blocks.map((block) => block.w));
  const rowWidth = Math.max(widest, Math.sqrt(area) * 1.5, (nodeWidth + GAP_X) * 4);
  const placed = new Map<string, Rect>();
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const block of blocks) {
    if (x > 0 && x + block.w > rowWidth) {
      x = 0;
      y += rowHeight + CLUSTER_GAP;
      rowHeight = 0;
    }
    block.ids.forEach((id, index) => {
      const rect = block.rects[index];
      if (rect !== undefined) {
        placed.set(id, { ...rect, x: rect.x + x, y: rect.y + y });
      }
    });
    x += block.w + CLUSTER_GAP;
    rowHeight = Math.max(rowHeight, block.h);
  }

  const loose = nodes
    .filter((node) => !related.has(node.id))
    .sort(
      (a, b) =>
        compareText(a.group, b.group) || compareText(a.label, b.label) || compareText(a.id, b.id),
    );
  const gridTop = blocks.length === 0 ? 0 : y + rowHeight + CLUSTER_GAP;
  const columns = Math.max(1, Math.floor((rowWidth + GAP_X) / (nodeWidth + GAP_X)));
  loose.forEach((node, index) => {
    placed.set(node.id, {
      x: (index % columns) * (nodeWidth + GAP_X),
      y: gridTop + Math.floor(index / columns) * (nodeHeight + GAP_Y),
      w: nodeWidth,
      h: nodeHeight,
    });
  });
  return placed;
}
