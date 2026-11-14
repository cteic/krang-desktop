import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  errorText,
  homeDirectory,
  isMissingFileError,
  loadFile,
  readTextFile,
  resolvePath,
  writeTextFile,
} from './fs-api';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

describe('readTextFile', () => {
  it('returns a validated reply', async () => {
    invokeMock.mockResolvedValue({ path: '/a.md', text: 'hi' });
    await expect(readTextFile('/a.md')).resolves.toEqual({ path: '/a.md', text: 'hi' });
    expect(invokeMock).toHaveBeenCalledWith('fs_read_text', { path: '/a.md' });
  });

  it('rejects a reply of the wrong shape', async () => {
    invokeMock.mockResolvedValue({ path: '/a.md', text: 5 });
    await expect(readTextFile('/a.md')).rejects.toThrow();
  });
});

describe('writeTextFile', () => {
  it('passes the path and text to the core', async () => {
    invokeMock.mockResolvedValue(null);
    await writeTextFile('/a.md', 'hi');
    expect(invokeMock).toHaveBeenCalledWith('fs_write_text', { path: '/a.md', text: 'hi' });
  });
});

describe('homeDirectory and resolvePath', () => {
  it('rejects a home reply that is not a string', async () => {
    invokeMock.mockResolvedValue(null);
    await expect(homeDirectory()).rejects.toThrow();
  });

  it('expands a home path', async () => {
    invokeMock.mockResolvedValue('/Users/sam');
    await expect(resolvePath('~/notes/a.md')).resolves.toBe('/Users/sam/notes/a.md');
  });

  it('does not ask for the home directory when it is not needed', async () => {
    await expect(resolvePath('/tmp/a.md')).resolves.toBe('/tmp/a.md');
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe('errorText', () => {
  it('shows strings, errors and anything else', () => {
    expect(errorText('/a is a directory')).toBe('/a is a directory');
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText(42)).toBe('42');
  });
});

describe('isMissingFileError', () => {
  it('matches the system message for a missing file', () => {
    expect(isMissingFileError('/a/b.md: No such file or directory (os error 2)')).toBe(true);
  });

  it('does not match the other load errors', () => {
    expect(isMissingFileError('/a is a directory')).toBe(false);
    expect(isMissingFileError('/a.bin is not UTF-8 text')).toBe(false);
    expect(isMissingFileError('/a: Permission denied (os error 13)')).toBe(false);
    expect(
      isMissingFileError('/a is 6000000 bytes, over the 5242880 byte limit for the editor'),
    ).toBe(false);
  });
});

describe('loadFile', () => {
  it('reads through the expanded path', async () => {
    invokeMock.mockImplementation((command) => {
      if (command === 'fs_home') {
        return Promise.resolve('/Users/sam');
      }
      return Promise.resolve({ path: '/Users/sam/a.md', text: 'hi' });
    });
    await expect(loadFile('~/a.md')).resolves.toEqual({
      kind: 'loaded',
      resolvedPath: '/Users/sam/a.md',
      text: 'hi',
    });
    expect(invokeMock).toHaveBeenCalledWith('fs_read_text', { path: '/Users/sam/a.md' });
  });

  it('reports a missing file as one that can be created', async () => {
    invokeMock.mockRejectedValue('/a/new.md: No such file or directory (os error 2)');
    await expect(loadFile('/a/new.md')).resolves.toEqual({
      kind: 'missing',
      resolvedPath: '/a/new.md',
    });
  });

  it('reports any other failure with the text from the core', async () => {
    invokeMock.mockRejectedValue('/a is a directory');
    await expect(loadFile('/a')).resolves.toEqual({ kind: 'failed', message: '/a is a directory' });
  });
});
