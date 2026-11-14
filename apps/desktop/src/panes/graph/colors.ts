/** Colour choices for nodes and relations, tuned for the app's dark theme. */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const FALLBACK_NODE_COLOR = '#6e7681';
const FALLBACK_RELATION_COLOR = '#9aa4b2';

/**
 * The canvas palette's colour names, as hex that reads on a dark
 * background. The palette's "black" is the default ink, so here it is a
 * light grey: drawn as black it would vanish.
 */
const RELATION_COLORS: Record<string, string> = {
  black: '#d0d7de',
  grey: '#9aa4b2',
  white: '#ffffff',
  'light-violet': '#e599f7',
  violet: '#b583f5',
  blue: '#4f8ff7',
  'light-blue': '#4dc4f7',
  yellow: '#f5c542',
  orange: '#f58a42',
  green: '#40c057',
  'light-green': '#8ce99a',
  'light-red': '#ffa8a8',
  red: '#ff6b6b',
};

/** Reads `#rgb` or `#rrggbb`. Null for anything else. */
export function parseHex(color: string): Rgb | null {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color.trim());
  if (short !== null) {
    const [, r = '0', g = '0', b = '0'] = short;
    return { r: parseInt(r + r, 16), g: parseInt(g + g, 16), b: parseInt(b + b, 16) };
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim());
  if (long !== null) {
    const [, r = '00', g = '00', b = '00'] = long;
    return { r: parseInt(r, 16), g: parseInt(g, 16), b: parseInt(b, 16) };
  }
  return null;
}

function channel(value: number): number {
  const unit = value / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance, from 0 for black to 1 for white. */
export function luminance(color: Rgb): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** Black or white, whichever contrasts more with the fill behind it. */
export function textColorOn(fill: string): '#000000' | '#ffffff' {
  const rgb = parseHex(fill);
  if (rgb === null) {
    return '#ffffff';
  }
  const light = luminance(rgb);
  const withBlack = (light + 0.05) / 0.05;
  const withWhite = 1.05 / (light + 0.05);
  return withBlack >= withWhite ? '#000000' : '#ffffff';
}

/** A node type's fill. A missing or malformed colour becomes a neutral grey. */
export function nodeColor(color: string | null): string {
  if (color === null) {
    return FALLBACK_NODE_COLOR;
  }
  return parseHex(color) === null ? FALLBACK_NODE_COLOR : color.trim().toLowerCase();
}

/** A relation type's line colour, from a canvas palette name or a hex value. */
export function relationColor(color: string | null): string {
  if (color === null) {
    return FALLBACK_RELATION_COLOR;
  }
  const named = RELATION_COLORS[color.trim().toLowerCase()];
  if (named !== undefined) {
    return named;
  }
  return parseHex(color) === null ? FALLBACK_RELATION_COLOR : color.trim().toLowerCase();
}

/** The fixed colours of the three relations a reader looks for first. */
export const KIND_COLORS = {
  supports: '#40c057',
  opposes: '#ff6b6b',
  informs: '#4f8ff7',
} as const;

/** Colours for the other relation types, each easy to tell from the three above. */
const OTHER_COLORS = [
  '#f5a742',
  '#b583f5',
  '#4dc4f7',
  '#f5d742',
  '#f783ac',
  '#63e6be',
  '#e599f7',
  '#d0d7de',
];

export interface ColoredRelationType {
  id: string;
  color: string | null;
  kind: 'supports' | 'opposes' | 'informs' | 'other';
}

/**
 * A line colour per relation type. Supports is green, opposes red and
 * informs blue, whatever the settings say. Every other type keeps its own
 * colour when it has one that is not already in use, and otherwise takes
 * the next free colour from a fixed list, so no two types look alike
 * until the list runs out.
 */
export function relationColors(types: readonly ColoredRelationType[]): Map<string, string> {
  const colors = new Map<string, string>();
  const used = new Set<string>(Object.values(KIND_COLORS));
  for (const type of types) {
    if (type.kind !== 'other') {
      colors.set(type.id, KIND_COLORS[type.kind]);
    }
  }
  const spare = OTHER_COLORS.filter((color) => !used.has(color));
  for (const type of types) {
    if (type.kind !== 'other') {
      continue;
    }
    const own = type.color === null ? null : relationColor(type.color);
    const plain = own === null || own === FALLBACK_RELATION_COLOR || own === RELATION_COLORS.black;
    let color = own ?? FALLBACK_RELATION_COLOR;
    if (plain || used.has(color)) {
      const next = spare.find((candidate) => !used.has(candidate));
      color = next ?? color;
    }
    used.add(color);
    colors.set(type.id, color);
  }
  return colors;
}
