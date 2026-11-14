import { describe, expect, it } from 'vitest';

import { bufferText } from './terminal-text';
import type { TextBuffer } from './terminal-text';

function bufferOf(rows: (string | undefined)[]): TextBuffer {
  return {
    length: rows.length,
    getLine(index) {
      const row = rows[index];
      return row === undefined ? undefined : { translateToString: () => row };
    },
  };
}

describe('bufferText', () => {
  it('joins rows and drops the blank tail', () => {
    expect(bufferText(bufferOf(['$ ls', 'a  b', '', '']))).toBe('$ ls\na  b');
  });

  it('keeps blank rows inside the text', () => {
    expect(bufferText(bufferOf(['one', '', 'three']))).toBe('one\n\nthree');
  });

  it('treats a missing row as blank', () => {
    expect(bufferText(bufferOf(['one', undefined, 'three']))).toBe('one\n\nthree');
  });

  it('is empty for an empty buffer', () => {
    expect(bufferText(bufferOf([]))).toBe('');
  });
});
