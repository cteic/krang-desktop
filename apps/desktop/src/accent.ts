const ACCENTS: Record<string, string> = {
  blue: '#1e3a8a',
  magenta: '#86198f',
  cyan: '#155e75',
  green: '#166534',
  yellow: '#854d0e',
  red: '#991b1b',
};

const DEFAULT_ACCENT = '#30363d';
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_BADGE = '#e0b956';

/** Maps a layout colour, a tab-config name or a hex value, to a title-bar colour. */
export function accentFor(color: string | null): string {
  if (color === null) {
    return DEFAULT_ACCENT;
  }
  if (HEX_COLOUR.test(color)) {
    return color;
  }
  return ACCENTS[color.toLowerCase()] ?? DEFAULT_ACCENT;
}

/**
 * A badge's colour. A pane sets it through the command-line tool, so only a
 * six-digit hex value is used. Anything else gives the default.
 */
export function badgeColorFor(color: string | null): string {
  return color !== null && HEX_COLOUR.test(color) ? color : DEFAULT_BADGE;
}
