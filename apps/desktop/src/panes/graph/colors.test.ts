import { describe, expect, it } from 'vitest';

import { luminance, nodeColor, parseHex, relationColor, textColorOn } from './colors';

describe('parseHex', () => {
  it('reads long and short hex colours', () => {
    expect(parseHex('#F2C123')).toEqual({ r: 242, g: 193, b: 35 });
    expect(parseHex(' #0f8 ')).toEqual({ r: 0, g: 255, b: 136 });
  });

  it('is null for anything else', () => {
    expect(parseHex('green')).toBeNull();
    expect(parseHex('#12345')).toBeNull();
    expect(parseHex('#gggggg')).toBeNull();
    expect(parseHex('')).toBeNull();
  });
});

describe('textColorOn', () => {
  it('puts black on light fills and white on dark ones', () => {
    expect(textColorOn('#F2C123')).toBe('#000000');
    expect(textColorOn('#C8D0D4')).toBe('#000000');
    expect(textColorOn('#ffffff')).toBe('#000000');
    expect(textColorOn('#8B1A30')).toBe('#ffffff');
    expect(textColorOn('#000000')).toBe('#ffffff');
  });

  it('picks whichever contrasts more on a mid tone', () => {
    // Mid grey: black wins the contrast, though the fill looks dark.
    expect(luminance({ r: 128, g: 128, b: 128 })).toBeCloseTo(0.2158, 3);
    expect(textColorOn('#808080')).toBe('#000000');
    expect(textColorOn('#5B7FA6')).toBe('#000000');
  });

  it('falls back to white for a fill it cannot read', () => {
    expect(textColorOn('teal')).toBe('#ffffff');
  });
});

describe('nodeColor', () => {
  it('keeps a hex colour and replaces anything else with grey', () => {
    expect(nodeColor('#2E9E82')).toBe('#2e9e82');
    expect(nodeColor(null)).toBe('#6e7681');
    expect(nodeColor('url(x)')).toBe('#6e7681');
  });
});

describe('relationColor', () => {
  it('maps the canvas palette names to hex', () => {
    expect(relationColor('green')).toBe('#40c057');
    expect(relationColor('red')).toBe('#ff6b6b');
    expect(relationColor('light-blue')).toBe('#4dc4f7');
    expect(relationColor('Violet')).toBe('#b583f5');
  });

  it('never draws the palette black as black, which the dark theme would hide', () => {
    const rgb = parseHex(relationColor('black'));
    expect(rgb).not.toBeNull();
    expect(rgb === null ? 0 : luminance(rgb)).toBeGreaterThan(0.5);
  });

  it('gives every palette colour enough contrast with the dark background', () => {
    const background = luminance({ r: 11, g: 14, b: 20 });
    const names = [
      'black',
      'grey',
      'white',
      'light-violet',
      'violet',
      'blue',
      'light-blue',
      'yellow',
      'orange',
      'green',
      'light-green',
      'light-red',
      'red',
    ];
    for (const name of names) {
      const rgb = parseHex(relationColor(name));
      const contrast = rgb === null ? 0 : (luminance(rgb) + 0.05) / (background + 0.05);
      expect(contrast, name).toBeGreaterThan(4.5);
    }
  });

  it('accepts a hex value and falls back to grey for an unknown name', () => {
    expect(relationColor('#ABCDEF')).toBe('#abcdef');
    expect(relationColor('chartreuse')).toBe('#9aa4b2');
    expect(relationColor(null)).toBe('#9aa4b2');
  });
});
