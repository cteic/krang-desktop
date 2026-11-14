import { describe, expect, it } from 'vitest';

import { formatModified, formatSize } from './format';

describe('formatSize', () => {
  it('shows bytes whole', () => {
    expect(formatSize(0)).toBe('0B');
    expect(formatSize(5)).toBe('5B');
    expect(formatSize(1023)).toBe('1023B');
  });

  it('shows one decimal place below ten of a unit', () => {
    expect(formatSize(1024)).toBe('1.0K');
    expect(formatSize(1536)).toBe('1.5K');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0M');
  });

  it('shows whole numbers from ten of a unit up', () => {
    expect(formatSize(10 * 1024)).toBe('10K');
    expect(formatSize(12.4 * 1024 * 1024)).toBe('12M');
    expect(formatSize(999 * 1024)).toBe('999K');
  });

  it('never shows 10.0 where rounding crosses ten', () => {
    expect(formatSize(9.96 * 1024)).toBe('10K');
    expect(formatSize(9.94 * 1024)).toBe('9.9K');
  });

  it('moves to the next unit when rounding reaches 1024', () => {
    expect(formatSize(1024 * 1024 - 1)).toBe('1.0M');
  });

  it('covers gigabytes, terabytes and beyond', () => {
    expect(formatSize(3 * 1024 ** 3)).toBe('3.0G');
    expect(formatSize(2.5 * 1024 ** 4)).toBe('2.5T');
    expect(formatSize(1024 ** 5)).toBe('1.0P');
    expect(formatSize(5000 * 1024 ** 5)).toBe('5000P');
  });

  it('is blank for a value that is not a size', () => {
    expect(formatSize(-1)).toBe('');
    expect(formatSize(Number.NaN)).toBe('');
    expect(formatSize(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('formatModified', () => {
  it('shows the local date and time, zero padded', () => {
    const morning = new Date(2026, 0, 5, 9, 7).getTime();
    const evening = new Date(2025, 10, 23, 18, 45).getTime();

    expect(formatModified(morning)).toBe('2026-01-05 09:07');
    expect(formatModified(evening)).toBe('2025-11-23 18:45');
  });

  it('is blank when the time is unknown', () => {
    expect(formatModified(0)).toBe('');
  });

  it('is blank for a value that is not a time', () => {
    expect(formatModified(-5)).toBe('');
    expect(formatModified(Number.NaN)).toBe('');
    expect(formatModified(Number.MAX_VALUE)).toBe('');
  });
});
