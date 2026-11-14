import { describe, expect, it } from 'vitest';

import { splitFrontmatter } from './frontmatter';

describe('splitFrontmatter', () => {
  it('leaves a note with no frontmatter alone', () => {
    expect(splitFrontmatter('# Title\n\ntext')).toEqual({
      properties: null,
      body: '# Title\n\ntext',
    });
  });

  it('reads plain values, quoted values and both kinds of list', () => {
    const note = [
      '---',
      'kind: claim',
      'template: "[[Claim]]"',
      'tags:',
      '  - "#alpha"',
      '  - beta',
      'aliases:',
      '- First name',
      'authors: [Ada, "Lovelace, A."]',
      'empty:',
      '---',
      '# Title',
      'body',
    ].join('\n');

    expect(splitFrontmatter(note)).toEqual({
      properties: [
        { key: 'kind', values: ['claim'], list: false },
        { key: 'template', values: ['[[Claim]]'], list: false },
        { key: 'tags', values: ['#alpha', 'beta'], list: true },
        { key: 'aliases', values: ['First name'], list: true },
        { key: 'authors', values: ['Ada', 'Lovelace, A.'], list: true },
        { key: 'empty', values: [], list: false },
      ],
      body: '# Title\nbody',
    });
  });

  it('keeps a nested or multi-line value as text', () => {
    const note = '---\nsummary: >\n  one\n  two\nmeta:\n  depth: 2\n---\nbody';
    expect(splitFrontmatter(note).properties).toEqual([
      { key: 'summary', values: ['one two'], list: false },
      { key: 'meta', values: ['depth: 2'], list: false },
    ]);
  });

  it('keeps a value that holds a colon or a link', () => {
    const note = '---\nsource: https://example.org/a\ntime: 10:30\n---\n';
    expect(splitFrontmatter(note).properties).toEqual([
      { key: 'source', values: ['https://example.org/a'], list: false },
      { key: 'time', values: ['10:30'], list: false },
    ]);
  });

  it('reads a block with Windows line endings', () => {
    expect(splitFrontmatter('---\r\nkind: claim\r\n---\r\nbody')).toEqual({
      properties: [{ key: 'kind', values: ['claim'], list: false }],
      body: 'body',
    });
  });

  it('treats an unclosed block, or a rule further down, as body text', () => {
    expect(splitFrontmatter('---\nkind: claim\nbody').properties).toBeNull();
    expect(splitFrontmatter('intro\n\n---\nkind: claim\n---\n').properties).toBeNull();
  });
});
