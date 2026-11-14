// @vitest-environment jsdom
import { invoke } from '@tauri-apps/api/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EditorContent } from '../../workspace/model';
import type { PaneActions } from '../pane-props';

import type { CodeEditorProps } from './code-editor';
import { EditorPane } from './editor-pane';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

// CodeMirror needs layout that jsdom does not have. A text area stands in:
// like the real editor it starts from `initialText`, is rebuilt when `docKey`
// changes, and reports every edit.
vi.mock('./code-editor', () => ({
  CodeEditor: ({ docKey, initialText, path, focused, onChange }: CodeEditorProps) => (
    <textarea
      key={docKey}
      aria-label="Editor"
      data-path={path ?? ''}
      data-focused={String(focused)}
      defaultValue={initialText}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    />
  ),
}));

const MISSING = 'No such file or directory (os error 2)';

const invokeMock = vi.mocked(invoke);

/** What the fake core holds: files by path, and the reads and writes set to fail. */
interface Disk {
  files: Map<string, string>;
  readErrors: Map<string, string>;
  writeError: string | null;
}

let disk: Disk;

function callsTo(command: string) {
  return invokeMock.mock.calls.filter(([name]) => name === command);
}

function stringArg(args: unknown, key: string): string {
  if (typeof args === 'object' && args !== null && key in args) {
    const value: unknown = Reflect.get(args, key);
    if (typeof value === 'string') {
      return value;
    }
  }
  throw new Error(`missing argument ${key}`);
}

function makeActions(): PaneActions {
  return {
    openPane: vi.fn(),
    replaceContent: vi.fn(),
    setTitle: vi.fn(),
    setBadge: vi.fn(),
    close: vi.fn(),
  };
}

interface Shown {
  actions: PaneActions;
  rerender: (content: EditorContent) => void;
}

function show(path: string | null, debug = false): Shown {
  const actions = makeActions();
  function element(content: EditorContent) {
    return (
      <EditorPane
        paneId="p1"
        name="editor"
        content={content}
        active={true}
        debug={debug}
        actions={actions}
      />
    );
  }
  const view = render(element({ type: 'editor', path }));
  return {
    actions,
    rerender: (content) => {
      view.rerender(element(content));
    },
  };
}

function editor() {
  return screen.findByLabelText<HTMLTextAreaElement>('Editor');
}

async function type(text: string) {
  fireEvent.change(await editor(), { target: { value: text } });
}

beforeEach(() => {
  disk = { files: new Map(), readErrors: new Map(), writeError: null };
  invokeMock.mockReset();
  invokeMock.mockImplementation((command, args) => {
    if (command === 'fs_home') {
      return Promise.resolve('/Users/sam');
    }
    if (command === 'fs_read_text') {
      const path = stringArg(args, 'path');
      const failure = disk.readErrors.get(path);
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      const text = disk.files.get(path);
      if (text === undefined) {
        return Promise.reject(`${path}: ${MISSING}`);
      }
      return Promise.resolve({ path, text });
    }
    if (command === 'fs_write_text') {
      if (disk.writeError !== null) {
        return Promise.reject(disk.writeError);
      }
      disk.files.set(stringArg(args, 'path'), stringArg(args, 'text'));
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('loading', () => {
  it('shows the text of the file and its path', async () => {
    disk.files.set('/notes/a.txt', 'hello there');
    show('/notes/a.txt');

    expect((await editor()).value).toBe('hello there');
    expect(screen.getByText('/notes/a.txt')).toBeTruthy();
    expect(screen.queryByLabelText('Unsaved changes')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
  });

  it('expands a home path before reading', async () => {
    disk.files.set('/Users/sam/notes/a.txt', 'from home');
    show('~/notes/a.txt');

    expect((await editor()).value).toBe('from home');
    expect(screen.getByText('~/notes/a.txt')).toBeTruthy();
  });

  it('shows the error from the core and a retry button, with no editor', async () => {
    disk.readErrors.set('/notes', '/notes is a directory');
    show('/notes');

    expect((await screen.findByRole('alert')).textContent).toContain('/notes is a directory');
    expect(screen.queryByLabelText('Editor')).toBeNull();

    disk.readErrors.clear();
    disk.files.set('/notes', 'now a file');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect((await editor()).value).toBe('now a file');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('treats a path with no file as a new file that saving creates', async () => {
    const { actions } = show('/notes/new.md');

    expect((await editor()).value).toBe('');
    expect(screen.getByText(/New file/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(disk.files.get('/notes/new.md')).toBe('');
    });
    await waitFor(() => {
      expect(screen.queryByText(/New file/)).toBeNull();
    });
    expect(actions.replaceContent).not.toHaveBeenCalled();
  });

  it('loads again when the pane is given another file', async () => {
    disk.files.set('/notes/a.txt', 'first');
    disk.files.set('/notes/b.txt', 'second');
    const { rerender } = show('/notes/a.txt');
    expect((await editor()).value).toBe('first');

    rerender({ type: 'editor', path: '/notes/b.txt' });

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLTextAreaElement>('Editor').value).toBe('second');
    });
  });
});

describe('saving', () => {
  it('marks the buffer dirty, writes it, then clears the mark', async () => {
    disk.files.set('/notes/a.txt', 'hello');
    const { actions } = show('/notes/a.txt');

    await type('hello world');

    expect(screen.getByLabelText('Unsaved changes')).toBeTruthy();
    expect(actions.setTitle).toHaveBeenLastCalledWith('a.txt •');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.queryByLabelText('Unsaved changes')).toBeNull();
    });
    expect(invokeMock).toHaveBeenCalledWith('fs_write_text', {
      path: '/notes/a.txt',
      text: 'hello world',
    });
    expect(actions.setTitle).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
  });

  it('is clean again when an edit is undone back to the saved text', async () => {
    disk.files.set('/notes/a.txt', 'hello');
    show('/notes/a.txt');

    await type('hello!');
    expect(screen.getByLabelText('Unsaved changes')).toBeTruthy();
    await type('hello');
    expect(screen.queryByLabelText('Unsaved changes')).toBeNull();
  });

  it('saves on Cmd+S', async () => {
    disk.files.set('/notes/a.txt', 'hello');
    show('/notes/a.txt');
    await type('changed');

    const notPrevented = fireEvent.keyDown(await editor(), { key: 's', metaKey: true });

    expect(notPrevented).toBe(false);
    await waitFor(() => {
      expect(disk.files.get('/notes/a.txt')).toBe('changed');
    });
  });

  it('shows a save error inline and stays dirty', async () => {
    disk.files.set('/notes/a.txt', 'hello');
    disk.writeError = '/notes/a.txt: Permission denied (os error 13)';
    show('/notes/a.txt');
    await type('changed');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Permission denied');
    expect(screen.getByLabelText('Unsaved changes')).toBeTruthy();
    expect((await editor()).value).toBe('changed');
    expect(disk.files.get('/notes/a.txt')).toBe('hello');
  });

  it('does not touch a title it never set', async () => {
    disk.files.set('/notes/a.txt', 'hello');
    const { actions } = show('/notes/a.txt');
    await editor();

    expect(actions.setTitle).not.toHaveBeenCalled();
  });
});

describe('a new buffer', () => {
  it('saves to the typed path and records it with the workspace', async () => {
    const { actions, rerender } = show(null);
    await type('# Fresh');
    expect(actions.setTitle).toHaveBeenLastCalledWith('untitled •');

    fireEvent.change(screen.getByLabelText('Save as path'), { target: { value: '~/new.md' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as' }));

    await waitFor(() => {
      expect(actions.replaceContent).toHaveBeenCalledExactlyOnceWith({
        type: 'editor',
        path: '~/new.md',
      });
    });
    expect(invokeMock).toHaveBeenCalledWith('fs_write_text', { path: '~/new.md', text: '# Fresh' });
    expect(screen.queryByLabelText('Save as path')).toBeNull();
    expect(screen.queryByLabelText('Unsaved changes')).toBeNull();
    expect(screen.getByText('~/new.md')).toBeTruthy();

    // The workspace hands the new path back. Edits made since must survive it.
    await type('# Fresh\nmore');
    const reads = callsTo('fs_read_text').length;
    rerender({ type: 'editor', path: '~/new.md' });

    expect((await editor()).value).toBe('# Fresh\nmore');
    expect(callsTo('fs_read_text')).toHaveLength(reads);
    expect(screen.getByLabelText('Unsaved changes')).toBeTruthy();
  });

  it('refuses a relative path', async () => {
    const { actions } = show(null);
    await type('text');

    fireEvent.change(screen.getByLabelText('Save as path'), { target: { value: 'new.md' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as' }));

    expect((await screen.findByRole('alert')).textContent).toContain('absolute path');
    expect(callsTo('fs_write_text')).toHaveLength(0);
    expect(actions.replaceContent).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a file that already exists', async () => {
    disk.files.set('/notes/taken.md', 'precious');
    const { actions } = show(null);
    await type('text');

    fireEvent.change(screen.getByLabelText('Save as path'), {
      target: { value: '/notes/taken.md' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save as' }));

    expect((await screen.findByRole('alert')).textContent).toContain('already exists');
    expect(disk.files.get('/notes/taken.md')).toBe('precious');
    expect(actions.replaceContent).not.toHaveBeenCalled();
  });

  it('cannot reload, having nothing on disk', async () => {
    show(null);
    await editor();

    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Reload from disk' }).disabled,
    ).toBe(true);
  });
});

describe('reload from disk', () => {
  it('reloads at once when the buffer is clean', async () => {
    disk.files.set('/notes/a.txt', 'one');
    show('/notes/a.txt');
    await editor();

    disk.files.set('/notes/a.txt', 'two');
    fireEvent.click(screen.getByRole('button', { name: 'Reload from disk' }));

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLTextAreaElement>('Editor').value).toBe('two');
    });
  });

  it('asks first when the buffer is dirty, and keeps the edits on cancel', async () => {
    disk.files.set('/notes/a.txt', 'one');
    show('/notes/a.txt');
    await type('mine');
    disk.files.set('/notes/a.txt', 'two');

    fireEvent.click(screen.getByRole('button', { name: 'Reload from disk' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect((await editor()).value).toBe('mine');
    expect(callsTo('fs_read_text')).toHaveLength(1);
  });

  it('discards the edits when confirmed', async () => {
    disk.files.set('/notes/a.txt', 'one');
    show('/notes/a.txt');
    await type('mine');
    disk.files.set('/notes/a.txt', 'two');

    fireEvent.click(screen.getByRole('button', { name: 'Reload from disk' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));

    await waitFor(() => {
      expect(screen.getByLabelText<HTMLTextAreaElement>('Editor').value).toBe('two');
    });
    expect(screen.queryByLabelText('Unsaved changes')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('Markdown', () => {
  const NOTE = [
    '# Title',
    '',
    '| A | B |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    'See [[Other note]].',
  ].join('\n');

  it('opens split, with a preview that renders a table and a wikilink', async () => {
    disk.files.set('/notes/a.md', NOTE);
    show('/notes/a.md');
    await editor();

    expect(screen.getByRole('button', { name: 'Split' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Other note' })).toBeTruthy();
  });

  it('has no view switch or preview for a code file', async () => {
    disk.files.set('/src/a.ts', '# not a heading');
    show('/src/a.ts');
    await editor();

    expect(screen.queryByRole('group', { name: 'View' })).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('switches between edit, split and preview without losing the buffer', async () => {
    disk.files.set('/notes/a.md', '# Title');
    show('/notes/a.md');
    await type('# Changed');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.queryByRole('heading')).toBeNull();
    expect((await editor()).closest('.editor-code')?.hasAttribute('hidden')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('heading', { name: 'Changed' })).toBeTruthy();
    const hidden = screen.getByLabelText<HTMLTextAreaElement>('Editor');
    expect(hidden.closest('.editor-code')?.hasAttribute('hidden')).toBe(true);
    expect(hidden.value).toBe('# Changed');
    expect(hidden.dataset.focused).toBe('false');
  });

  it('updates the preview after a short pause in typing', async () => {
    disk.files.set('/notes/a.md', '# Before');
    show('/notes/a.md');
    await editor();

    await type('# After');

    expect(screen.getByRole('heading', { name: 'Before' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'After' })).toBeTruthy();
  });

  it('opens an http link in a web pane beside this one, without navigating', async () => {
    disk.files.set('/notes/a.md', '[site](https://example.com)');
    const { actions } = show('/notes/a.md');
    await editor();

    const notPrevented = fireEvent.click(screen.getByRole('link', { name: 'site' }));

    expect(notPrevented).toBe(false);
    expect(actions.openPane).toHaveBeenCalledExactlyOnceWith({
      type: 'web',
      url: 'https://example.com',
    });
  });

  it('opens a wikilink as a file next to this one, resolved from a home path', async () => {
    disk.files.set('/Users/sam/notes/a.md', NOTE);
    const { actions } = show('~/notes/a.md');
    await editor();

    fireEvent.click(screen.getByRole('link', { name: 'Other note' }));

    expect(actions.openPane).toHaveBeenCalledExactlyOnceWith({
      type: 'editor',
      path: '/Users/sam/notes/Other note.md',
    });
  });
});

describe('focus and debug', () => {
  it('asks the editor to take focus while the pane is active', async () => {
    disk.files.set('/notes/a.txt', 'hello');
    show('/notes/a.txt');

    expect((await editor()).dataset.focused).toBe('true');
  });

  it('writes a snapshot of path, dirty state, view and buffer', async () => {
    disk.files.set('/notes/a.md', '# Title');
    show('/notes/a.md', true);
    await type('# Edited');

    await waitFor(
      () => {
        expect(invokeMock).toHaveBeenCalledWith('debug_snapshot', {
          id: 'editor',
          text: 'path=/notes/a.md dirty=true view=split\n# Edited',
        });
      },
      { timeout: 2500 },
    );
  });
});
