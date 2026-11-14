import { describe, expect, it } from 'vitest';

import {
  basename,
  dirname,
  expandHome,
  isAbsolutePath,
  isHomePath,
  joinPath,
  localFileUrl,
  normalizePath,
} from './paths';

describe('isAbsolutePath and isHomePath', () => {
  it('tells the three kinds of path apart', () => {
    expect(isAbsolutePath('/a/b')).toBe(true);
    expect(isAbsolutePath('a/b')).toBe(false);
    expect(isAbsolutePath('~/a')).toBe(false);
    expect(isHomePath('~')).toBe(true);
    expect(isHomePath('~/a')).toBe(true);
    expect(isHomePath('~other/a')).toBe(false);
    expect(isHomePath('/a/~')).toBe(false);
  });
});

describe('normalizePath', () => {
  it('collapses dots and repeated slashes', () => {
    expect(normalizePath('/a//b/./c/')).toBe('/a/b/c');
    expect(normalizePath('/a/b/../c')).toBe('/a/c');
  });

  it('does not climb above the root', () => {
    expect(normalizePath('/../../a')).toBe('/a');
    expect(normalizePath('/')).toBe('/');
  });

  it('keeps leading parent steps of a relative path', () => {
    expect(normalizePath('../a/../../b')).toBe('../../b');
    expect(normalizePath('a/..')).toBe('.');
  });
});

describe('expandHome', () => {
  it('replaces a leading tilde with the home directory', () => {
    expect(expandHome('~', '/Users/sam')).toBe('/Users/sam');
    expect(expandHome('~/notes/a.md', '/Users/sam')).toBe('/Users/sam/notes/a.md');
    expect(expandHome('~/a', '/Users/sam/')).toBe('/Users/sam/a');
  });

  it('leaves every other path alone', () => {
    expect(expandHome('/tmp/a', '/Users/sam')).toBe('/tmp/a');
    expect(expandHome('~other/a', '/Users/sam')).toBe('~other/a');
    expect(expandHome('a/~/b', '/Users/sam')).toBe('a/~/b');
  });
});

describe('dirname and basename', () => {
  it('split a path at its last slash', () => {
    expect(dirname('/a/b/c.md')).toBe('/a/b');
    expect(basename('/a/b/c.md')).toBe('c.md');
  });

  it('handle files at the root and bare names', () => {
    expect(dirname('/c.md')).toBe('/');
    expect(dirname('c.md')).toBe('.');
    expect(dirname('/')).toBe('/');
    expect(basename('c.md')).toBe('c.md');
  });

  it('ignore a trailing slash', () => {
    expect(dirname('/a/b/')).toBe('/a');
    expect(basename('/a/b/')).toBe('b');
  });
});

describe('joinPath', () => {
  it('resolves a relative path against a directory', () => {
    expect(joinPath('/notes', 'a.md')).toBe('/notes/a.md');
    expect(joinPath('/notes/sub', '../img/a.png')).toBe('/notes/img/a.png');
    expect(joinPath('/notes', './a.md')).toBe('/notes/a.md');
    expect(joinPath('/', 'a.md')).toBe('/a.md');
  });

  it('lets an absolute path win', () => {
    expect(joinPath('/notes', '/etc/hosts')).toBe('/etc/hosts');
  });
});

describe('localFileUrl', () => {
  it('puts the absolute path after the local-file origin', () => {
    expect(localFileUrl('/notes/img/a.png')).toBe('localfile://localhost/notes/img/a.png');
  });

  it('escapes each segment but keeps the slashes', () => {
    expect(localFileUrl('/my notes/a#1?.png')).toBe(
      'localfile://localhost/my%20notes/a%231%3F.png',
    );
  });
});
