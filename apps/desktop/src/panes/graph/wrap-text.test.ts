import { describe, expect, it } from 'vitest';

import { wrapText } from './wrap-text';

describe('wrapText', () => {
  it('keeps a short title on one line', () => {
    expect(wrapText('QUE - why', 20, 3)).toEqual(['QUE - why']);
  });

  it('breaks between words', () => {
    expect(wrapText('CLM - citations track real influence', 14, 4)).toEqual([
      'CLM -',
      'citations',
      'track real',
      'influence',
    ]);
  });

  it('keeps the first line short when told to', () => {
    expect(wrapText('one two three four five', 9, 4, 4)).toEqual(['one', 'two three', 'four five']);
    // Not even one word fits beside what shares the first line.
    expect(wrapText('three four', 9, 4, 3)).toEqual(['', 'three', 'four']);
    expect(wrapText('one two three four five', 9, 1, 5)).toEqual(['one…']);
  });

  it('fills each line as far as it can', () => {
    expect(wrapText('one two three four five', 9, 4)).toEqual(['one two', 'three', 'four five']);
  });

  it('ends the last line in an ellipsis when the text does not fit', () => {
    const lines = wrapText('alpha beta gamma delta epsilon zeta', 10, 2);
    expect(lines).toEqual(['alpha beta', 'gamma…']);
    expect(wrapText('alpha beta gammadelta epsilon', 10, 2)).toEqual(['alpha beta', 'gammadelt…']);
    expect(lines.every((line) => line.length <= 10)).toBe(true);
  });

  it('cuts a word longer than a line', () => {
    expect(wrapText('@azoulaySuperstarExtinction2008', 12, 3)).toEqual([
      '@azoulaySupe',
      'rstarExtinct',
      'ion2008',
    ]);
  });

  it('collapses runs of white space and copes with nothing', () => {
    expect(wrapText('  a \n  b\t c ', 10, 2)).toEqual(['a b c']);
    expect(wrapText('', 10, 2)).toEqual([]);
  });

  it('never returns more lines than asked for, even for odd limits', () => {
    expect(wrapText('a b c d', 1, 0)).toEqual(['…']);
    expect(wrapText('abc def', 0.4, 2.9)).toEqual(['a', '…']);
  });
});
