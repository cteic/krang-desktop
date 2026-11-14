import type { Direction, PaneTree } from './model';

/** A rectangle in fractions of the tab area: 0 to 1 on both axes. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PaneRect {
  paneId: string;
  rect: Rect;
}

export interface DividerLine {
  splitId: string;
  /** The divider sits after child `index` of its split. */
  index: number;
  direction: Direction;
  /** Zero thickness along the split's axis. The view gives it a width. */
  rect: Rect;
  /** The split's own size along its axis, for turning a drag into a share. */
  extent: number;
}

export interface Geometry {
  panes: PaneRect[];
  dividers: DividerLine[];
}

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

/**
 * Lays a pane tree out as flat rectangles. Panes are drawn from this list,
 * not as nested elements, so restructuring the tree moves a pane without
 * recreating it. A recreated terminal would lose its shell.
 */
export function computeGeometry(root: PaneTree): Geometry {
  const geometry: Geometry = { panes: [], dividers: [] };
  place(root, FULL, geometry);
  return geometry;
}

function place(node: PaneTree, rect: Rect, geometry: Geometry) {
  if (node.kind === 'leaf') {
    geometry.panes.push({ paneId: node.id, rect });
    return;
  }

  const horizontal = node.direction === 'row';
  const extent = horizontal ? rect.w : rect.h;
  const total = node.shares.reduce((sum, share) => sum + share, 0);
  let offset = 0;

  node.children.forEach((child, index) => {
    const share = total > 0 ? (node.shares[index] ?? 0) / total : 1 / node.children.length;
    const size = extent * share;
    const childRect: Rect = horizontal
      ? { x: rect.x + offset, y: rect.y, w: size, h: rect.h }
      : { x: rect.x, y: rect.y + offset, w: rect.w, h: size };
    place(child, childRect, geometry);
    offset += size;

    if (index < node.children.length - 1) {
      geometry.dividers.push({
        splitId: node.id,
        index,
        direction: node.direction,
        rect: horizontal
          ? { x: rect.x + offset, y: rect.y, w: 0, h: rect.h }
          : { x: rect.x, y: rect.y + offset, w: rect.w, h: 0 },
        extent,
      });
    }
  });
}
