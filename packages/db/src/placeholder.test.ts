import { describe, expect, it } from 'vitest';

import { dbPlaceholder } from './placeholder';

describe('dbPlaceholder', () => {
  it('reaches core through its subpath export', () => {
    expect(dbPlaceholder()).toBe('db on core');
  });
});
