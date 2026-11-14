import { describe, expect, it } from 'vitest';

import { moveSelection, neighbourhood, readingOrder, stepSelection } from './selection';
import type { Link, Placed } from './selection';

function at(id: string, x: number, y: number): Placed {
  return { id, rect: { x, y, w: 100, h: 40 } };
}

/**
 *   a   b   c
 *   d       e
 *       f
 */
const GRID: Placed[] = [
  at('c', 400, 0),
  at('a', 0, 0),
  at('f', 200, 200),
  at('b', 200, 5),
  at('e', 400, 100),
  at('d', 0, 100),
];

const LINKS: Link[] = [
  { id: 'r1', source: 'a', target: 'b' },
  { id: 'r2', source: 'c', target: 'a' },
  { id: 'r3', source: 'd', target: 'e' },
];

describe('neighbourhood', () => {
  it('holds the node, its neighbours either way, and the relations between', () => {
    const near = neighbourhood(LINKS, 'a');
    expect([...near.nodeIds].sort()).toEqual(['a', 'b', 'c']);
    expect([...near.edgeIds].sort()).toEqual(['r1', 'r2']);
  });

  it('is the node alone when nothing touches it', () => {
    const near = neighbourhood(LINKS, 'f');
    expect([...near.nodeIds]).toEqual(['f']);
    expect(near.edgeIds.size).toBe(0);
  });
});

describe('readingOrder', () => {
  it('goes top to bottom, and left to right within a row', () => {
    expect(readingOrder(GRID).map((node) => node.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

describe('stepSelection', () => {
  it('starts at the first node, or the last going backwards', () => {
    expect(stepSelection(GRID, null, 1)).toBe('a');
    expect(stepSelection(GRID, null, -1)).toBe('f');
    expect(stepSelection(GRID, 'gone', 1)).toBe('a');
  });

  it('steps through in reading order', () => {
    expect(stepSelection(GRID, 'a', 1)).toBe('b');
    expect(stepSelection(GRID, 'c', 1)).toBe('d');
    expect(stepSelection(GRID, 'd', -1)).toBe('c');
  });

  it('is null past either end, so Tab can leave the graph', () => {
    expect(stepSelection(GRID, 'f', 1)).toBeNull();
    expect(stepSelection(GRID, 'a', -1)).toBeNull();
    expect(stepSelection([], null, 1)).toBeNull();
  });
});

describe('moveSelection', () => {
  it('selects the first node when nothing is selected', () => {
    expect(moveSelection(GRID, null, 'right')).toBe('a');
    expect(moveSelection([], null, 'right')).toBeNull();
  });

  it('moves to the nearest node in the direction pressed', () => {
    expect(moveSelection(GRID, 'a', 'right')).toBe('b');
    expect(moveSelection(GRID, 'b', 'right')).toBe('c');
    expect(moveSelection(GRID, 'a', 'down')).toBe('d');
    expect(moveSelection(GRID, 'e', 'up')).toBe('c');
    expect(moveSelection(GRID, 'c', 'left')).toBe('b');
  });

  it('prefers what is level with the node over what is merely close', () => {
    const nodes = [at('from', 0, 0), at('diagonal', 120, 100), at('level', 300, 0)];
    expect(moveSelection(nodes, 'from', 'right')).toBe('level');
    expect(moveSelection(nodes, 'from', 'down')).toBe('diagonal');
    expect(moveSelection(GRID, 'b', 'down')).toBe('f');
  });

  it('stays put when nothing lies that way', () => {
    expect(moveSelection(GRID, 'a', 'left')).toBe('a');
    expect(moveSelection(GRID, 'a', 'up')).toBe('a');
    expect(moveSelection(GRID, 'f', 'down')).toBe('f');
  });
});
