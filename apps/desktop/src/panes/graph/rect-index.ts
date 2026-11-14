import { rectsOverlap } from './geometry';
import type { Rect } from './geometry';

const CELL = 256;
const OFFSET = 32768;

function keyOf(cx: number, cy: number): number {
  const x = Math.min(Math.max(cx + OFFSET, 0), 65535);
  const y = Math.min(Math.max(cy + OFFSET, 0), 65535);
  return x * 65536 + y;
}

/**
 * Finds the boxes that overlap a box quickly. Each box is filed under the
 * cells of a coarse grid it covers, so a question looks at the boxes near
 * it and not at every box in the drawing.
 */
export class RectIndex {
  private readonly cells = new Map<number, Rect[]>();

  private keys(rect: Rect): number[] {
    const keys: number[] = [];
    const toX = Math.floor((rect.x + rect.w) / CELL);
    const toY = Math.floor((rect.y + rect.h) / CELL);
    for (let cx = Math.floor(rect.x / CELL); cx <= toX; cx += 1) {
      for (let cy = Math.floor(rect.y / CELL); cy <= toY; cy += 1) {
        keys.push(keyOf(cx, cy));
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

  /** True when a box overlaps one that was added. */
  hits(rect: Rect): boolean {
    for (const key of this.keys(rect)) {
      for (const other of this.cells.get(key) ?? []) {
        if (rectsOverlap(rect, other)) {
          return true;
        }
      }
    }
    return false;
  }
}
