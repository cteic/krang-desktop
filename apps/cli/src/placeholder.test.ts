import { describe, expect, it } from 'vitest';

import { cliPlaceholder } from './placeholder';

describe('cliPlaceholder', () => {
  it('reaches db and core through their subpath exports', () => {
    expect(cliPlaceholder()).toBe('cli on db on core');
  });
});
