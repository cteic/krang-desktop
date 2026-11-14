import { describe, expect, it } from 'vitest';

import { editorLayout, effectiveView, extensionOf, isMarkdownPath } from './file-kind';

describe('extensionOf', () => {
  it('returns the lower-case extension of the file name', () => {
    expect(extensionOf('/a/b/notes.MD')).toBe('md');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
  });

  it('is empty when there is none', () => {
    expect(extensionOf('/a/Makefile')).toBe('');
    expect(extensionOf('/a/.gitignore')).toBe('');
    expect(extensionOf('/a.dir/file')).toBe('');
  });
});

describe('isMarkdownPath', () => {
  it('accepts the three Markdown extensions in any case', () => {
    expect(isMarkdownPath('~/notes/a.md')).toBe(true);
    expect(isMarkdownPath('/a/README.Markdown')).toBe(true);
    expect(isMarkdownPath('/a/page.mdx')).toBe(true);
  });

  it('rejects code, text and a buffer with no path', () => {
    expect(isMarkdownPath('/a/main.rs')).toBe(false);
    expect(isMarkdownPath('/a/notes.txt')).toBe(false);
    expect(isMarkdownPath('/a/md')).toBe(false);
    expect(isMarkdownPath(null)).toBe(false);
  });
});

describe('effectiveView', () => {
  it('opens Markdown split until the person chooses', () => {
    expect(effectiveView(true, null)).toBe('split');
    expect(effectiveView(true, 'preview')).toBe('preview');
    expect(effectiveView(true, 'edit')).toBe('edit');
  });

  it('keeps code in edit whatever was chosen before', () => {
    expect(effectiveView(false, null)).toBe('edit');
    expect(effectiveView(false, 'preview')).toBe('edit');
  });
});

describe('editorLayout', () => {
  it('wraps Markdown and leaves out line numbers', () => {
    expect(editorLayout('/a/notes.md')).toEqual({ lineWrapping: true, lineNumbers: false });
  });

  it('numbers code lines and does not wrap them', () => {
    expect(editorLayout('/a/main.ts')).toEqual({ lineWrapping: false, lineNumbers: true });
    expect(editorLayout(null)).toEqual({ lineWrapping: false, lineNumbers: true });
  });
});
