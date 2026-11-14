import { describe, expect, it } from 'vitest';

import { accentFor, badgeColorFor } from './accent';

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

describe('badgeColorFor', () => {
  it('passes a six-digit hex value through', () => {
    expect(badgeColorFor('#ff8800')).toBe('#ff8800');
  });

  it('gives the default for no colour, and for anything that is not a hex value', () => {
    for (const color of [null, 'red', '#f80', 'url(https://example.invalid/x)', 'var(--bg)']) {
      expect(badgeColorFor(color)).toBe('#e0b956');
    }
  });
});
