import { describe, expect, it } from 'vitest';

import { isHtmlPath, lexicalParent, localFileUrl, splitBreadcrumbs } from './paths';

describe('splitBreadcrumbs', () => {
  it('splits an absolute path, starting at the root', () => {
    expect(splitBreadcrumbs('/Users/pete/src')).toEqual([
      { label: '/', path: '/' },
      { label: 'Users', path: '/Users' },
      { label: 'pete', path: '/Users/pete' },
      { label: 'src', path: '/Users/pete/src' },
    ]);
  });

  it('gives the root alone for the root', () => {
    expect(splitBreadcrumbs('/')).toEqual([{ label: '/', path: '/' }]);
  });

  it('ignores trailing and repeated slashes', () => {
    expect(splitBreadcrumbs('/Users//pete/')).toEqual([
      { label: '/', path: '/' },
      { label: 'Users', path: '/Users' },
      { label: 'pete', path: '/Users/pete' },
    ]);
  });

  it('keeps a home shorthand as the first segment', () => {
    expect(splitBreadcrumbs('~/notes')).toEqual([
      { label: '~', path: '~' },
      { label: 'notes', path: '~/notes' },
    ]);
  });

  it('keeps spaces and dots in names', () => {
    expect(splitBreadcrumbs('/tmp/my files/.cache')).toEqual([
      { label: '/', path: '/' },
      { label: 'tmp', path: '/tmp' },
      { label: 'my files', path: '/tmp/my files' },
      { label: '.cache', path: '/tmp/my files/.cache' },
    ]);
  });

  it('gives nothing for an empty path', () => {
    expect(splitBreadcrumbs('')).toEqual([]);
  });
});

describe('lexicalParent', () => {
  it('drops the last segment', () => {
    expect(lexicalParent('/Users/pete/src')).toBe('/Users/pete');
    expect(lexicalParent('/Users/pete/src/')).toBe('/Users/pete');
  });

  it('gives the root for a top-level directory', () => {
    expect(lexicalParent('/Users')).toBe('/');
  });

  it('gives null where there is nothing above', () => {
    expect(lexicalParent('/')).toBeNull();
    expect(lexicalParent('~')).toBeNull();
    expect(lexicalParent('')).toBeNull();
  });

  it('works on a home shorthand', () => {
    expect(lexicalParent('~/notes')).toBe('~');
  });
});

describe('isHtmlPath', () => {
  it('accepts .html and .htm in any case', () => {
    expect(isHtmlPath('/site/index.html')).toBe(true);
    expect(isHtmlPath('/site/old.htm')).toBe(true);
    expect(isHtmlPath('/site/INDEX.HTML')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isHtmlPath('/site/index.html.bak')).toBe(false);
    expect(isHtmlPath('/site/html')).toBe(false);
    expect(isHtmlPath('/site/notes.md')).toBe(false);
  });
});

describe('localFileUrl', () => {
  it('puts the absolute path after the host', () => {
    expect(localFileUrl('/Users/pete/site/index.html')).toBe(
      'localfile://localhost/Users/pete/site/index.html',
    );
  });

  it('escapes characters that would end the path', () => {
    expect(localFileUrl('/tmp/my site/a#b?.html')).toBe(
      'localfile://localhost/tmp/my%20site/a%23b%3F.html',
    );
  });

  it('gives an address whose path decodes back to the file', () => {
    const url = new URL(localFileUrl('/tmp/my site/100%.html'));

    expect(decodeURIComponent(url.pathname)).toBe('/tmp/my site/100%.html');
  });
});
