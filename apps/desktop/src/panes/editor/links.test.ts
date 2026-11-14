import { describe, expect, it } from 'vitest';

import { classifyLink, resolveImageSrc } from './links';
import { wikilinkHref } from './wikilinks';

const DIR = '/notes/work';

describe('classifyLink', () => {
  it('sends web links to a web pane', () => {
    expect(classifyLink('https://example.com/a?b=1#c', DIR)).toEqual({
      kind: 'web',
      url: 'https://example.com/a?b=1#c',
    });
    expect(classifyLink('HTTP://example.com', DIR)).toEqual({
      kind: 'web',
      url: 'HTTP://example.com',
    });
    expect(classifyLink('//example.com/a', DIR)).toEqual({
      kind: 'web',
      url: 'https://example.com/a',
    });
  });

  it('opens a relative Markdown or text file in an editor', () => {
    expect(classifyLink('other.md', DIR)).toEqual({ kind: 'editor', path: '/notes/work/other.md' });
    expect(classifyLink('./sub/todo.txt', DIR)).toEqual({
      kind: 'editor',
      path: '/notes/work/sub/todo.txt',
    });
    expect(classifyLink('../home/plan.md', DIR)).toEqual({
      kind: 'editor',
      path: '/notes/home/plan.md',
    });
  });

  it('drops the fragment and query, and decodes escapes', () => {
    expect(classifyLink('my%20note.md#heading', DIR)).toEqual({
      kind: 'editor',
      path: '/notes/work/my note.md',
    });
    expect(classifyLink('a.md?raw=1', DIR)).toEqual({ kind: 'editor', path: '/notes/work/a.md' });
  });

  it('opens absolute and home paths as they are', () => {
    expect(classifyLink('/etc/hosts', DIR)).toEqual({ kind: 'editor', path: '/etc/hosts' });
    expect(classifyLink('~/notes/a.md', DIR)).toEqual({ kind: 'editor', path: '~/notes/a.md' });
    expect(classifyLink('/etc/hosts', null)).toEqual({ kind: 'editor', path: '/etc/hosts' });
  });

  it('shows pages, images and PDFs in a web pane through the local-file scheme', () => {
    expect(classifyLink('report.pdf', DIR)).toEqual({
      kind: 'web',
      url: 'localfile://localhost/notes/work/report.pdf',
    });
    expect(classifyLink('site/index.HTML', DIR)).toEqual({
      kind: 'web',
      url: 'localfile://localhost/notes/work/site/index.HTML',
    });
  });

  it('opens a wikilink as a Markdown file in the same directory', () => {
    expect(classifyLink(wikilinkHref('Note name'), DIR)).toEqual({
      kind: 'editor',
      path: '/notes/work/Note name.md',
    });
    expect(classifyLink(wikilinkHref('sub/Deep#Part'), DIR)).toEqual({
      kind: 'editor',
      path: '/notes/work/sub/Deep.md',
    });
  });

  it('does nothing for links it cannot or should not follow', () => {
    const none = { kind: 'none' };
    expect(classifyLink('#heading', DIR)).toEqual(none);
    expect(classifyLink('', DIR)).toEqual(none);
    expect(classifyLink('mailto:sam@example.com', DIR)).toEqual(none);
    expect(classifyLink('javascript:alert(1)', DIR)).toEqual(none);
    expect(classifyLink('file:///etc/hosts', DIR)).toEqual(none);
    expect(classifyLink('other.md', null)).toEqual(none);
    expect(classifyLink(wikilinkHref('Note'), null)).toEqual(none);
    expect(classifyLink(wikilinkHref('#Part'), DIR)).toEqual(none);
  });
});

describe('resolveImageSrc', () => {
  it('resolves a relative path against the file directory', () => {
    expect(resolveImageSrc('img/a.png', DIR)).toBe('localfile://localhost/notes/work/img/a.png');
    expect(resolveImageSrc('../shared/b c.jpg', DIR)).toBe(
      'localfile://localhost/notes/shared/b%20c.jpg',
    );
  });

  it('does not escape an already escaped path twice', () => {
    expect(resolveImageSrc('img/b%20c.png', DIR)).toBe(
      'localfile://localhost/notes/work/img/b%20c.png',
    );
  });

  it('serves an absolute path through the local-file scheme', () => {
    expect(resolveImageSrc('/pics/a.png', DIR)).toBe('localfile://localhost/pics/a.png');
    expect(resolveImageSrc('/pics/a.png', null)).toBe('localfile://localhost/pics/a.png');
  });

  it('passes web and other addresses through', () => {
    expect(resolveImageSrc('https://example.com/a.png', DIR)).toBe('https://example.com/a.png');
    expect(resolveImageSrc('//example.com/a.png', DIR)).toBe('//example.com/a.png');
    expect(resolveImageSrc('data:image/png;base64,AAAA', DIR)).toBe('data:image/png;base64,AAAA');
  });

  it('leaves a relative path alone when the buffer has no file', () => {
    expect(resolveImageSrc('img/a.png', null)).toBe('img/a.png');
  });
});
