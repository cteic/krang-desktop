/** Plain geometry for the graph drawing: boxes, edges between them, and the view onto them. */

export interface Point {
  x: number;
  y: number;
}

/** A box by its top-left corner and size. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

/** How the drawing is placed in the pane: scaled by `k`, then moved by `x`, `y`. */
export interface Transform {
  x: number;
  y: number;
  k: number;
}

export interface EdgeShape {
  /** The SVG path of the line, from the source box to the base of the arrowhead. */
  path: string;
  /** The three corners of the arrowhead, as an SVG points list. */
  head: string;
  /** Where the label sits: the middle of the line. */
  label: Point;
}

export const IDENTITY: Transform = { x: 0, y: 0, k: 1 };
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;

const HEAD_LENGTH = 11;
const HEAD_HALF_WIDTH = 5;
const LOOP_REACH = 46;

export function centerOf(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/** The smallest box around all the given boxes. Null when there are none. */
export function boundsOf(rects: readonly Rect[]): Rect | null {
  const first = rects[0];
  if (first === undefined) {
    return null;
  }
  let left = first.x;
  let top = first.y;
  let right = first.x + first.w;
  let bottom = first.y + first.h;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.w);
    bottom = Math.max(bottom, rect.y + rect.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * Where a line from the middle of a box towards `target` leaves the box.
 * The middle itself when the target is the middle.
 */
export function clipToRect(rect: Rect, target: Point): Point {
  const center = centerOf(rect);
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  if (dx === 0 && dy === 0) {
    return center;
  }
  const scaleX = dx === 0 ? Infinity : rect.w / 2 / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : rect.h / 2 / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

function round(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function headAt(tip: Point, from: Point): { points: string; base: Point } {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const base = { x: tip.x - ux * HEAD_LENGTH, y: tip.y - uy * HEAD_LENGTH };
  const left = { x: base.x - uy * HEAD_HALF_WIDTH, y: base.y + ux * HEAD_HALF_WIDTH };
  const right = { x: base.x + uy * HEAD_HALF_WIDTH, y: base.y - ux * HEAD_HALF_WIDTH };
  const points = [tip, left, right].map((point) => `${round(point.x)},${round(point.y)}`).join(' ');
  return { points, base };
}

/** A relation from a box to itself: a loop above its top right corner. */
function loopShape(rect: Rect): EdgeShape {
  const start = { x: rect.x + rect.w * 0.6, y: rect.y };
  const tip = { x: rect.x + rect.w * 0.9, y: rect.y };
  const first = { x: start.x, y: rect.y - LOOP_REACH };
  const second = { x: tip.x, y: rect.y - LOOP_REACH };
  const head = headAt(tip, second);
  return {
    path: `M ${round(start.x)} ${round(start.y)} C ${round(first.x)} ${round(first.y)} ${round(second.x)} ${round(second.y)} ${round(head.base.x)} ${round(head.base.y)}`,
    head: head.points,
    label: { x: (start.x + tip.x) / 2, y: rect.y - LOOP_REACH * 0.75 },
  };
}

/**
 * The line of a relation between two boxes, with its arrowhead at the
 * target. `bend` bows the line sideways, which keeps two relations between
 * the same pair of boxes apart. Zero is a straight line.
 */
export function edgeShape(source: Rect, target: Rect, bend = 0): EdgeShape {
  const from = centerOf(source);
  const to = centerOf(target);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return loopShape(source);
  }
  const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const control = {
    x: middle.x - (dy / length) * bend,
    y: middle.y + (dx / length) * bend,
  };
  const start = clipToRect(source, control);
  const tip = clipToRect(target, control);
  const head = headAt(tip, control);
  const end = head.base;
  const path =
    bend === 0
      ? `M ${round(start.x)} ${round(start.y)} L ${round(end.x)} ${round(end.y)}`
      : `M ${round(start.x)} ${round(start.y)} Q ${round(control.x)} ${round(control.y)} ${round(end.x)} ${round(end.y)}`;
  return {
    path,
    head: head.points,
    // The point half way along a curve with one control point.
    label: {
      x: 0.25 * start.x + 0.5 * control.x + 0.25 * tip.x,
      y: 0.25 * start.y + 0.5 * control.y + 0.25 * tip.y,
    },
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * The transform that shows all of `bounds` in the middle of a pane of the
 * given size, with a margin. It never zooms in past full size.
 */
export function fitTransform(bounds: Rect | null, viewport: Size, padding = 32): Transform {
  if (bounds === null || viewport.w <= 0 || viewport.h <= 0) {
    return IDENTITY;
  }
  const roomW = Math.max(viewport.w - padding * 2, 1);
  const roomH = Math.max(viewport.h - padding * 2, 1);
  const wanted = Math.min(roomW / Math.max(bounds.w, 1), roomH / Math.max(bounds.h, 1));
  const k = clamp(wanted, MIN_ZOOM, 1);
  return {
    k,
    x: viewport.w / 2 - (bounds.x + bounds.w / 2) * k,
    y: viewport.h / 2 - (bounds.y + bounds.h / 2) * k,
  };
}

/** Zooms by `factor`, keeping the drawing under `point` where it is. */
export function zoomAt(transform: Transform, point: Point, factor: number): Transform {
  const k = clamp(transform.k * factor, MIN_ZOOM, MAX_ZOOM);
  const ratio = k / transform.k;
  return {
    k,
    x: point.x - (point.x - transform.x) * ratio,
    y: point.y - (point.y - transform.y) * ratio,
  };
}

export function panBy(transform: Transform, dx: number, dy: number): Transform {
  return { ...transform, x: transform.x + dx, y: transform.y + dy };
}

/**
 * Moves the view just far enough to bring a box fully into the pane, with
 * a margin. A box already in sight leaves the view alone.
 */
export function revealRect(
  transform: Transform,
  rect: Rect,
  viewport: Size,
  margin = 24,
): Transform {
  if (viewport.w <= 0 || viewport.h <= 0) {
    return transform;
  }
  const left = rect.x * transform.k + transform.x;
  const top = rect.y * transform.k + transform.y;
  const right = left + rect.w * transform.k;
  const bottom = top + rect.h * transform.k;
  let dx = 0;
  let dy = 0;
  if (left < margin) {
    dx = margin - left;
  } else if (right > viewport.w - margin) {
    dx = viewport.w - margin - right;
  }
  if (top < margin) {
    dy = margin - top;
  } else if (bottom > viewport.h - margin) {
    dy = viewport.h - margin - bottom;
  }
  return dx === 0 && dy === 0 ? transform : panBy(transform, dx, dy);
}
