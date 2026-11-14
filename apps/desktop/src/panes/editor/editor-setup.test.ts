// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEditor, type EditorHandle } from './editor-setup';

// jsdom has no layout, so these tests only cover what the editor's DOM and
// configuration show: that it builds, and which layout a file name gets.

let handle: EditorHandle | null = null;

function open(text: string, path: string | null) {
  const parent = document.createElement('div');
  document.body.append(parent);
  const onChange = vi.fn();
  handle = createEditor({ parent, text, path, onChange });
  return { parent, onChange };
}

afterEach(() => {
  handle?.destroy();
  handle = null;
  document.body.replaceChildren();
});

describe('createEditor', () => {
  it('builds an editor holding the text', () => {
    const { parent, onChange } = open('first line\nsecond line', '/a/notes.txt');

    const lines = Array.from(parent.querySelectorAll('.cm-line')).map((line) => line.textContent);
    expect(lines).toEqual(['first line', 'second line']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('wraps lines for Markdown and not for code', () => {
    const prose = open('# Title', '/a/notes.md');
    expect(prose.parent.querySelector('.cm-lineWrapping')).not.toBeNull();
    handle?.destroy();

    const code = open('let a = 1;', '/a/main.rs');
    expect(code.parent.querySelector('.cm-lineWrapping')).toBeNull();
    expect(code.parent.querySelector('.cm-lineNumbers')).not.toBeNull();
  });

  it('applies the layout of a new file name without rebuilding', () => {
    const { parent } = open('# Title', null);
    const element = parent.querySelector('.cm-editor');
    expect(parent.querySelector('.cm-lineWrapping')).toBeNull();

    handle?.setPath('/a/notes.md');

    expect(parent.querySelector('.cm-lineWrapping')).not.toBeNull();
    expect(parent.querySelector('.cm-editor')).toBe(element);
    expect(parent.querySelector('.cm-line')?.textContent).toBe('# Title');
  });

  it('reads the selection and tells when it starts and stops holding text', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const onSelection = vi.fn();
    handle = createEditor({
      parent,
      text: 'one two three',
      path: null,
      onChange: vi.fn(),
      onSelection,
    });
    expect(handle.selection()).toEqual({ from: 0, to: 0, text: '' });

    const content = parent.querySelector<HTMLElement>('.cm-content');
    const line = parent.querySelector('.cm-line')?.firstChild ?? null;
    if (content === null || line === null) {
      throw new Error('editor did not build');
    }
    content.focus();
    document.getSelection()?.setBaseAndExtent(line, 4, line, 7);
    document.dispatchEvent(new Event('selectionchange'));

    expect(handle.selection()).toEqual({ from: 4, to: 7, text: 'two' });
    expect(onSelection).toHaveBeenLastCalledWith(true);
  });

  it('replaces a range only while it still holds the text that was read', () => {
    const { parent, onChange } = open('one two three', '/a/notes.md');

    expect(handle?.replaceRange({ from: 4, to: 7, text: 'two' }, '[[Two]]')).toBe(true);
    expect(parent.querySelector('.cm-line')?.textContent).toBe('one [[Two]] three');
    expect(onChange).toHaveBeenLastCalledWith('one [[Two]] three');
    expect(handle?.selection()).toEqual({ from: 11, to: 11, text: '' });

    expect(handle?.replaceRange({ from: 4, to: 7, text: 'two' }, 'again')).toBe(false);
    expect(handle?.replaceRange({ from: 4, to: 99, text: 'two' }, 'again')).toBe(false);
    expect(parent.querySelector('.cm-line')?.textContent).toBe('one [[Two]] three');
  });

  it('removes itself and ignores later calls once destroyed', () => {
    const { parent } = open('text', '/a/notes.md');

    handle?.destroy();
    handle?.setPath('/a/main.rs');
    handle?.focus();

    expect(parent.querySelector('.cm-editor')).toBeNull();
  });
});
