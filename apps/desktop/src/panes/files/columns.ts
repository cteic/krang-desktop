/**
 * Which columns of the file list are shown at a pane width. The name
 * always gets what is left, and never less than `NAME_MIN`: as the pane
 * narrows the date goes first, then the size.
 */

export interface Columns {
  size: boolean;
  modified: boolean;
}

/** The widths of the fixed columns. `files-pane.css` sets the same ones. */
const KIND = 22;
const SIZE = 58;
const MODIFIED = 116;
const ACTIONS = 78;
/** The least room a name is left with before a column is dropped for it. */
export const NAME_MIN = 110;
/** Below this width the toolbar's filter gets a row of its own. */
const NARROW_HEADER = 320;

const ALL: Columns = { size: true, modified: true };

/** `width` is the pane's width in pixels. Null, or zero, when it is not known yet. */
export function columnsFor(width: number | null): Columns {
  if (width === null || width <= 0) {
    return ALL;
  }
  const base = KIND + NAME_MIN + ACTIONS;
  return {
    size: width >= base + SIZE,
    modified: width >= base + SIZE + MODIFIED,
  };
}

/** True when the toolbar cannot keep the path and the filter on one row. */
export function isNarrowHeader(width: number | null): boolean {
  return width !== null && width > 0 && width < NARROW_HEADER;
}
