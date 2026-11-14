/** The smallest share of a split one child may be dragged down to. */
export const MIN_SHARE = 0.1;

/** Equal shares for `count` children. They sum to 1. */
export function equalShares(count: number): number[] {
  if (count <= 0) {
    return [];
  }
  return Array.from({ length: count }, () => 1 / count);
}

/**
 * Moves the divider after child `index` by `delta`, a fraction of the whole
 * split. Only the two children beside the divider change, and neither drops
 * below `MIN_SHARE`. A divider that does not exist changes nothing.
 */
export function moveDivider(shares: readonly number[], index: number, delta: number): number[] {
  const before = shares[index];
  const after = shares[index + 1];
  if (before === undefined || after === undefined || index < 0) {
    return [...shares];
  }
  const pair = before + after;
  const floor = Math.min(MIN_SHARE, pair / 2);
  const nextBefore = Math.min(Math.max(before + delta, floor), pair - floor);
  const next = [...shares];
  next[index] = nextBefore;
  next[index + 1] = pair - nextBefore;
  return next;
}
