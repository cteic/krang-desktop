import type { Point, Rect } from './geometry';

/**
 * Places the nodes of the "all nodes" view. The same notes and relations
 * always give the same picture: nothing here is random, and the order the
 * input arrives in does not matter.
 *
 * Nodes that relate to each other are pulled into clusters by a spring
 * simulation, one cluster per connected group. Each cluster is squeezed
 * into the room its boxes need, and the clusters are packed into rows,
 * both to match the shape of the pane. Nodes with no relations go
 * in a grid underneath, grouped by type.
 *
 * When the vault changes while a picture is on screen, the nodes already
 * placed stay where they are and new ones are put next to what they
 * relate to. See `nextLayout`.
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
  /** The pane's width over its height. The clusters are packed to match. */
  aspect?: number;
}

/** A layout that is kept between reads of the vault. */
export interface KeptLayout {
  /** Names the nodes and relations the layout was made for. */
  key: string;
  /** The pane shape the clusters were packed for, in half-octave steps. */
  aspectStep: number;
  rects: Map<string, Rect>;
  /** The nodes that had a relation, and so a place in a cluster. */
  linked: Set<string>;
  /**
   * True once a node has been added in place. The picture then stays as it
   * is when the pane changes shape, because laying it out again would move
   * every node.
   */
  pinned: boolean;
}

interface Block {
  ids: string[];
  rects: Rect[];
  w: number;
  h: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = { nodeWidth: 176, nodeHeight: 60 };

const DEFAULT_ASPECT = 1.6;
const MIN_ASPECT = 0.4;
const MAX_ASPECT = 5;
const ITERATIONS = 300;
const SPACING = 88;
/**
 * How much room a cluster is given before its boxes are pushed apart, as
 * a multiple of the room the boxes themselves take. Less packs the boxes
 * tighter and puts more lines across boxes.
 */
const CLUSTER_SLACK = 1;
/** The narrowest and widest shape a cluster is asked to take. */
const MIN_CLUSTER_ASPECT = 1.2;
const MAX_CLUSTER_ASPECT = 3.5;
/** A graph with more related nodes than this is laid out once, not twice. */
const RETRY_LIMIT = 600;
/** How far off the pane's shape a first layout may be, as a log ratio, before a second try. */
const RETRY_TOLERANCE = 0.14;
const MIN_RETRY_ASPECT = 0.7;
const GAP_X = 24;
const GAP_Y = 24;
const CLUSTER_GAP = 72;
const SEPARATION_PASSES = 120;
/**
 * A cluster up to this size has every pair of nodes pushed apart. A bigger
 * one only pushes apart the nodes that are near each other, which keeps
 * the work in step with the number of nodes instead of its square.
 */
const EXACT_LIMIT = 160;
/** The work a big cluster's simulation may do, in node steps. */
const STEP_BUDGET = 120_000;
const MIN_ITERATIONS = 30;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const PACK_STEPS = 32;
/** How far out from its neighbours a new node looks for a free place, in boxes. */
const SEARCH_RINGS = 24;
const CELL_OFFSET = 32768;

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function cellKey(cx: number, cy: number): number {
  const x = Math.min(Math.max(cx + CELL_OFFSET, 0), 65535);
  const y = Math.min(Math.max(cy + CELL_OFFSET, 0), 65535);
  return x * 65536 + y;
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
    for (let head = 0; head < queue.length; head += 1) {
      const next = queue[head];
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

function linksOf(members: readonly string[], edges: readonly LayoutEdge[]): [number, number][] {
  const indexOf = new Map(members.map((id, index) => [id, index]));
  const links: [number, number][] = [];
  for (const edge of edges) {
    const a = indexOf.get(edge.source);
    const b = indexOf.get(edge.target);
    if (a !== undefined && b !== undefined && a !== b) {
      links.push([a, b]);
    }
  }
  return links;
}

function pull(points: readonly Point[], moves: readonly Point[], links: [number, number][]): void {
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
    const force = (distance * distance) / SPACING;
    ma.x -= (dx / distance) * force;
    ma.y -= (dy / distance) * force;
    mb.x += (dx / distance) * force;
    mb.y += (dy / distance) * force;
  }
}

/**
 * The pull of a big cluster's relations. It grows with distance only up
 * to a point, so a tangle of long relations does not drag every node into
 * one heap.
 */
function pullGently(
  points: readonly Point[],
  moves: readonly Point[],
  links: [number, number][],
): void {
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
    const force = Math.min(distance, SPACING * 3);
    ma.x -= (dx / distance) * force;
    ma.y -= (dy / distance) * force;
    mb.x += (dx / distance) * force;
    mb.y += (dy / distance) * force;
  }
}

function push(points: readonly Point[], moves: readonly Point[], a: number, b: number): void {
  const pa = points[a];
  const pb = points[b];
  const ma = moves[a];
  const mb = moves[b];
  if (pa === undefined || pb === undefined || ma === undefined || mb === undefined) {
    return;
  }
  // Two nodes on one spot are nudged apart the same way every time.
  const dx = pa.x - pb.x || 0.01 * (a - b);
  const dy = pa.y - pb.y || 0.01;
  const distance = Math.hypot(dx, dy);
  const force = (SPACING * SPACING) / distance;
  ma.x += (dx / distance) * force;
  ma.y += (dy / distance) * force;
  mb.x -= (dx / distance) * force;
  mb.y -= (dy / distance) * force;
}

function step(points: readonly Point[], moves: readonly Point[], heat: number): void {
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

/** Spring simulation of a small cluster, with every pair pushed apart. */
function simulateExact(count: number, links: [number, number][]): Point[] {
  const radius = (SPACING * count) / (2 * Math.PI) + SPACING / 2;
  const points: Point[] = Array.from({ length: count }, (_, index) => {
    const angle = (2 * Math.PI * index) / count;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
  for (let round = 0; round < ITERATIONS; round += 1) {
    const heat = radius * 0.12 * (1 - round / ITERATIONS) + 1;
    const moves: Point[] = points.map(() => ({ x: 0, y: 0 }));
    for (let a = 0; a < count; a += 1) {
      for (let b = a + 1; b < count; b += 1) {
        push(points, moves, a, b);
      }
    }
    pull(points, moves, links);
    step(points, moves, heat);
  }
  return points;
}

/** The members in the order a walk outwards from the busiest one meets them. */
function walkOrder(count: number, links: [number, number][]): number[] {
  const neighbours: number[][] = Array.from({ length: count }, () => []);
  for (const [a, b] of links) {
    neighbours[a]?.push(b);
    neighbours[b]?.push(a);
  }
  let start = 0;
  neighbours.forEach((list, index) => {
    if (list.length > (neighbours[start]?.length ?? 0)) {
      start = index;
    }
  });
  const seen = new Set([start]);
  const order = [start];
  for (let head = 0; head < order.length; head += 1) {
    const next = order[head];
    if (next === undefined) {
      break;
    }
    for (const other of [...(neighbours[next] ?? [])].sort((a, b) => a - b)) {
      if (!seen.has(other)) {
        seen.add(other);
        order.push(other);
      }
    }
  }
  return order;
}

/**
 * Spring simulation of a big cluster. It starts from a spiral that already
 * has related nodes near each other, runs fewer rounds the more nodes
 * there are, and pushes apart only the nodes that share a neighbourhood.
 */
function simulateNear(count: number, links: [number, number][]): Point[] {
  const points: Point[] = Array.from({ length: count }, () => ({ x: 0, y: 0 }));
  walkOrder(count, links).forEach((member, rank) => {
    const point = points[member];
    if (point !== undefined) {
      const radius = SPACING * 0.9 * Math.sqrt(rank);
      point.x = Math.cos(rank * GOLDEN_ANGLE) * radius;
      point.y = Math.sin(rank * GOLDEN_ANGLE) * radius;
    }
  });
  const rounds = Math.min(
    ITERATIONS,
    Math.max(MIN_ITERATIONS, Math.round(STEP_BUDGET / Math.max(count, 1))),
  );
  const reach = SPACING * 2;
  for (let round = 0; round < rounds; round += 1) {
    const heat = SPACING * (1 - round / rounds) + 1;
    const moves: Point[] = points.map(() => ({ x: 0, y: 0 }));
    const cells = new Map<number, number[]>();
    points.forEach((point, index) => {
      const key = cellKey(Math.floor(point.x / reach), Math.floor(point.y / reach));
      const cell = cells.get(key);
      if (cell === undefined) {
        cells.set(key, [index]);
      } else {
        cell.push(index);
      }
    });
    for (let a = 0; a < count; a += 1) {
      const pa = points[a];
      if (pa === undefined) {
        continue;
      }
      const cx = Math.floor(pa.x / reach);
      const cy = Math.floor(pa.y / reach);
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oy = -1; oy <= 1; oy += 1) {
          for (const b of cells.get(cellKey(cx + ox, cy + oy)) ?? []) {
            const pb = points[b];
            if (b > a && pb !== undefined && Math.hypot(pa.x - pb.x, pa.y - pb.y) < reach) {
              push(points, moves, a, b);
            }
          }
        }
      }
    }
    pullGently(points, moves, links);
    step(points, moves, heat);
  }
  return points;
}

/**
 * Spring simulation of one cluster. Returns a centre point per member.
 * The simulation has no idea how big a box is, so its result is then
 * scaled to the room the boxes need, in the shape asked for: `aspect` is
 * the width over the height the cluster should have.
 */
function simulate(
  members: readonly string[],
  edges: readonly LayoutEdge[],
  options: LayoutOptions,
  aspect: number,
): Point[] {
  const links = linksOf(members, edges);
  const points =
    members.length <= EXACT_LIMIT
      ? simulateExact(members.length, links)
      : simulateNear(members.length, links);
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  const wide = Math.max(right - left, 1);
  const high = Math.max(bottom - top, 1);
  // A cluster that came out taller than wide is laid on its side.
  const turn = high > wide;
  const room =
    members.length * (options.nodeWidth + GAP_X) * (options.nodeHeight + GAP_Y) * CLUSTER_SLACK;
  const scaleX = Math.sqrt(room * aspect) / (turn ? high : wide);
  const scaleY = Math.sqrt(room / aspect) / (turn ? wide : high);
  return points.map((point) => ({
    x: (turn ? point.y - top : point.x - left) * scaleX,
    y: (turn ? point.x - left : point.y - top) * scaleY,
  }));
}

/** Moves two boxes apart if they are closer than the gaps allow. True when it did. */
function part(ra: Rect, rb: Rect): boolean {
  const dx = rb.x + rb.w / 2 - (ra.x + ra.w / 2);
  const dy = rb.y + rb.h / 2 - (ra.y + ra.h / 2);
  const overlapX = (ra.w + rb.w) / 2 + GAP_X - Math.abs(dx);
  const overlapY = (ra.h + rb.h) / 2 + GAP_Y - Math.abs(dy);
  if (overlapX <= 0 || overlapY <= 0) {
    return false;
  }
  // Measured in boxes, so a wide box is as ready to move sideways as up or down.
  if (overlapX / (ra.w + GAP_X) < overlapY / (ra.h + GAP_Y)) {
    const shift = (overlapX / 2 + 0.5) * (dx < 0 ? -1 : 1);
    ra.x -= shift;
    rb.x += shift;
  } else {
    const shift = (overlapY / 2 + 0.5) * (dy < 0 ? -1 : 1);
    ra.y -= shift;
    rb.y += shift;
  }
  return true;
}

/** Pushes overlapping boxes apart until none touch, or the passes run out. */
function separate(rects: Rect[]): void {
  for (let pass = 0; pass < SEPARATION_PASSES; pass += 1) {
    let moved = false;
    for (let a = 0; a < rects.length; a += 1) {
      for (let b = a + 1; b < rects.length; b += 1) {
        const ra = rects[a];
        const rb = rects[b];
        if (ra !== undefined && rb !== undefined && part(ra, rb)) {
          moved = true;
        }
      }
    }
    if (!moved) {
      return;
    }
  }
}

/**
 * Gives each node of a big cluster a cell of its own on a lattice: the
 * free cell nearest where the simulation left it, the middle of the
 * cluster first. No two boxes can then overlap, however tangled the
 * cluster is, and the work stays small.
 */
function snapToLattice(points: readonly Point[], options: LayoutOptions): Rect[] {
  const cellW = options.nodeWidth + GAP_X;
  const cellH = options.nodeHeight + GAP_Y;
  const count = Math.max(points.length, 1);
  const middle = {
    x: points.reduce((sum, point) => sum + point.x, 0) / count,
    y: points.reduce((sum, point) => sum + point.y, 0) / count,
  };
  const order = points
    .map((point, index) => ({ index, far: Math.hypot(point.x - middle.x, point.y - middle.y) }))
    .sort((a, b) => a.far - b.far || a.index - b.index);
  const taken = new Set<number>();
  const rects: Rect[] = points.map(() => ({
    x: 0,
    y: 0,
    w: options.nodeWidth,
    h: options.nodeHeight,
  }));
  for (const { index } of order) {
    const point = points[index];
    const rect = rects[index];
    if (point === undefined || rect === undefined) {
      continue;
    }
    const homeX = Math.round(point.x / cellW);
    const homeY = Math.round(point.y / cellH);
    let found: Point | null = null;
    for (let ring = 0; found === null; ring += 1) {
      let nearest = Infinity;
      for (let ox = -ring; ox <= ring; ox += 1) {
        for (let oy = -ring; oy <= ring; oy += 1) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== ring) {
            continue;
          }
          if (taken.has(cellKey(homeX + ox, homeY + oy))) {
            continue;
          }
          const far = Math.hypot((homeX + ox) * cellW - point.x, (homeY + oy) * cellH - point.y);
          if (far < nearest) {
            nearest = far;
            found = { x: homeX + ox, y: homeY + oy };
          }
        }
      }
    }
    taken.add(cellKey(found.x, found.y));
    rect.x = found.x * cellW - options.nodeWidth / 2;
    rect.y = found.y * cellH - options.nodeHeight / 2;
  }
  return rects;
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

function clusterBlock(
  members: string[],
  edges: readonly LayoutEdge[],
  options: LayoutOptions,
  aspect: number,
): Block {
  const points = simulate(members, edges, options, aspect);
  if (members.length > EXACT_LIMIT) {
    return blockOf(members, snapToLattice(points, options));
  }
  const rects = points.map((point) => ({
    x: point.x - options.nodeWidth / 2,
    y: point.y - options.nodeHeight / 2,
    w: options.nodeWidth,
    h: options.nodeHeight,
  }));
  separate(rects);
  return blockOf(members, rects);
}

interface Packing {
  /** Where each block's top left corner goes. */
  places: Point[];
  w: number;
  h: number;
}

/** Puts the blocks in rows no wider than `rowWidth`, like words on a page. */
function packRows(blocks: readonly Block[], rowWidth: number): Packing {
  const places: Point[] = [];
  const rows: { from: number; to: number; y: number; h: number }[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let rowStart = 0;
  let width = 0;
  blocks.forEach((block, index) => {
    if (x > 0 && x + block.w > rowWidth) {
      rows.push({ from: rowStart, to: index, y, h: rowHeight });
      x = 0;
      y += rowHeight + CLUSTER_GAP;
      rowHeight = 0;
      rowStart = index;
    }
    places.push({ x, y });
    width = Math.max(width, x + block.w);
    x += block.w + CLUSTER_GAP;
    rowHeight = Math.max(rowHeight, block.h);
  });
  rows.push({ from: rowStart, to: blocks.length, y, h: rowHeight });
  // A short block sits in the middle of its row's height.
  for (const row of rows) {
    for (let index = row.from; index < row.to; index += 1) {
      const place = places[index];
      const block = blocks[index];
      if (place !== undefined && block !== undefined) {
        place.y = row.y + (row.h - block.h) / 2;
      }
    }
  }
  return { places, w: width, h: blocks.length === 0 ? 0 : y + rowHeight };
}

/**
 * Packs the blocks into the rows that fill a pane of the given shape best:
 * the row width whose packing can be drawn largest.
 */
function pack(blocks: readonly Block[], aspect: number): Packing {
  const widest = Math.max(0, ...blocks.map((block) => block.w));
  const total = blocks.reduce((sum, block) => sum + block.w + CLUSTER_GAP, 0);
  if (blocks.length === 0 || widest <= 0) {
    return packRows(blocks, widest);
  }
  let best = packRows(blocks, widest);
  let bestScale = Math.min(aspect / Math.max(best.w, 1), 1 / Math.max(best.h, 1));
  const ratio = Math.max(total / widest, 1);
  for (let index = 1; index <= PACK_STEPS; index += 1) {
    const packing = packRows(blocks, widest * ratio ** (index / PACK_STEPS));
    const scale = Math.min(aspect / Math.max(packing.w, 1), 1 / Math.max(packing.h, 1));
    if (scale > bestScale * 1.0001) {
      best = packing;
      bestScale = scale;
    }
  }
  return best;
}

function aspectOf(options: LayoutOptions): number {
  const aspect = options.aspect ?? DEFAULT_ASPECT;
  if (!Number.isFinite(aspect) || aspect <= 0) {
    return DEFAULT_ASPECT;
  }
  return Math.min(Math.max(aspect, MIN_ASPECT), MAX_ASPECT);
}

function aspectStepOf(options: LayoutOptions): number {
  return Math.round(Math.log2(aspectOf(options)) * 2);
}

/** Puts the nodes with no relations in a grid under everything placed so far. */
function placeLoose(
  placed: Map<string, Rect>,
  loose: readonly string[],
  options: LayoutOptions,
): void {
  if (loose.length === 0) {
    return;
  }
  const { nodeWidth, nodeHeight } = options;
  const cellW = nodeWidth + GAP_X;
  const cellH = nodeHeight + GAP_Y;
  let left = 0;
  let top = 0;
  let columns = Math.ceil(Math.sqrt((loose.length * aspectOf(options) * cellH) / cellW));
  if (placed.size > 0) {
    let right = -Infinity;
    let bottom = -Infinity;
    left = Infinity;
    for (const rect of placed.values()) {
      left = Math.min(left, rect.x);
      right = Math.max(right, rect.x + rect.w);
      bottom = Math.max(bottom, rect.y + rect.h);
    }
    top = bottom + CLUSTER_GAP;
    columns = Math.max(4, Math.floor((right - left + GAP_X) / cellW));
  }
  loose.forEach((id, index) => {
    placed.set(id, {
      x: left + (index % Math.max(columns, 1)) * cellW,
      y: top + Math.floor(index / Math.max(columns, 1)) * cellH,
      w: nodeWidth,
      h: nodeHeight,
    });
  });
}

function arrange(
  blocks: readonly Block[],
  loose: readonly string[],
  options: LayoutOptions,
): Map<string, Rect> {
  const packing = pack(blocks, aspectOf(options));
  const placed = new Map<string, Rect>();
  blocks.forEach((block, index) => {
    const place = packing.places[index];
    if (place === undefined) {
      return;
    }
    block.ids.forEach((id, member) => {
      const rect = block.rects[member];
      if (rect !== undefined) {
        placed.set(id, { ...rect, x: rect.x + place.x, y: rect.y + place.y });
      }
    });
  });
  placeLoose(placed, loose, options);
  return placed;
}

interface Input {
  key: string;
  /** The relations between two different known nodes, in a fixed order. */
  real: LayoutEdge[];
  linked: Set<string>;
  /** The linked nodes, in id order. */
  linkedIds: string[];
  loose: string[];
}

function read(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Input {
  const known = new Set(nodes.map((node) => node.id));
  // Sorted, because the order forces are added up in changes the last few
  // digits of the result, and the picture must not depend on input order.
  const real = edges
    .filter(
      (edge) => known.has(edge.source) && known.has(edge.target) && edge.source !== edge.target,
    )
    .sort((a, b) => compareText(a.source, b.source) || compareText(a.target, b.target));
  const linked = new Set(real.flatMap((edge) => [edge.source, edge.target]));
  const sorted = [...nodes].sort(
    (a, b) =>
      compareText(a.group, b.group) || compareText(a.label, b.label) || compareText(a.id, b.id),
  );
  const loose = sorted.filter((node) => !linked.has(node.id)).map((node) => node.id);
  const key = [
    sorted.map((node) => `${node.id}\u0001${node.group}\u0001${node.label}`).join('\u0000'),
    real.map((edge) => `${edge.source}\u0001${edge.target}`).join('\u0000'),
  ].join('\u0002');
  return { key, real, linked, linkedIds: [...linked].sort(compareText), loose };
}

/**
 * The shape each cluster should take for the clusters to fill the pane
 * together. One big cluster takes the pane's own shape. Several of a size
 * sit side by side, so each takes a share of the width, and when that
 * would make them too narrow they go in more rows instead.
 */
function clusterAspect(groups: readonly string[][], options: LayoutOptions): number {
  const total = groups.reduce((sum, group) => sum + group.length, 0);
  const squares = groups.reduce((sum, group) => sum + group.length * group.length, 0);
  // How many clusters there are, counting a small one as part of one.
  const count = squares === 0 ? 1 : (total * total) / squares;
  const pane = aspectOf(options);
  const rows = Math.max(1, Math.ceil((MIN_CLUSTER_ASPECT * count) / pane));
  return Math.min(Math.max((pane * rows) / count, MIN_CLUSTER_ASPECT), MAX_CLUSTER_ASPECT);
}

/** How large a packing can be drawn in a pane of the given shape. Bigger is better. */
function scaleOf(packing: Packing, pane: number): number {
  return Math.min(pane / Math.max(packing.w, 1), 1 / Math.max(packing.h, 1));
}

function fresh(input: Input, options: LayoutOptions): KeptLayout {
  const groups = clusters(input.linkedIds, input.real);
  const pane = aspectOf(options);
  const aspect = clusterAspect(groups, options);
  let blocks = groups.map((members) => clusterBlock(members, input.real, options, aspect));
  // The shape asked of the clusters is an estimate. Small clusters and the
  // gaps between clusters throw it off, so a graph small enough to lay out
  // twice is tried once more with the estimate corrected, and the better
  // of the two is kept.
  const packing = pack(blocks, pane);
  const got = packing.w / Math.max(packing.h, 1);
  if (
    blocks.length > 0 &&
    input.linkedIds.length <= RETRY_LIMIT &&
    Math.abs(Math.log(got / pane)) > RETRY_TOLERANCE
  ) {
    const corrected = Math.min(
      Math.max((aspect * pane) / got, MIN_RETRY_ASPECT),
      MAX_CLUSTER_ASPECT,
    );
    const again = groups.map((members) => clusterBlock(members, input.real, options, corrected));
    if (scaleOf(pack(again, pane), pane) > scaleOf(packing, pane)) {
      blocks = again;
    }
  }
  return {
    key: input.key,
    aspectStep: aspectStepOf(options),
    rects: arrange(blocks, input.loose, options),
    linked: input.linked,
    pinned: false,
  };
}

/** Finds boxes near a point quickly: each box is filed under the cells it covers. */
class Occupied {
  private readonly cells = new Map<number, Rect[]>();
  private readonly cellW: number;
  private readonly cellH: number;

  constructor(options: LayoutOptions) {
    this.cellW = options.nodeWidth + GAP_X;
    this.cellH = options.nodeHeight + GAP_Y;
  }

  private keys(rect: Rect): number[] {
    const keys: number[] = [];
    const fromX = Math.floor((rect.x - GAP_X) / this.cellW);
    const toX = Math.floor((rect.x + rect.w + GAP_X) / this.cellW);
    const fromY = Math.floor((rect.y - GAP_Y) / this.cellH);
    const toY = Math.floor((rect.y + rect.h + GAP_Y) / this.cellH);
    for (let cx = fromX; cx <= toX; cx += 1) {
      for (let cy = fromY; cy <= toY; cy += 1) {
        keys.push(cellKey(cx, cy));
      }
    }
    return keys;
  }

  add(rect: Rect): void {
    for (const key of this.keys(rect)) {
      const cell = this.cells.get(key);
      if (cell === undefined) {
        this.cells.set(key, [rect]);
      } else {
        cell.push(rect);
      }
    }
  }

  /** True when a box here would be closer to another than the gaps allow. */
  blocks(rect: Rect): boolean {
    for (const key of this.keys(rect)) {
      for (const other of this.cells.get(key) ?? []) {
        const dx = Math.abs(other.x + other.w / 2 - (rect.x + rect.w / 2));
        const dy = Math.abs(other.y + other.h / 2 - (rect.y + rect.h / 2));
        if (dx < (other.w + rect.w) / 2 + GAP_X && dy < (other.h + rect.h) / 2 + GAP_Y) {
          return true;
        }
      }
    }
    return false;
  }
}

/** The steps out from a point to try, nearest first, always in the same order. */
function searchSteps(options: LayoutOptions): Point[] {
  const cellW = options.nodeWidth + GAP_X;
  const cellH = options.nodeHeight + GAP_Y;
  const steps: Point[] = [];
  for (let ix = -SEARCH_RINGS; ix <= SEARCH_RINGS; ix += 1) {
    for (let iy = -SEARCH_RINGS; iy <= SEARCH_RINGS; iy += 1) {
      steps.push({ x: ix * cellW, y: iy * cellH });
    }
  }
  return steps.sort(
    (a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y) || a.y - b.y || a.x - b.x,
  );
}

function boundsOfAll(rects: Iterable<Rect>): Rect {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.w);
    bottom = Math.max(bottom, rect.y + rect.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * Lays out a changed graph without moving what is already on screen. A
 * node that had a place in a cluster keeps it. A new node, or one that
 * has just gained its first relation, goes in the free place nearest the
 * middle of the nodes it relates to. A new group that touches nothing on
 * screen is laid out on its own and put underneath.
 */
function extend(previous: KeptLayout, input: Input, options: LayoutOptions): KeptLayout {
  const placed = new Map<string, Rect>();
  const occupied = new Occupied(options);
  for (const id of input.linkedIds) {
    const rect = previous.linked.has(id) ? previous.rects.get(id) : undefined;
    if (rect !== undefined) {
      placed.set(id, rect);
      occupied.add(rect);
    }
  }
  if (placed.size === 0) {
    return fresh(input, options);
  }

  const neighbours = new Map<string, string[]>();
  for (const edge of input.real) {
    neighbours.set(edge.source, [...(neighbours.get(edge.source) ?? []), edge.target]);
    neighbours.set(edge.target, [...(neighbours.get(edge.target) ?? []), edge.source]);
  }
  const steps = searchSteps(options);
  let waiting = input.linkedIds.filter((id) => !placed.has(id));
  let progressed = true;
  while (waiting.length > 0 && progressed) {
    progressed = false;
    const later: string[] = [];
    for (const id of waiting) {
      const anchors = (neighbours.get(id) ?? []).flatMap((other) => {
        const rect = placed.get(other);
        return rect === undefined ? [] : [rect];
      });
      if (anchors.length === 0) {
        later.push(id);
        continue;
      }
      const middle = {
        x: anchors.reduce((sum, rect) => sum + rect.x, 0) / anchors.length,
        y: anchors.reduce((sum, rect) => sum + rect.y, 0) / anchors.length,
      };
      let spot: Rect | null = null;
      for (const offset of steps) {
        const rect = {
          x: middle.x + offset.x,
          y: middle.y + offset.y,
          w: options.nodeWidth,
          h: options.nodeHeight,
        };
        if (!occupied.blocks(rect)) {
          spot = rect;
          break;
        }
      }
      if (spot === null) {
        later.push(id);
        continue;
      }
      placed.set(id, spot);
      occupied.add(spot);
      progressed = true;
    }
    waiting = later;
  }

  // What is left touches nothing on screen: whole new groups go underneath.
  if (waiting.length > 0) {
    const bounds = boundsOfAll(placed.values());
    let x = bounds.x;
    const y = bounds.y + bounds.h + CLUSTER_GAP;
    for (const members of clusters(waiting, input.real)) {
      const block = clusterBlock(members, input.real, options, MIN_CLUSTER_ASPECT);
      block.ids.forEach((id, member) => {
        const rect = block.rects[member];
        if (rect !== undefined) {
          placed.set(id, { ...rect, x: rect.x + x, y: rect.y + y });
        }
      });
      x += block.w + CLUSTER_GAP;
    }
  }

  placeLoose(placed, input.loose, options);
  return {
    key: input.key,
    aspectStep: previous.aspectStep,
    rects: placed,
    linked: input.linked,
    pinned: true,
  };
}

/**
 * The layout for a graph, given the one on screen before it.
 *
 * - The same nodes and relations give back the previous layout itself, so
 *   a read of the vault that changes nothing costs nothing.
 * - A pane of another shape, by half as much again or more, has the graph
 *   laid out afresh to fit it, unless a node was added in place before.
 * - A changed graph keeps every placed node where it was. See `extend`.
 * - With nothing before it, everything is laid out from scratch.
 */
export function nextLayout(
  previous: KeptLayout | null,
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  options: LayoutOptions = DEFAULT_LAYOUT,
): KeptLayout {
  const input = read(nodes, edges);
  if (previous === null) {
    return fresh(input, options);
  }
  if (previous.key !== input.key) {
    return extend(previous, input, options);
  }
  if (previous.pinned || previous.aspectStep === aspectStepOf(options)) {
    return previous;
  }
  return fresh(input, options);
}

/**
 * Lays out every node from scratch. Returns a box per node id. An edge
 * that names a node not in `nodes` is ignored.
 */
export function layoutGraph(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  options: LayoutOptions = DEFAULT_LAYOUT,
): Map<string, Rect> {
  return nextLayout(null, nodes, edges, options).rects;
}
