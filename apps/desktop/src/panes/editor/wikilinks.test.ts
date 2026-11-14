import { describe, expect, it } from 'vitest';

import {
  type MarkdownNode,
  parseWikilinkHref,
  remarkWikilinks,
  splitWikilinks,
  transformWikilinks,
  wikilinkFileName,
  wikilinkHref,
} from './wikilinks';

describe('splitWikilinks', () => {
  it('returns plain text as one segment', () => {
    expect(splitWikilinks('no links here')).toEqual([{ kind: 'text', value: 'no links here' }]);
    expect(splitWikilinks('')).toEqual([]);
  });

  it('finds a link and uses its name as the label', () => {
    expect(splitWikilinks('see [[Note name]] now')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'wikilink', target: 'Note name', label: 'Note name' },
      { kind: 'text', value: ' now' },
    ]);
  });

  it('reads a label after the pipe', () => {
    expect(splitWikilinks('[[Note name|the note]]')).toEqual([
      { kind: 'wikilink', target: 'Note name', label: 'the note' },
    ]);
  });

  it('trims the name and the label, and falls back when the label is blank', () => {
    expect(splitWikilinks('[[ Note | label ]]')).toEqual([
      { kind: 'wikilink', target: 'Note', label: 'label' },
    ]);
    expect(splitWikilinks('[[Note|]]')).toEqual([
      { kind: 'wikilink', target: 'Note', label: 'Note' },
    ]);
  });

  it('finds several links in one run of text', () => {
    expect(splitWikilinks('[[A]][[B|b]] and [[C]]')).toEqual([
      { kind: 'wikilink', target: 'A', label: 'A' },
      { kind: 'wikilink', target: 'B', label: 'b' },
      { kind: 'text', value: ' and ' },
      { kind: 'wikilink', target: 'C', label: 'C' },
    ]);
  });

  it('leaves malformed links as text', () => {
    for (const text of [
      '[[]]',
      '[[  ]]',
      '[[|label]]',
      '[[open',
      'close]]',
      '[single]',
      '[[a\nb]]',
    ]) {
      expect(splitWikilinks(text)).toEqual([{ kind: 'text', value: text }]);
    }
  });

  it('keeps the text around a malformed link next to a real one', () => {
    expect(splitWikilinks('[[ ]] then [[A]]')).toEqual([
      { kind: 'text', value: '[[ ]] then ' },
      { kind: 'wikilink', target: 'A', label: 'A' },
    ]);
  });
});

describe('wikilinkHref and parseWikilinkHref', () => {
  it('round-trip a name with spaces and punctuation', () => {
    const href = wikilinkHref('Q&A: 100% notes/2024');
    expect(href).toBe('wikilink:Q%26A%3A%20100%25%20notes%2F2024');
    expect(parseWikilinkHref(href)).toBe('Q&A: 100% notes/2024');
  });

  it('return null for any other address', () => {
    expect(parseWikilinkHref('https://example.com')).toBeNull();
    expect(parseWikilinkHref('notes.md')).toBeNull();
  });

  it('return the raw name when the escapes are broken', () => {
    expect(parseWikilinkHref('wikilink:100%')).toBe('100%');
  });
});

describe('wikilinkFileName', () => {
  it('adds the Markdown extension', () => {
    expect(wikilinkFileName('Note name')).toBe('Note name.md');
    expect(wikilinkFileName('v1.2 plan')).toBe('v1.2 plan.md');
  });

  it('keeps an extension that is already Markdown', () => {
    expect(wikilinkFileName('Note.md')).toBe('Note.md');
    expect(wikilinkFileName('Page.mdx')).toBe('Page.mdx');
  });

  it('drops a heading part', () => {
    expect(wikilinkFileName('Note#Section two')).toBe('Note.md');
  });

  it('is null when no name is left', () => {
    expect(wikilinkFileName('#Section')).toBeNull();
    expect(wikilinkFileName('   ')).toBeNull();
  });
});

function text(value: string): MarkdownNode {
  return { type: 'text', value };
}

describe('transformWikilinks', () => {
  it('turns a wikilink in a paragraph into a link node', () => {
    const tree: MarkdownNode = {
      type: 'root',
      children: [{ type: 'paragraph', children: [text('see [[Note|here]].')] }],
    };
    transformWikilinks(tree);
    expect(tree.children?.[0]?.children).toEqual([
      text('see '),
      { type: 'link', url: 'wikilink:Note', children: [text('here')] },
      text('.'),
    ]);
  });

  it('reaches text nested in emphasis, lists and table cells', () => {
    const tree: MarkdownNode = {
      type: 'root',
      children: [
        {
          type: 'list',
          children: [
            {
              type: 'listItem',
              children: [
                { type: 'paragraph', children: [{ type: 'strong', children: [text('[[A]]')] }] },
              ],
            },
          ],
        },
      ],
    };
    transformWikilinks(tree);
    const strong = tree.children?.[0]?.children?.[0]?.children?.[0]?.children?.[0];
    expect(strong?.children).toEqual([{ type: 'link', url: 'wikilink:A', children: [text('A')] }]);
  });

  it('leaves fenced code and inline code alone', () => {
    const tree: MarkdownNode = {
      type: 'root',
      children: [
        { type: 'code', value: '[[A]]' },
        { type: 'paragraph', children: [{ type: 'inlineCode', value: '[[B]]' }] },
      ],
    };
    const before = structuredClone(tree);
    transformWikilinks(tree);
    expect(tree).toEqual(before);
  });

  it('does not nest a link inside an existing link', () => {
    const tree: MarkdownNode = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'link', url: 'https://example.com', children: [text('[[A]]')] }],
        },
      ],
    };
    const before = structuredClone(tree);
    transformWikilinks(tree);
    expect(tree).toEqual(before);
  });

  it('keeps text nodes without wikilinks as the same objects', () => {
    const plain = text('nothing to do');
    const tree: MarkdownNode = {
      type: 'root',
      children: [{ type: 'paragraph', children: [plain] }],
    };
    transformWikilinks(tree);
    expect(tree.children?.[0]?.children?.[0]).toBe(plain);
  });
});

describe('remarkWikilinks', () => {
  it('is a plugin that returns the tree transformer', () => {
    expect(remarkWikilinks()).toBe(transformWikilinks);
  });
});
