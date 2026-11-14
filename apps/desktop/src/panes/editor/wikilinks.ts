import { isMarkdownPath } from './file-kind';

export const WIKILINK_SCHEME = 'wikilink:';

export interface TextSegment {
  kind: 'text';
  value: string;
}

export interface WikilinkSegment {
  kind: 'wikilink';
  target: string;
  label: string;
}

export type Segment = TextSegment | WikilinkSegment;

const WIKILINK = /\[\[([^[\]|\n]+)(?:\|([^[\]\n]*))?\]\]/g;

/**
 * Splits text into plain runs and wikilinks. `[[Note]]` links to Note and
 * shows "Note"; `[[Note|label]]` shows "label". A link with a blank name
 * stays as text.
 */
export function splitWikilinks(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(WIKILINK)) {
    const target = (match[1] ?? '').trim();
    if (target === '') {
      continue;
    }
    if (match.index > last) {
      segments.push({ kind: 'text', value: text.slice(last, match.index) });
    }
    const label = (match[2] ?? '').trim();
    segments.push({ kind: 'wikilink', target, label: label === '' ? target : label });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    segments.push({ kind: 'text', value: text.slice(last) });
  }
  return segments;
}

export function wikilinkHref(target: string): string {
  return `${WIKILINK_SCHEME}${encodeURIComponent(target)}`;
}

/** The note name inside a wikilink href, or null when `href` is not one. */
export function parseWikilinkHref(href: string): string | null {
  if (!href.startsWith(WIKILINK_SCHEME)) {
    return null;
  }
  const encoded = href.slice(WIKILINK_SCHEME.length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/**
 * The file a note name points at: the name plus `.md`, with any `#heading`
 * part dropped. Null when nothing is left to name a file.
 */
export function wikilinkFileName(target: string): string | null {
  const hash = target.indexOf('#');
  const name = (hash === -1 ? target : target.slice(0, hash)).trim();
  if (name === '') {
    return null;
  }
  return isMarkdownPath(name) ? name : `${name}.md`;
}

/** The slice of a Markdown syntax tree node this module reads and writes. */
export interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

// Text inside a link is already a link. Code and inline code hold their text
// in `value`, not in child text nodes, so the walk never reaches it.
const SKIPPED_PARENTS = new Set(['link', 'linkReference']);

function toNodes(value: string): MarkdownNode[] {
  return splitWikilinks(value).map((segment) => {
    if (segment.kind === 'text') {
      return { type: 'text', value: segment.value };
    }
    return {
      type: 'link',
      url: wikilinkHref(segment.target),
      children: [{ type: 'text', value: segment.label }],
    };
  });
}

/** Rewrites wikilinks in a Markdown syntax tree into link nodes, in place. */
export function transformWikilinks(node: MarkdownNode): void {
  const children = node.children;
  if (children === undefined || SKIPPED_PARENTS.has(node.type)) {
    return;
  }
  node.children = children.flatMap((child) => {
    if (child.type === 'text' && child.value !== undefined && child.value.includes('[[')) {
      return toNodes(child.value);
    }
    transformWikilinks(child);
    return [child];
  });
}

/** A remark plugin: `[[Note]]` and `[[Note|label]]` become links. */
export function remarkWikilinks() {
  return transformWikilinks;
}
