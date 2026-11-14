import type { FileEntry } from './listing';

export type SortKey = 'name' | 'size' | 'modified';

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  key: SortKey;
  direction: SortDirection;
}

export interface ViewOptions {
  showHidden: boolean;
  filter: string;
  sort: SortState;
}

export const DEFAULT_SORT: SortState = { key: 'name', direction: 'asc' };

export function isHidden(entry: FileEntry): boolean {
  return entry.name.startsWith('.');
}

function compareText(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** Case-blind first, as the Rust side orders them, then exact so ties are stable. */
function compareNames(a: FileEntry, b: FileEntry): number {
  const folded = compareText(a.name.toLowerCase(), b.name.toLowerCase());
  return folded === 0 ? compareText(a.name, b.name) : folded;
}

function compareByKey(a: FileEntry, b: FileEntry, key: SortKey): number {
  if (key === 'modified') {
    return a.modifiedMs - b.modifiedMs;
  }
  // A directory's size says nothing about what is in it, so directories
  // fall through to their names.
  if (key === 'size' && !a.isDir && !b.isDir) {
    return a.size - b.size;
  }
  if (key === 'name') {
    return compareNames(a, b);
  }
  return 0;
}

/** Sorts a copy. Directories stay grouped first whatever the key or direction. */
export function sortEntries(entries: readonly FileEntry[], sort: SortState): FileEntry[] {
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) {
      return a.isDir ? -1 : 1;
    }
    const primary = compareByKey(a, b, sort.key) * sign;
    return primary === 0 ? compareNames(a, b) : primary;
  });
}

/** Keeps entries whose name contains the filter text, ignoring case. */
export function filterEntries(entries: readonly FileEntry[], filter: string): FileEntry[] {
  const needle = filter.toLowerCase();
  if (needle === '') {
    return [...entries];
  }
  return entries.filter((entry) => entry.name.toLowerCase().includes(needle));
}

/** The rows the table shows: hidden files dropped, filter applied, sorted. */
export function visibleEntries(entries: readonly FileEntry[], options: ViewOptions): FileEntry[] {
  const shown = options.showHidden ? entries : entries.filter((entry) => !isHidden(entry));
  return sortEntries(filterEntries(shown, options.filter), options.sort);
}

/** Same column flips the direction. A new column starts ascending. */
export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key !== key) {
    return { key, direction: 'asc' };
  }
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

/** The footer count, such as `12 items` or `3 of 12 items`. */
export function summaryText(shown: number, total: number): string {
  const noun = total === 1 ? 'item' : 'items';
  if (shown === total) {
    return `${String(total)} ${noun}`;
  }
  return `${String(shown)} of ${String(total)} ${noun}`;
}

/** Why the table has no rows. Null when it has some. */
export function emptyMessage(
  entries: readonly FileEntry[],
  shown: number,
  filter: string,
): string | null {
  if (shown > 0) {
    return null;
  }
  if (entries.length === 0) {
    return 'This directory is empty.';
  }
  if (filter !== '') {
    return `No entries match "${filter}".`;
  }
  return 'Only hidden files here. Turn on hidden files to see them.';
}
