import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errorText, fetchListing, parseHome, parseListing } from './listing';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const reply = {
  path: '/work',
  parent: '/',
  entries: [
    { name: 'src', path: '/work/src', isDir: true, size: 96, modifiedMs: 1700000000000 },
    { name: 'a.txt', path: '/work/a.txt', isDir: false, size: 3, modifiedMs: 0 },
  ],
};

describe('parseListing', () => {
  it('accepts a well-formed reply', () => {
    expect(parseListing(reply)).toEqual(reply);
  });

  it('accepts the root, which has no parent', () => {
    expect(parseListing({ path: '/', parent: null, entries: [] })).toEqual({
      path: '/',
      parent: null,
      entries: [],
    });
  });

  it('rejects a reply with a field missing', () => {
    expect(() => parseListing({ path: '/work', entries: [] })).toThrow(/does not understand/);
  });

  it('rejects an entry of the wrong shape', () => {
    const bad = { ...reply, entries: [{ name: 'x', path: '/work/x', isDir: 'no', size: 1 }] };

    expect(() => parseListing(bad)).toThrow(/does not understand/);
  });

  it('rejects a negative size', () => {
    const bad = {
      ...reply,
      entries: [{ name: 'x', path: '/work/x', isDir: false, size: -1, modifiedMs: 0 }],
    };

    expect(() => parseListing(bad)).toThrow(/does not understand/);
  });

  it('rejects something that is not an object', () => {
    expect(() => parseListing(null)).toThrow(/does not understand/);
    expect(() => parseListing('/work')).toThrow(/does not understand/);
  });
});

describe('parseHome', () => {
  it('accepts a path', () => {
    expect(parseHome('/Users/pete')).toBe('/Users/pete');
  });

  it('rejects anything else', () => {
    expect(() => parseHome('')).toThrow(/does not understand/);
    expect(() => parseHome(42)).toThrow(/does not understand/);
  });
});

describe('fetchListing', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it('lists the directory it is given', async () => {
    vi.mocked(invoke).mockResolvedValue(reply);

    await expect(fetchListing('~/work')).resolves.toEqual(reply);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('fs_list', { path: '~/work' });
  });

  it('asks for the home directory when given none', async () => {
    vi.mocked(invoke).mockImplementation((command) =>
      Promise.resolve(command === 'fs_home' ? '/Users/pete' : reply),
    );

    await fetchListing(null);

    expect(invoke).toHaveBeenNthCalledWith(1, 'fs_home');
    expect(invoke).toHaveBeenNthCalledWith(2, 'fs_list', { path: '/Users/pete' });
  });

  it('passes on the error text from the Rust side', async () => {
    vi.mocked(invoke).mockRejectedValue('/nope: No such file or directory (os error 2)');

    await expect(fetchListing('/nope')).rejects.toBe(
      '/nope: No such file or directory (os error 2)',
    );
  });

  it('rejects a reply of the wrong shape', async () => {
    vi.mocked(invoke).mockResolvedValue({ entries: 'none' });

    await expect(fetchListing('/work')).rejects.toThrow(/does not understand/);
  });
});

describe('errorText', () => {
  it('returns a string as it is', () => {
    expect(errorText('/x: Permission denied')).toBe('/x: Permission denied');
  });

  it('returns the message of an error', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
  });

  it('turns anything else into text', () => {
    expect(errorText(42)).toBe('42');
    expect(errorText(null)).toBe('null');
  });
});
