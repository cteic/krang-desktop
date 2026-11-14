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
 * Turns relative sizes, such as `[1, 2]`, into shares that sum to 1. Null
 * when a size is not a positive, finite number, or when there are none.
 */
export function sharesFromSizes(sizes: readonly number[]): number[] | null {
  if (sizes.length === 0 || sizes.some((size) => !Number.isFinite(size) || size <= 0)) {
    return null;
  }
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (!Number.isFinite(total)) {
    return null;
  }
  return sizes.map((size) => size / total);
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
