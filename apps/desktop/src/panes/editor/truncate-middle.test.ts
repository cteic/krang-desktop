import { describe, expect, it } from 'vitest';

import { truncateMiddle } from './truncate-middle';

describe('truncateMiddle', () => {
  it('returns short text unchanged', () => {
    expect(truncateMiddle('/a/b.md', 20)).toBe('/a/b.md');
    expect(truncateMiddle('abcde', 5)).toBe('abcde');
    expect(truncateMiddle('', 5)).toBe('');
  });

  it('cuts the middle and never exceeds the limit', () => {
    const result = truncateMiddle('/Users/sam/projects/notes/today.md', 21);
    expect(result).toBe('/Users/sam…s/today.md');
    expect(Array.from(result)).toHaveLength(21);
  });

  it('gives the tail the spare character', () => {
    expect(truncateMiddle('abcdefghij', 6)).toBe('ab…hij');
    expect(truncateMiddle('abcdefghij', 5)).toBe('ab…ij');
  });

  it('copes with tiny limits', () => {
    expect(truncateMiddle('abcdef', 2)).toBe('…f');
    expect(truncateMiddle('abcdef', 1)).toBe('…');
    expect(truncateMiddle('abcdef', 0)).toBe('…');
  });

  it('counts characters, not code units', () => {
    expect(truncateMiddle('😀😀😀😀😀😀', 3)).toBe('😀…😀');
  });
});
