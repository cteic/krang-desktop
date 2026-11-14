import { centerOf } from './geometry';
import type { Rect } from './geometry';

/** Which node is selected, what it touches, and how the keyboard moves it. */

export interface Placed {
  id: string;
  rect: Rect;
}

export interface Link {
  id: string;
  source: string;
  target: string;
}

export interface Neighbourhood {
  /** The selected node and every node one relation away. */
  nodeIds: Set<string>;
  /** The relations that touch the selected node. */
  edgeIds: Set<string>;
}

export type MoveDirection = 'left' | 'right' | 'up' | 'down';

const ROW_HEIGHT = 40;

export function neighbourhood(edges: readonly Link[], selectedId: string): Neighbourhood {
  const nodeIds = new Set([selectedId]);
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edge.source === selectedId || edge.target === selectedId) {
      edgeIds.add(edge.id);
      nodeIds.add(edge.source);
      nodeIds.add(edge.target);
    }
  }
  return { nodeIds, edgeIds };
}

/** Nodes as they would be read: top to bottom, and left to right in a row. */
export function readingOrder<T extends Placed>(nodes: readonly T[]): T[] {
  return [...nodes].sort((a, b) => {
    const ca = centerOf(a.rect);
    const cb = centerOf(b.rect);
    const rows = Math.round(ca.y / ROW_HEIGHT) - Math.round(cb.y / ROW_HEIGHT);
    if (rows !== 0) {
      return rows;
    }
    if (ca.x !== cb.x) {
      return ca.x - cb.x;
    }
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * The node after, or before, the selected one in reading order. With
 * nothing selected it is the first, or last. Null past either end, so the
 * Tab key can carry on out of the graph.
 */
export function stepSelection(
  nodes: readonly Placed[],
  selectedId: string | null,
  offset: 1 | -1,
): string | null {
  const ordered = readingOrder(nodes);
  const index = ordered.findIndex((node) => node.id === selectedId);
  if (index === -1) {
    return (offset === 1 ? ordered[0] : ordered[ordered.length - 1])?.id ?? null;
  }
  return ordered[index + offset]?.id ?? null;
}

/**
 * The nearest node in a direction from the selected one. Distance off to
 * the side counts double, so "right" prefers what is level with the node.
 * With nothing selected it is the first node in reading order. With
 * nothing that way, the selection stays.
 */
export function moveSelection(
  nodes: readonly Placed[],
  selectedId: string | null,
  direction: MoveDirection,
): string | null {
  const current = nodes.find((node) => node.id === selectedId);
  if (current === undefined) {
    return readingOrder(nodes)[0]?.id ?? null;
  }
  const from = centerOf(current.rect);
  const horizontal = direction === 'left' || direction === 'right';
  const sign = direction === 'left' || direction === 'up' ? -1 : 1;
  let best: Placed | null = null;
  let bestCost = Infinity;
  for (const node of nodes) {
    if (node.id === current.id) {
      continue;
    }
    const to = centerOf(node.rect);
    const along = (horizontal ? to.x - from.x : to.y - from.y) * sign;
    const across = Math.abs(horizontal ? to.y - from.y : to.x - from.x);
    if (along <= 0) {
      continue;
    }
    const cost = along + across * 2;
    if (cost < bestCost || (cost === bestCost && best !== null && node.id < best.id)) {
      best = node;
      bestCost = cost;
    }
  }
  return (best ?? current).id;
}
