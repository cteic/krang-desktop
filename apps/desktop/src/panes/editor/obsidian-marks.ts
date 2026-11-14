/**
 * The parts of Obsidian's Markdown that plain Markdown does not have:
 * callouts, `==highlights==`, `#tags`, `![[embeds]]`, and the query blocks
 * some plugins run. Each is rewritten in the syntax tree so the preview can
 * draw it. Nothing here runs a query or reads a file.
 */

export const EMBED_SCHEME = 'embed:';

export interface MarkData {
  hName?: string;
  hProperties?: Record<string, string | number | string[]>;
}

/** The slice of a Markdown syntax tree node this module reads and writes. */
export interface MarkNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  lang?: string | null;
  children?: MarkNode[];
  data?: MarkData;
}

export interface Embed {
  /** The file name as written, without any size. */
  name: string;
  width: number | null;
  height: number | null;
}

// Blocks that a plugin would replace with the result of a query.
const QUERY_LANGUAGES = new Set(['datacorejsx', 'datacore', 'dataview', 'dataviewjs']);

// Text inside a link is already a link.
const SKIPPED_PARENTS = new Set(['link', 'linkReference']);

// In order: an embed, a wikilink (left for the wikilink pass), the opening
// of a highlight, a tag. A tag starts a word and holds at least one letter,
// so `#1` is not one. The pattern finds only where a highlight opens. Its
// end is looked up in a list made once, so a line of openings with no end
// costs one pass and not one pass per opening.
const INLINE =
  /!\[\[([^[\]\n]+)\]\]|(\[\[[^[\]\n]+\]\])|(==)(?=\S)|(?<!\S)#([\p{L}\p{N}_/-]*[\p{L}_][\p{L}\p{N}_/-]*)/gu;

/**
 * The longest run of text that is searched for marks. A longer run is
 * shown as plain text. No line a person writes comes near it.
 */
export const MAX_MARK_RUN = 32_768;

const CALLOUT = /^\[!([\w-]+)\][+-]?[ \t]*([^\n]*)(?:\n|$)/;

const SIZE = /^(\d+)(?:x(\d+))?$/;

/** Reads the inside of `![[name|300]]` or `![[name|300x200]]`. */
export function parseEmbed(inner: string): Embed {
  const bar = inner.indexOf('|');
  const name = (bar === -1 ? inner : inner.slice(0, bar)).trim();
  const size = bar === -1 ? null : SIZE.exec(inner.slice(bar + 1).trim());
  return {
    name,
    width: size?.[1] === undefined ? null : Number(size[1]),
    height: size?.[2] === undefined ? null : Number(size[2]),
  };
}

export function embedHref(name: string): string {
  return `${EMBED_SCHEME}${encodeURIComponent(name)}`;
}

/** The file name inside an embed address, or null when `src` is not one. */
export function parseEmbedHref(src: string): string | null {
  if (!src.startsWith(EMBED_SCHEME)) {
    return null;
  }
  const encoded = src.slice(EMBED_SCHEME.length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function textNode(value: string): MarkNode {
  return { type: 'text', value };
}

function embedNode(inner: string): MarkNode {
  const embed = parseEmbed(inner);
  const hProperties: Record<string, number> = {};
  if (embed.width !== null) {
    hProperties['width'] = embed.width;
  }
  if (embed.height !== null) {
    hProperties['height'] = embed.height;
  }
  return {
    type: 'image',
    url: embedHref(embed.name),
    alt: embed.name,
    data: { hProperties },
  };
}

/**
 * Every place a highlight can end: a `==` that follows a character other
 * than a space. In rising order.
 */
function highlightEnds(text: string): number[] {
  const ends: number[] = [];
  for (let at = text.indexOf('==', 1); at !== -1; at = text.indexOf('==', at + 1)) {
    if (!/\s/.test(text.charAt(at - 1))) {
      ends.push(at);
    }
  }
  return ends;
}

/** Splits one run of text into text, embeds, highlights and tags. */
export function splitMarks(text: string): MarkNode[] {
  const nodes: MarkNode[] = [];
  const ends = highlightEnds(text);
  let nextEnd = 0;
  let lineEnd = -1;
  let last = 0;
  function pushText(value: string) {
    const previous = nodes[nodes.length - 1];
    if (previous?.type === 'text' && previous.value !== undefined) {
      previous.value += value;
    } else if (value !== '') {
      nodes.push(textNode(value));
    }
  }
  const pattern = new RegExp(INLINE);
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const [whole, embed, wikilink, opening, tag] = match;
    if (opening !== undefined) {
      // The highlight ends at the first end on the same line that leaves
      // at least one character inside.
      const inside = match.index + 2;
      if (lineEnd < match.index) {
        const found = text.indexOf('\n', match.index);
        lineEnd = found === -1 ? text.length : found;
      }
      while ((ends[nextEnd] ?? Infinity) <= inside) {
        nextEnd += 1;
      }
      const end = ends[nextEnd];
      if (end === undefined || end > lineEnd) {
        // No end: these two characters are text. Look again from the next one.
        pattern.lastIndex = match.index + 1;
        continue;
      }
      pushText(text.slice(last, match.index));
      nodes.push({
        type: 'highlight',
        data: { hName: 'mark' },
        children: splitMarks(text.slice(inside, end)),
      });
      last = end + 2;
      pattern.lastIndex = last;
      continue;
    }
    pushText(text.slice(last, match.index));
    last = match.index + whole.length;
    if (embed !== undefined && embed.trim() !== '') {
      nodes.push(embedNode(embed));
    } else if (tag !== undefined) {
      nodes.push({
        type: 'tag',
        data: { hName: 'span', hProperties: { className: ['editor-tag'] } },
        children: [textNode(`#${tag}`)],
      });
    } else {
      pushText(wikilink ?? whole);
    }
  }
  pushText(text.slice(last));
  return nodes;
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Turns a quote that opens with `[!kind] Title` into a callout box. The
 * first line becomes the title; with no title the kind stands in for it.
 */
function toCallout(quote: MarkNode): void {
  const first = quote.children?.[0];
  const opening = first?.type === 'paragraph' ? first.children?.[0] : undefined;
  if (quote.children === undefined || first === undefined || opening?.type !== 'text') {
    return;
  }
  const match = CALLOUT.exec(opening.value ?? '');
  if (match === null) {
    return;
  }
  const kind = (match[1] ?? '').toLowerCase();
  const written = (match[2] ?? '').trim();
  const rest = (opening.value ?? '').slice(match[0].length);
  if (rest === '') {
    first.children = (first.children ?? []).slice(1);
  } else {
    opening.value = rest;
  }
  const title: MarkNode = {
    type: 'paragraph',
    data: { hName: 'div', hProperties: { className: ['editor-callout-title'] } },
    children: [textNode(written === '' ? titleCase(kind) : written)],
  };
  const body = (first.children ?? []).length === 0 ? quote.children.slice(1) : quote.children;
  quote.children = [title, ...body];
  quote.data = {
    hName: 'div',
    hProperties: { className: ['editor-callout'], dataCallout: kind },
  };
}

/** Replaces a query block with one muted line that names it. */
function toQueryPlaceholder(code: MarkNode): void {
  const language = (code.lang ?? '').toLowerCase();
  code.type = 'paragraph';
  delete code.value;
  delete code.lang;
  code.children = [textNode(`${language} query block`)];
  code.data = { hName: 'div', hProperties: { className: ['editor-query-block'] } };
}

/** Rewrites Obsidian's extra syntax in a Markdown syntax tree, in place. */
export function transformObsidianMarks(node: MarkNode): void {
  if (node.type === 'code') {
    if (QUERY_LANGUAGES.has((node.lang ?? '').toLowerCase())) {
      toQueryPlaceholder(node);
    }
    return;
  }
  if (node.type === 'blockquote') {
    toCallout(node);
  }
  const children = node.children;
  if (children === undefined || SKIPPED_PARENTS.has(node.type)) {
    return;
  }
  node.children = children.flatMap((child) => {
    if (child.type === 'text' && child.value !== undefined && /[=#[]/.test(child.value)) {
      return child.value.length > MAX_MARK_RUN ? [child] : splitMarks(child.value);
    }
    transformObsidianMarks(child);
    return [child];
  });
}

/** A remark plugin. Run it before the wikilink plugin, so embeds are seen first. */
export function remarkObsidianMarks() {
  return transformObsidianMarks;
}
