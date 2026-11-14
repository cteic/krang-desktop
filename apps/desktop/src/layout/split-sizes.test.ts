import { describe, expect, it } from 'vitest';

import { equalShares, MIN_SHARE, moveDivider } from './split-sizes';

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describe('equalShares', () => {
  it('splits evenly and sums to one', () => {
    expect(equalShares(2)).toEqual([0.5, 0.5]);
    expect(sum(equalShares(3))).toBeCloseTo(1);
  });

  it('is empty for no children', () => {
    expect(equalShares(0)).toEqual([]);
  });
});

describe('moveDivider', () => {
  it('moves share from one neighbour to the other', () => {
    const next = moveDivider([0.5, 0.5], 0, 0.1);
    expect(next[0]).toBeCloseTo(0.6);
    expect(next[1]).toBeCloseTo(0.4);
  });

  it('leaves children that do not touch the divider alone', () => {
    const next = moveDivider([0.25, 0.25, 0.5], 0, 0.05);
    expect(next[2]).toBe(0.5);
    expect(sum(next)).toBeCloseTo(1);
  });

  it('stops at the minimum share in both directions', () => {
    const grown = moveDivider([0.5, 0.5], 0, 0.9);
    expect(grown[1]).toBeCloseTo(MIN_SHARE);
    const shrunk = moveDivider([0.5, 0.5], 0, -0.9);
    expect(shrunk[0]).toBeCloseTo(MIN_SHARE);
  });

  it('never pushes a small pair below half each', () => {
    const next = moveDivider([0.06, 0.06, 0.88], 0, 0.5);
    expect(next[0]).toBeCloseTo(0.06);
    expect(next[1]).toBeCloseTo(0.06);
  });

  it('changes nothing for a divider that does not exist', () => {
    expect(moveDivider([0.5, 0.5], 1, 0.1)).toEqual([0.5, 0.5]);
    expect(moveDivider([0.5, 0.5], -1, 0.1)).toEqual([0.5, 0.5]);
  });

  it('does not change its input', () => {
    const shares = [0.5, 0.5];
    moveDivider(shares, 0, 0.2);
    expect(shares).toEqual([0.5, 0.5]);
  });
});
