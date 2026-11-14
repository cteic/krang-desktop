import { describe, expect, it } from 'vitest';

import { accentFor } from './accent';

describe('accentFor', () => {
  it('maps the tab-config colour names', () => {
    expect(accentFor('blue')).toBe('#1e3a8a');
    expect(accentFor('Magenta')).toBe('#86198f');
  });

  it('passes a six-digit hex value through', () => {
    expect(accentFor('#abcdef')).toBe('#abcdef');
  });

  it('falls back for no colour or an unknown one', () => {
    expect(accentFor(null)).toBe('#30363d');
    expect(accentFor('heliotrope')).toBe('#30363d');
    expect(accentFor('#abc')).toBe('#30363d');
  });
});
