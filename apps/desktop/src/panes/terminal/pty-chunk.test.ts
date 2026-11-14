import { describe, expect, it } from 'vitest';

import { toBytes } from './pty-chunk';

describe('toBytes', () => {
  it('reads raw bytes from an ArrayBuffer', () => {
    const buffer = Uint8Array.from([104, 105]).buffer;
    expect(Array.from(toBytes(buffer))).toEqual([104, 105]);
  });

  it('passes a Uint8Array through', () => {
    const bytes = Uint8Array.from([27, 91]);
    expect(toBytes(bytes)).toBe(bytes);
  });

  it('reads the JSON fallback, an array of byte values', () => {
    expect(Array.from(toBytes([226, 148, 128]))).toEqual([226, 148, 128]);
  });

  it('yields nothing for an array that is not all bytes', () => {
    expect(toBytes([1, 256]).length).toBe(0);
    expect(toBytes([1, 'a']).length).toBe(0);
  });

  it('yields nothing for anything else', () => {
    expect(toBytes('hi').length).toBe(0);
    expect(toBytes(null).length).toBe(0);
  });
});
