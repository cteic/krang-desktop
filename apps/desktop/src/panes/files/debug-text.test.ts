import { describe, expect, it } from 'vitest';

import { debugText } from './debug-text';
import type { FileEntry } from './listing';

const entries: FileEntry[] = [
  { name: 'src', path: '/work/src', isDir: true, size: 96, modifiedMs: 1 },
  { name: 'notes.md', path: '/work/notes.md', isDir: false, size: 12, modifiedMs: 2 },
  { name: 'big file.bin', path: '/work/big file.bin', isDir: false, size: 1536, modifiedMs: 3 },
];

describe('debugText', () => {
  it('puts the path first, then one line per entry', () => {
    expect(debugText('/work', entries)).toBe(
      '/work\nd src/\nf notes.md 12B\nf big file.bin 1.5K\n',
    );
  });

  it('is the path alone for a directory with nothing to show', () => {
    expect(debugText('/empty', [])).toBe('/empty\n');
  });

  it('reports a failed load after the path', () => {
    expect(debugText('/locked', [], '/locked: Permission denied (os error 13)')).toBe(
      '/locked\n! /locked: Permission denied (os error 13)\n',
    );
  });
});
