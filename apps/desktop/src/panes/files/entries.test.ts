import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SORT,
  emptyMessage,
  filterEntries,
  isHidden,
  nextSort,
  sortEntries,
  summaryText,
  visibleEntries,
} from './entries';
import type { FileEntry } from './listing';

function file(name: string, size = 0, modifiedMs = 0): FileEntry {
  return { name, path: `/work/${name}`, isDir: false, size, modifiedMs };
}

function dir(name: string, modifiedMs = 0): FileEntry {
  return { name, path: `/work/${name}`, isDir: true, size: 96, modifiedMs };
}

function names(entries: FileEntry[]): string[] {
  return entries.map((entry) => entry.name);
}

describe('sortEntries', () => {
  const entries = [
    file('b.txt', 20, 300),
    dir('zeta', 100),
    file('A.txt', 5, 200),
    dir('alpha', 400),
    file('c.txt', 20, 100),
  ];

  it('sorts by name without regard to case, directories first', () => {
    const sorted = sortEntries(entries, { key: 'name', direction: 'asc' });

    expect(names(sorted)).toEqual(['alpha', 'zeta', 'A.txt', 'b.txt', 'c.txt']);
  });

  it('keeps directories first when the name order is reversed', () => {
    const sorted = sortEntries(entries, { key: 'name', direction: 'desc' });

    expect(names(sorted)).toEqual(['zeta', 'alpha', 'c.txt', 'b.txt', 'A.txt']);
  });

  it('sorts files by size and breaks ties by name', () => {
    const sorted = sortEntries(entries, { key: 'size', direction: 'asc' });

    expect(names(sorted)).toEqual(['alpha', 'zeta', 'A.txt', 'b.txt', 'c.txt']);
  });

  it('reverses the size order for files and leaves directories by name', () => {
    const sorted = sortEntries(entries, { key: 'size', direction: 'desc' });

    expect(names(sorted)).toEqual(['alpha', 'zeta', 'b.txt', 'c.txt', 'A.txt']);
  });

  it('sorts by modified time within each group', () => {
    const oldestFirst = sortEntries(entries, { key: 'modified', direction: 'asc' });
    const newestFirst = sortEntries(entries, { key: 'modified', direction: 'desc' });

    expect(names(oldestFirst)).toEqual(['zeta', 'alpha', 'c.txt', 'A.txt', 'b.txt']);
    expect(names(newestFirst)).toEqual(['alpha', 'zeta', 'b.txt', 'A.txt', 'c.txt']);
  });

  it('orders names that differ only by case the same way every time', () => {
    const sorted = sortEntries([file('readme'), file('README')], DEFAULT_SORT);

    expect(names(sorted)).toEqual(['README', 'readme']);
  });

  it('does not change the list it was given', () => {
    const original = [file('b'), file('a')];

    sortEntries(original, DEFAULT_SORT);

    expect(names(original)).toEqual(['b', 'a']);
  });
});

describe('filterEntries', () => {
  const entries = [dir('Source'), file('notes.md'), file('resource.json')];

  it('returns everything for an empty filter', () => {
    expect(names(filterEntries(entries, ''))).toEqual(['Source', 'notes.md', 'resource.json']);
  });

  it('matches part of a name, ignoring case', () => {
    expect(names(filterEntries(entries, 'SOUR'))).toEqual(['Source', 'resource.json']);
  });

  it('returns nothing when no name matches', () => {
    expect(filterEntries(entries, 'xyz')).toEqual([]);
  });

  it('treats a space as part of the text to find', () => {
    expect(names(filterEntries([file('my file.txt'), file('myfile.txt')], 'y f'))).toEqual([
      'my file.txt',
    ]);
  });
});

describe('visibleEntries', () => {
  const entries = [dir('.git'), dir('src'), file('.env', 10), file('main.ts', 30), file('app.ts')];

  it('hides dot files by default', () => {
    const shown = visibleEntries(entries, { showHidden: false, filter: '', sort: DEFAULT_SORT });

    expect(names(shown)).toEqual(['src', 'app.ts', 'main.ts']);
  });

  it('shows dot files when asked', () => {
    const shown = visibleEntries(entries, { showHidden: true, filter: '', sort: DEFAULT_SORT });

    expect(names(shown)).toEqual(['.git', 'src', '.env', 'app.ts', 'main.ts']);
  });

  it('applies the filter and the sort together', () => {
    const shown = visibleEntries(entries, {
      showHidden: false,
      filter: '.ts',
      sort: { key: 'size', direction: 'desc' },
    });

    expect(names(shown)).toEqual(['main.ts', 'app.ts']);
  });

  it('does not let the filter bring back a hidden file', () => {
    const shown = visibleEntries(entries, { showHidden: false, filter: 'env', sort: DEFAULT_SORT });

    expect(shown).toEqual([]);
  });
});

describe('isHidden', () => {
  it('is true only for names that start with a dot', () => {
    expect(isHidden(file('.zshrc'))).toBe(true);
    expect(isHidden(file('notes.md'))).toBe(false);
  });
});

describe('nextSort', () => {
  it('reverses the direction for the same column', () => {
    expect(nextSort({ key: 'name', direction: 'asc' }, 'name')).toEqual({
      key: 'name',
      direction: 'desc',
    });
    expect(nextSort({ key: 'name', direction: 'desc' }, 'name')).toEqual({
      key: 'name',
      direction: 'asc',
    });
  });

  it('starts a new column ascending', () => {
    expect(nextSort({ key: 'name', direction: 'desc' }, 'size')).toEqual({
      key: 'size',
      direction: 'asc',
    });
  });
});

describe('summaryText', () => {
  it('counts the items', () => {
    expect(summaryText(12, 12)).toBe('12 items');
    expect(summaryText(1, 1)).toBe('1 item');
    expect(summaryText(0, 0)).toBe('0 items');
  });

  it('says how many are shown when some are not', () => {
    expect(summaryText(3, 12)).toBe('3 of 12 items');
    expect(summaryText(0, 1)).toBe('0 of 1 item');
  });
});

describe('emptyMessage', () => {
  it('is null when there are rows', () => {
    expect(emptyMessage([file('a')], 1, '')).toBeNull();
  });

  it('says the directory is empty', () => {
    expect(emptyMessage([], 0, '')).toBe('This directory is empty.');
    expect(emptyMessage([], 0, 'abc')).toBe('This directory is empty.');
  });

  it('names the filter that matched nothing', () => {
    expect(emptyMessage([file('a')], 0, 'zzz')).toBe('No entries match "zzz".');
  });

  it('points at the hidden files toggle when everything is hidden', () => {
    expect(emptyMessage([file('.env')], 0, '')).toBe(
      'Only hidden files here. Turn on hidden files to see them.',
    );
  });
});
