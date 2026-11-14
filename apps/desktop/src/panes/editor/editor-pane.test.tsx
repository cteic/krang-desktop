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
// Its selection is the text area's own, read and replaced the way the real
// editor does it.
vi.mock('./code-editor', () => ({
  CodeEditor: ({
    docKey,
    initialText,
    path,
    focused,
    onChange,
    onSelection,
    apiRef,
  }: CodeEditorProps) => (
    <textarea
      key={docKey}
      ref={(area) => {
        if (apiRef === undefined) {
          return;
        }
        apiRef.current =
          area === null
            ? null
            : {
                selection: () => ({
                  from: area.selectionStart,
                  to: area.selectionEnd,
                  text: area.value.slice(area.selectionStart, area.selectionEnd),
                }),
                replaceRange: (range, insert) => {
                  if (area.value.slice(range.from, range.to) !== range.text) {
                    return false;
                  }
                  area.value =
                    area.value.slice(0, range.from) + insert + area.value.slice(range.to);
                  onChange(area.value);
                  return true;
                },
                focus: () => {
                  area.focus();
                },
              };
      }}
      aria-label="Editor"
      data-path={path ?? ''}
      data-focused={String(focused)}
      defaultValue={initialText}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      onSelect={(event) => {
        const area = event.currentTarget;
        onSelection?.(area.selectionStart !== area.selectionEnd);
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
  /** Folders that are vaults: a file under one belongs to it. */
  vaults: string[];
  /** What `graph_read` reports as the vault's node types. */
  nodeTypes: unknown[];
  createError: string | null;
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

function show(path: string | null, debug = false, mode?: EditorContent['mode']): Shown {
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
  const view = render(element({ type: 'editor', path, mode }));
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
  disk = {
    files: new Map(),
    readErrors: new Map(),
    writeError: null,
    vaults: [],
    nodeTypes: [],
    createError: null,
  };
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
    if (command === 'graph_vault_root') {
      const path = stringArg(args, 'path');
      return Promise.resolve(disk.vaults.find((vault) => path.startsWith(`${vault}/`)) ?? null);
    }
    if (command === 'graph_read') {
      return Promise.resolve({ nodeTypes: disk.nodeTypes, nodes: [], relations: [] });
    }
    if (command === 'graph_create_node') {
      if (disk.createError !== null) {
        return Promise.reject(disk.createError);
      }
      const title = `CLM - ${stringArg(args, 'text')}`;
      return Promise.resolve({
        id: 'new-1',
        title,
        path: `${stringArg(args, 'vault')}/Nodes/${title}.md`,
      });
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

describe('view mode', () => {
  it('opens in the mode the layout gave', async () => {
    disk.files.set('/notes/a.md', '# Title');
    show('/notes/a.md', false, 'preview');

    expect(await screen.findByRole('heading', { name: 'Title' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Preview' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('records a change of mode with the workspace', async () => {
    disk.files.set('/notes/a.md', '# Title');
    const { actions } = show('/notes/a.md', false, 'preview');
    await editor();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(actions.replaceContent).toHaveBeenCalledExactlyOnceWith({
      type: 'editor',
      path: '/notes/a.md',
      mode: 'edit',
    });
    expect(screen.getByRole('button', { name: 'Edit' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows frontmatter as properties in the preview and as text in the source', async () => {
    disk.files.set('/notes/a.md', '---\nkind: claim\n---\n# Title');
    show('/notes/a.md');

    expect((await editor()).value).toContain('kind: claim');
    expect(await screen.findByText('Properties')).toBeTruthy();
    expect(screen.getByText('kind').tagName).toBe('DT');
  });
});

describe('making a node from the selection', () => {
  const NOTE = '/vault/Notes/reading.md';
  const TEXT = 'Intro. Citations reward\n  the already famous. Outro.';
  const FROM = TEXT.indexOf('Citations');
  const TO = TEXT.indexOf(' Outro');

  beforeEach(() => {
    disk.vaults = ['/vault'];
    disk.nodeTypes = [
      { id: 'n-que', name: 'Question', format: 'QUE - {content}', color: '#99890E' },
      {
        id: 'n-clm',
        name: 'Claim',
        format: 'CLM - {content}',
        color: '#7DA13E',
        tag: 'clm-candidate',
      },
      { id: 'n-evd', name: 'Evidence', format: 'EVD - {content}', color: null, tag: null },
    ];
    disk.files.set(NOTE, TEXT);
  });

  async function select(from = FROM, to = TO) {
    const area = await editor();
    await screen.findByRole('button', { name: 'Node' });
    area.setSelectionRange(from, to);
    fireEvent.select(area);
    return area;
  }

  async function openPopover() {
    const area = await select();
    fireEvent.click(screen.getByRole('button', { name: 'Node' }));
    await screen.findByRole('option', { name: /Question/ });
    return area;
  }

  function typeBox() {
    return screen.getByRole('combobox', { name: 'Node type' });
  }

  function chosen() {
    return screen
      .getAllByRole('option')
      .filter((option) => option.getAttribute('aria-selected') === 'true')
      .map((option) => option.textContent);
  }

  it('has no Node button for a file outside a vault', async () => {
    disk.files.set('/notes/a.md', 'plain note');
    show('/notes/a.md');
    await editor();

    await waitFor(() => {
      expect(callsTo('graph_vault_root')).toHaveLength(1);
    });
    expect(screen.queryByRole('button', { name: 'Node' })).toBeNull();
  });

  it('enables the Node button only while text is selected', async () => {
    show(NOTE);
    const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'Node' });
    expect(button.disabled).toBe(true);

    const area = await select();
    expect(button.disabled).toBe(false);

    area.setSelectionRange(3, 3);
    fireEvent.select(area);
    expect(button.disabled).toBe(true);
  });

  it('lists the node types of the vault with their colours', async () => {
    show(NOTE);
    await openPopover();

    expect(callsTo('graph_read')[0]?.[1]).toEqual({ path: '/vault' });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'QuestionQUE - {content}',
      'ClaimCLM - {content}',
      'EvidenceEVD - {content}',
    ]);
    expect(document.activeElement).toBe(typeBox());
    const dot = screen
      .getByRole('option', { name: /Claim/ })
      .querySelector<HTMLElement>('.editor-capture-dot');
    expect(dot?.style.background).toBe('rgb(125, 161, 62)');
  });

  it('never puts a colour that is not a hex value into a style', async () => {
    const hostile = [
      'url(https://example.invalid/x)',
      'red; background-image: url(https://example.invalid/x)',
      'image-set("https://example.invalid/x" 1x)',
      'var(--bg)',
      '#12345',
    ];
    disk.nodeTypes = hostile.map((color, index) => ({
      id: `n-${String(index)}`,
      name: `Type ${String(index)}`,
      format: 'T - {content}',
      color,
    }));
    show(NOTE);
    const area = await select();
    fireEvent.click(screen.getByRole('button', { name: 'Node' }));
    await screen.findByRole('option', { name: /Type 0/ });
    expect(area).toBeTruthy();

    const dots = Array.from(document.querySelectorAll<HTMLElement>('.editor-capture-dot'));
    expect(dots).toHaveLength(hostile.length);
    for (const dot of dots) {
      // The neutral grey a type with no colour gets.
      expect(dot.style.background).toBe('rgb(110, 118, 129)');
      expect(dot.getAttribute('style')).not.toMatch(/url|image|var|invalid/);
    }
  });

  it('opens on Cmd+Shift+N', async () => {
    show(NOTE);
    const area = await select();

    fireEvent.keyDown(area, { key: 'N', metaKey: true, shiftKey: true });

    expect(await screen.findByRole('dialog', { name: 'Make a node' })).toBeTruthy();
  });

  it('chooses by typing and by arrow keys', async () => {
    show(NOTE);
    await openPopover();
    expect(chosen()).toEqual(['QuestionQUE - {content}']);

    fireEvent.keyDown(typeBox(), { key: 'ArrowDown' });
    expect(chosen()).toEqual(['ClaimCLM - {content}']);
    fireEvent.keyDown(typeBox(), { key: 'ArrowUp' });
    fireEvent.keyDown(typeBox(), { key: 'ArrowUp' });
    expect(chosen()).toEqual(['EvidenceEVD - {content}']);

    fireEvent.change(typeBox(), { target: { value: 'cl' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(chosen()).toEqual(['ClaimCLM - {content}']);
  });

  it('creates the node on Enter, links it, and offers to open it', async () => {
    const { actions } = show(NOTE);
    const area = await openPopover();
    fireEvent.change(typeBox(), { target: { value: 'claim' } });

    fireEvent.keyDown(typeBox(), { key: 'Enter' });

    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('Created CLM - Citations reward the already famous.');
    expect(callsTo('graph_create_node')[0]?.[1]).toEqual({
      vault: '/vault',
      typeId: 'n-clm',
      text: 'Citations reward the already famous.',
      body: '',
    });
    expect(area.value).toBe('Intro. [[CLM - Citations reward the already famous.]] Outro.');
    expect(screen.getByLabelText('Unsaved changes')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(disk.files.get(NOTE)).toBe(TEXT);

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(actions.openPane).toHaveBeenCalledExactlyOnceWith({
      type: 'editor',
      path: '/vault/Nodes/CLM - Citations reward the already famous..md',
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the error from the core and leaves the text unchanged', async () => {
    disk.createError = 'a note named "CLM - Citations" already exists';
    show(NOTE);
    const area = await openPopover();

    fireEvent.click(screen.getByRole('button', { name: 'Create node' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'a note named "CLM - Citations" already exists',
    );
    expect(area.value).toBe(TEXT);
    expect(screen.queryByLabelText('Unsaved changes')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Make a node' })).toBeTruthy();
  });

  it('closes on Escape without changing anything', async () => {
    show(NOTE);
    const area = await openPopover();

    fireEvent.keyDown(typeBox(), { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(area.value).toBe(TEXT);
    expect(callsTo('graph_create_node')).toHaveLength(0);
    expect(document.activeElement).toBe(area);
  });

  it('marks the selection as a candidate with the tag of the type, creating no file', async () => {
    show(NOTE);
    const area = await openPopover();
    fireEvent.keyDown(typeBox(), { key: 'ArrowDown' });

    fireEvent.click(screen.getByRole('button', { name: 'Mark as candidate' }));

    expect(area.value).toBe(
      'Intro. ==Citations reward the already famous.== #clm-candidate Outro.',
    );
    expect(callsTo('graph_create_node')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText('Unsaved changes')).toBeTruthy();
  });

  it('marks a candidate with no tag when the type has none', async () => {
    show(NOTE);
    const area = await openPopover();

    fireEvent.keyDown(typeBox(), { key: 'Enter', shiftKey: true });

    expect(area.value).toBe('Intro. ==Citations reward the already famous.== Outro.');
  });

  it('says so when the node types cannot be read', async () => {
    disk.nodeTypes = [{ id: 7 }];
    show(NOTE);
    await select();

    fireEvent.click(screen.getByRole('button', { name: 'Node' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create node' }).disabled).toBe(
      true,
    );
  });
});
