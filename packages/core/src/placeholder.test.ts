import { describe, expect, it } from 'vitest';

import { corePlaceholder } from './placeholder';

describe('corePlaceholder', () => {
  it('names its package', () => {
    expect(corePlaceholder()).toBe('core');
  });
});
