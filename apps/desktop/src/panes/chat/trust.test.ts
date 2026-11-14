// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  folderKey,
  isHomeDirectory,
  isTrustedFolder,
  needsHome,
  readTrustedFolders,
  trustFolder,
} from './trust';

const KEY = 'chat.trusted-folders';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isHomeDirectory', () => {
  it('knows the spellings of home', () => {
    expect(isHomeDirectory(null)).toBe(true);
    expect(isHomeDirectory('~')).toBe(true);
    expect(isHomeDirectory('~/')).toBe(true);
    expect(isHomeDirectory('~/vault')).toBe(false);
    expect(isHomeDirectory('/Users/tester')).toBe(false);
  });
});

describe('needsHome', () => {
  it('is true only for a path below home', () => {
    expect(needsHome('~/vault')).toBe(true);
    expect(needsHome('~')).toBe(false);
    expect(needsHome(null)).toBe(false);
    expect(needsHome('/work')).toBe(false);
  });
});

describe('folderKey', () => {
  it('is the absolute path without trailing slashes', () => {
    expect(folderKey('/work/vault', null)).toBe('/work/vault');
    expect(folderKey('/work/vault//', null)).toBe('/work/vault');
    expect(folderKey('/', null)).toBe('/');
  });

  it('puts a home path under the home directory', () => {
    expect(folderKey('~/vault', '/Users/tester')).toBe('/Users/tester/vault');
    expect(folderKey('~/vault/', '/Users/tester/')).toBe('/Users/tester/vault');
  });

  it('has no key until the home directory is known, or for a relative path', () => {
    expect(folderKey('~/vault', null)).toBeNull();
    expect(folderKey('~/vault', 'not-absolute')).toBeNull();
    expect(folderKey('vault', '/Users/tester')).toBeNull();
    expect(folderKey(null, '/Users/tester')).toBeNull();
  });

  it('never collapses dot segments, so a path through a link keeps its own key', () => {
    expect(folderKey('/work/trusted/link/..', null)).toBe('/work/trusted/link/..');
    expect(folderKey('~/trusted/link/..', '/Users/tester')).toBe('/Users/tester/trusted/link/..');
  });
});

describe('trusted folders', () => {
  it('remembers a folder across reads, and only that folder', () => {
    expect(isTrustedFolder('/work/vault')).toBe(false);
    expect(trustFolder('/work/vault')).toBe(true);
    expect(isTrustedFolder('/work/vault')).toBe(true);
    expect(isTrustedFolder('/work/vault/inner')).toBe(false);
    expect(isTrustedFolder('/work')).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBe('["/work/vault"]');
  });

  it('stores a folder once', () => {
    trustFolder('/work/vault');
    trustFolder('/work/vault');
    trustFolder('/work/other');
    expect(readTrustedFolders()).toEqual(['/work/vault', '/work/other']);
  });

  it('refuses a path that is not absolute', () => {
    expect(trustFolder('~/vault')).toBe(false);
    expect(trustFolder('')).toBe(false);
    expect(readTrustedFolders()).toEqual([]);
  });

  it('reads malformed storage as no trusted folders', () => {
    for (const stored of ['not json', '{"/work/vault":true}', '["/work/vault",7]', 'true']) {
      window.localStorage.setItem(KEY, stored);
      expect(readTrustedFolders()).toEqual([]);
      expect(isTrustedFolder('/work/vault')).toBe(false);
    }
  });

  it('treats storage that throws as no trusted folders, and reports the failed save', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readTrustedFolders()).toEqual([]);
    vi.restoreAllMocks();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    expect(trustFolder('/work/vault')).toBe(false);
  });
});
