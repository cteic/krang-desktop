import { describe, expect, it } from 'vitest';

import { computeGeometry } from './geometry';
import type { LeafNode, PaneTree } from './model';

function leaf(id: string): LeafNode {
  return {
    kind: 'leaf',
    id,
    title: null,
    badge: null,
    content: { type: 'terminal', directory: null, commands: [] },
  };
}

function rectOf(tree: PaneTree, paneId: string) {
  const found = computeGeometry(tree).panes.find((pane) => pane.paneId === paneId);
  if (found === undefined) {
    throw new Error(`no rect for ${paneId}`);
  }
  return found.rect;
}

describe('computeGeometry', () => {
  it('gives a lone pane the whole area and no dividers', () => {
    const geometry = computeGeometry(leaf('a'));
    expect(geometry.panes).toEqual([{ paneId: 'a', rect: { x: 0, y: 0, w: 1, h: 1 } }]);
    expect(geometry.dividers).toEqual([]);
  });

  it('places a row split side by side by share', () => {
    const tree: PaneTree = {
      kind: 'split',
      id: 's',
      direction: 'row',
      children: [leaf('a'), leaf('b')],
      shares: [0.25, 0.75],
    };
    expect(rectOf(tree, 'a')).toEqual({ x: 0, y: 0, w: 0.25, h: 1 });
    expect(rectOf(tree, 'b')).toEqual({ x: 0.25, y: 0, w: 0.75, h: 1 });
  });

  it('nests a column split inside a row split, as the cockpit layout does', () => {
    const tree: PaneTree = {
      kind: 'split',
      id: 'root',
      direction: 'row',
      children: [
        {
          kind: 'split',
          id: 'left',
          direction: 'column',
          children: [leaf('shell'), leaf('state')],
          shares: [0.5, 0.5],
        },
        leaf('agent'),
      ],
      shares: [0.5, 0.5],
    };
    expect(rectOf(tree, 'shell')).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(rectOf(tree, 'state')).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
    expect(rectOf(tree, 'agent')).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });

    const dividers = computeGeometry(tree).dividers;
    expect(dividers).toContainEqual({
      splitId: 'left',
      index: 0,
      direction: 'column',
      rect: { x: 0, y: 0.5, w: 0.5, h: 0 },
      extent: 1,
    });
    expect(dividers).toContainEqual({
      splitId: 'root',
      index: 0,
      direction: 'row',
      rect: { x: 0.5, y: 0, w: 0, h: 1 },
      extent: 1,
    });
  });

  it('reports a nested split extent as a fraction of the whole area', () => {
    const tree: PaneTree = {
      kind: 'split',
      id: 'root',
      direction: 'row',
      children: [
        leaf('a'),
        {
          kind: 'split',
          id: 'inner',
          direction: 'row',
          children: [leaf('b'), leaf('c')],
          shares: [0.5, 0.5],
        },
      ],
      shares: [0.6, 0.4],
    };
    const inner = computeGeometry(tree).dividers.find((divider) => divider.splitId === 'inner');
    expect(inner?.extent).toBeCloseTo(0.4);
    expect(inner?.rect.x).toBeCloseTo(0.8);
  });

  it('normalises shares that do not sum to one', () => {
    const tree: PaneTree = {
      kind: 'split',
      id: 's',
      direction: 'column',
      children: [leaf('a'), leaf('b')],
      shares: [1, 3],
    };
    expect(rectOf(tree, 'a').h).toBeCloseTo(0.25);
    expect(rectOf(tree, 'b').y).toBeCloseTo(0.25);
  });
});
