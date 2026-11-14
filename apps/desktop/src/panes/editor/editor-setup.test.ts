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

  it('removes itself and ignores later calls once destroyed', () => {
    const { parent } = open('text', '/a/notes.md');

    handle?.destroy();
    handle?.setPath('/a/main.rs');
    handle?.focus();

    expect(parent.querySelector('.cm-editor')).toBeNull();
  });
});
