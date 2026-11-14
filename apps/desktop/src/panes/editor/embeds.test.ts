import { describe, expect, it, vi } from 'vitest';

import { createEmbedResolver, isImageName } from './embeds';
import type { Directory } from './fs-api';

/** A fake disk: each directory path lists its files and folders by name. */
function lister(tree: Record<string, string[]>) {
  return vi.fn((path: string): Promise<Directory> => {
    const names = tree[path];
    if (names === undefined) {
      return Promise.reject(new Error(`${path}: No such file or directory (os error 2)`));
    }
    return Promise.resolve({
      path,
      entries: names.map((name) => ({
        name,
        path: `${path}/${name}`,
        isDir: tree[`${path}/${name}`] !== undefined,
      })),
    });
  });
}

describe('isImageName', () => {
  it('accepts image files only', () => {
    expect(isImageName('plot.PNG')).toBe(true);
    expect(isImageName('figs/plot.svg')).toBe(true);
    expect(isImageName('page.html')).toBe(false);
    expect(isImageName('Note')).toBe(false);
  });
});

describe('createEmbedResolver', () => {
  const vault = {
    '/vault': ['.obsidian', 'attachments', 'notes', 'top.png'],
    '/vault/.obsidian': ['hidden.png'],
    '/vault/attachments': ['my plot.png', 'deep'],
    '/vault/attachments/deep': ['top.png', 'far.jpg'],
    '/vault/notes': ['a.md'],
  };

  it('finds an image anywhere in the vault by its file name', async () => {
    const resolve = createEmbedResolver('/vault', '/vault/notes', lister(vault));
    expect(await resolve('my plot.png')).toBe(
      'localfile://localhost/vault/attachments/my%20plot.png',
    );
    expect(await resolve('some/folder/FAR.jpg')).toBe(
      'localfile://localhost/vault/attachments/deep/far.jpg',
    );
  });

  it('prefers the nearest of two files with one name', async () => {
    const resolve = createEmbedResolver('/vault', '/vault/notes', lister(vault));
    expect(await resolve('top.png')).toBe('localfile://localhost/vault/top.png');
  });

  it('does not look in hidden folders', async () => {
    const list = lister(vault);
    const resolve = createEmbedResolver('/vault', '/vault/notes', list);
    expect(await resolve('hidden.png')).toBeNull();
    expect(list.mock.calls.map(([path]) => path)).not.toContain('/vault/.obsidian');
  });

  it('never resolves a file that is not an image, and does not search for one', async () => {
    const list = lister({ '/vault': ['page.html', 'a.md'] });
    const resolve = createEmbedResolver('/vault', '/vault', list);
    expect(await resolve('page.html')).toBeNull();
    expect(await resolve('a')).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it('searches once however many embeds ask', async () => {
    const list = lister(vault);
    const resolve = createEmbedResolver('/vault', '/vault/notes', list);
    await Promise.all([resolve('top.png'), resolve('far.jpg'), resolve('gone.png')]);
    expect(list).toHaveBeenCalledTimes(4);
  });

  it('looks only in the note folder when the note is not in a vault', async () => {
    const list = lister({ '/docs': ['here.png', 'sub'], '/docs/sub': ['below.png'] });
    const resolve = createEmbedResolver(null, '/docs', list);
    expect(await resolve('here.png')).toBe('localfile://localhost/docs/here.png');
    expect(await resolve('below.png')).toBeNull();
  });

  it('finds nothing for a buffer with no file, or a folder that cannot be read', async () => {
    expect(await createEmbedResolver(null, null, lister({}))('a.png')).toBeNull();
    expect(await createEmbedResolver('/gone', '/gone', lister({}))('a.png')).toBeNull();
  });
});
