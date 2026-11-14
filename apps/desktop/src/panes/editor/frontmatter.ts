/**
 * Reads the YAML block some notes start with. Only the shapes notes use are
 * understood: `key: value`, a list under a key, and `key: [a, b]`. Anything
 * deeper is kept as the text it was written as.
 */

export interface Property {
  key: string;
  /** One entry for a plain value, one per item for a list. */
  values: string[];
  list: boolean;
}

export interface SplitNote {
  /** Null when the text does not start with a frontmatter block. */
  properties: Property[] | null;
  /** The text after the block, or all of it when there is none. */
  body: string;
}

const OPENING = /^---[ \t]*\r?\n/;
const CLOSING = /^(?:---|\.\.\.)[ \t]*$/;
const KEY_LINE = /^([^\s:#][^:]*?):(?:[ \t]+(.*))?$/;
const LIST_ITEM = /^\s*-(?:\s+(.*))?$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if (trimmed.length >= 2 && (quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Splits `a, "b, c", d` on the commas that are not inside quotes. */
function splitInlineList(inner: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const char of inner) {
    if (quote !== null) {
      current += char;
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ',') {
      items.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  items.push(current);
  return items.map(unquote).filter((item) => item !== '');
}

function inlineValue(key: string, rest: string): Property {
  if (rest.startsWith('[') && rest.endsWith(']')) {
    return { key, values: splitInlineList(rest.slice(1, -1)), list: true };
  }
  return { key, values: [unquote(rest)], list: false };
}

/** The value written on the lines under a key: a list, or text kept as it is. */
function blockValue(key: string, lines: string[]): Property {
  const written = lines.filter((line) => line.trim() !== '');
  if (written.length === 0) {
    return { key, values: [], list: false };
  }
  const items = written.map((line) => LIST_ITEM.exec(line));
  if (items.every((item) => item !== null)) {
    return {
      key,
      values: items.map((item) => unquote(item?.[1] ?? '')).filter((item) => item !== ''),
      list: true,
    };
  }
  return { key, values: [written.map((line) => line.trim()).join(' ')], list: false };
}

function parseProperties(lines: string[]): Property[] {
  const properties: Property[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    index += 1;
    const match = /^\s/.test(line) ? null : KEY_LINE.exec(line.trimEnd());
    if (match === null) {
      continue;
    }
    const key = (match[1] ?? '').trim();
    const rest = (match[2] ?? '').trim();
    if (rest !== '' && rest !== '|' && rest !== '>') {
      properties.push(inlineValue(key, rest));
      continue;
    }
    // The value is on the lines below: everything indented, and list items
    // written at the key's own level, which YAML also allows.
    const block: string[] = [];
    while (index < lines.length) {
      const next = lines[index] ?? '';
      if (next.trim() !== '' && !/^\s/.test(next) && !next.startsWith('-')) {
        break;
      }
      block.push(next);
      index += 1;
    }
    properties.push(blockValue(key, block));
  }
  return properties;
}

/** Separates a note's frontmatter from its body. */
export function splitFrontmatter(text: string): SplitNote {
  const opening = OPENING.exec(text);
  if (opening === null) {
    return { properties: null, body: text };
  }
  const lines = text.slice(opening[0].length).split(/\r?\n/);
  const end = lines.findIndex((line) => CLOSING.test(line));
  if (end === -1) {
    return { properties: null, body: text };
  }
  return {
    properties: parseProperties(lines.slice(0, end)),
    body: lines.slice(end + 1).join('\n'),
  };
}
