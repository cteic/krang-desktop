import { describe, expect, it } from 'vitest';

import {
  embedHref,
  MAX_MARK_RUN,
  type MarkNode,
  parseEmbed,
  parseEmbedHref,
  splitMarks,
  transformObsidianMarks,
} from './obsidian-marks';

function kinds(nodes: MarkNode[]): string[] {
  return nodes.map((node) => node.type);
}

function textOf(node: MarkNode | undefined): string {
  if (node === undefined) {
    return '';
  }
  return node.value ?? (node.children ?? []).map(textOf).join('');
}

describe('parseEmbed', () => {
  it('reads a name with no size, a width, and a width and height', () => {
    expect(parseEmbed('plot.png')).toEqual({ name: 'plot.png', width: null, height: null });
    expect(parseEmbed('plot.png|300')).toEqual({ name: 'plot.png', width: 300, height: null });
    expect(parseEmbed('figs/plot.png | 300x200')).toEqual({
      name: 'figs/plot.png',
      width: 300,
      height: 200,
    });
  });

  it('ignores a label that is not a size', () => {
    expect(parseEmbed('plot.png|the plot')).toEqual({
      name: 'plot.png',
      width: null,
      height: null,
    });
  });

  it('round-trips a name through an embed address', () => {
    expect(parseEmbedHref(embedHref('my plot #2.png'))).toBe('my plot #2.png');
    expect(parseEmbedHref('https://example.org/a.png')).toBeNull();
  });
});

describe('splitMarks', () => {
  it('finds a highlight, a tag and an embed in one run of text', () => {
    const nodes = splitMarks('A ==key point== here #clm-candidate ![[plot.png|300]] end');
    expect(kinds(nodes)).toEqual(['text', 'highlight', 'text', 'tag', 'text', 'image', 'text']);
    expect(textOf(nodes[1])).toBe('key point');
    expect(nodes[1]?.data?.hName).toBe('mark');
    expect(textOf(nodes[3])).toBe('#clm-candidate');
    expect(nodes[5]?.url).toBe('embed:plot.png');
    expect(nodes[5]?.data?.hProperties).toEqual({ width: 300 });
  });

  it('leaves wikilinks, and a heading part inside one, as text', () => {
    const nodes = splitMarks('see [[Note#part]] and [[Other|label]]');
    expect(nodes).toEqual([{ type: 'text', value: 'see [[Note#part]] and [[Other|label]]' }]);
  });

  it('does not take numbers, mid-word hashes or lone equals signs for marks', () => {
    for (const text of ['issue #12', 'a#b', 'x == y', 'a ==  == b']) {
      expect(splitMarks(text)).toEqual([{ type: 'text', value: text }]);
    }
  });

  it('reads tags with a path and a tag at the start', () => {
    const nodes = splitMarks('#area/lab then #2024q1');
    expect(nodes.filter((node) => node.type === 'tag').map(textOf)).toEqual([
      '#area/lab',
      '#2024q1',
    ]);
  });

  it('keeps a wikilink inside a highlight for the wikilink pass', () => {
    const nodes = splitMarks('==see [[Note]]==');
    expect(nodes[0]?.children).toEqual([{ type: 'text', value: 'see [[Note]]' }]);
  });
});

// The pattern the splitter used before it was made linear. It finds the
// same highlights, slowly.
const OLD_HIGHLIGHT = /==(?=\S)([^\n]*?\S)==/g;

function highlightsOf(nodes: MarkNode[]): string[] {
  return nodes.filter((node) => node.type === 'highlight').map(textOf);
}

describe('splitMarks on hostile text', () => {
  it('splits an 80 KB line of highlight openings with no end in linear time', () => {
    const line = '==a '.repeat(20_000);
    expect(line.length).toBe(80_000);
    const started = performance.now();
    const nodes = splitMarks(line);
    const took = performance.now() - started;
    expect(nodes).toEqual([{ type: 'text', value: line }]);
    // The old pattern took most of a second here. One pass takes a few milliseconds.
    expect(took).toBeLessThan(150);
  });

  it('stays fast on other long lines built to make a pattern look back', () => {
    const lines = [
      '=='.repeat(40_000),
      '==a'.repeat(26_000),
      'a== '.repeat(20_000),
      '![[a '.repeat(16_000),
      '[[a '.repeat(20_000),
      `#${'1'.repeat(80_000)}`,
      '#1 '.repeat(26_000),
      `==${'a '.repeat(40_000)}`,
    ];
    for (const line of lines) {
      const started = performance.now();
      splitMarks(line);
      expect(performance.now() - started).toBeLessThan(150);
    }
  });

  it('finds the same highlights as the old pattern', () => {
    const alphabet = ['=', '=', '=', 'a', ' ', '\n', 'b'];
    let seed = 7;
    function next(): number {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    }
    for (let round = 0; round < 3000; round += 1) {
      let text = '';
      const length = next() % 24;
      for (let at = 0; at < length; at += 1) {
        text += alphabet[next() % alphabet.length] ?? '';
      }
      const expected = [...text.matchAll(OLD_HIGHLIGHT)].map((match) => match[1] ?? '');
      expect(highlightsOf(splitMarks(text)), JSON.stringify(text)).toEqual(expected);
      expect(splitMarks(text).map(textOf).join('').length, JSON.stringify(text)).toBe(
        text.length - expected.length * 4,
      );
    }
  });

  it('keeps a highlight on its own line', () => {
    expect(splitMarks('==a\nb==')).toEqual([{ type: 'text', value: '==a\nb==' }]);
    expect(highlightsOf(splitMarks('==a\n==b== c=='))).toEqual(['b']);
  });
});

function paragraph(text: string): MarkNode {
  return { type: 'paragraph', children: [{ type: 'text', value: text }] };
}

describe('transformObsidianMarks', () => {
  it('turns a quote that opens with a callout marker into a titled box', () => {
    const quote: MarkNode = {
      type: 'blockquote',
      children: [paragraph('[!info] Read this\nfirst line'), paragraph('second')],
    };
    transformObsidianMarks(quote);

    expect(quote.data).toEqual({
      hName: 'div',
      hProperties: { className: ['editor-callout'], dataCallout: 'info' },
    });
    expect((quote.children ?? []).map(textOf)).toEqual(['Read this', 'first line', 'second']);
    expect(quote.children?.[0]?.data?.hProperties).toEqual({
      className: ['editor-callout-title'],
    });
  });

  it('names a callout after its kind when it has no title', () => {
    const quote: MarkNode = {
      type: 'blockquote',
      children: [paragraph('[!WARNING]-'), paragraph('body')],
    };
    transformObsidianMarks(quote);
    expect((quote.children ?? []).map(textOf)).toEqual(['Warning', 'body']);
    expect(quote.data?.hProperties?.['dataCallout']).toBe('warning');
  });

  it('leaves an ordinary quote alone', () => {
    const quote: MarkNode = { type: 'blockquote', children: [paragraph('just a quote')] };
    transformObsidianMarks(quote);
    expect(quote.data).toBeUndefined();
    expect((quote.children ?? []).map(textOf)).toEqual(['just a quote']);
  });

  it('collapses a query block to one line and keeps other code', () => {
    const root: MarkNode = {
      type: 'root',
      children: [
        { type: 'code', lang: 'dataview', value: 'TABLE file.name' },
        { type: 'code', lang: 'datacorejsx', value: 'return <div />' },
        { type: 'code', lang: 'python', value: 'print("#not-a-tag")' },
      ],
    };
    transformObsidianMarks(root);

    expect(root.children?.[0]).toEqual({
      type: 'paragraph',
      children: [{ type: 'text', value: 'dataview query block' }],
      data: { hName: 'div', hProperties: { className: ['editor-query-block'] } },
    });
    expect(textOf(root.children?.[1])).toBe('datacorejsx query block');
    expect(root.children?.[2]).toEqual({
      type: 'code',
      lang: 'python',
      value: 'print("#not-a-tag")',
    });
  });

  it('does not rewrite text that is already inside a link', () => {
    const link: MarkNode = { type: 'link', url: 'https://example.org', children: [] };
    link.children = [{ type: 'text', value: '#tag ==x==' }];
    const root: MarkNode = { type: 'root', children: [{ type: 'paragraph', children: [link] }] };
    transformObsidianMarks(root);
    expect(link.children).toEqual([{ type: 'text', value: '#tag ==x==' }]);
  });

  it('leaves a run longer than the cap as plain text, and splits one at the cap', () => {
    const long = `==x== ${'a'.repeat(MAX_MARK_RUN)}`;
    const node = paragraph(long);
    const started = performance.now();
    transformObsidianMarks(node);
    expect(performance.now() - started).toBeLessThan(50);
    expect(node.children).toEqual([{ type: 'text', value: long }]);

    const atCap = paragraph(`==x== ${'a'.repeat(MAX_MARK_RUN - 6)}`);
    transformObsidianMarks(atCap);
    expect(kinds(atCap.children ?? [])).toEqual(['highlight', 'text']);
  });

  it('handles an 80 KB hostile line inside a document within a time bound', () => {
    const node: MarkNode = { type: 'root', children: [paragraph('==a '.repeat(20_000))] };
    const started = performance.now();
    transformObsidianMarks(node);
    expect(performance.now() - started).toBeLessThan(150);
  });
});
