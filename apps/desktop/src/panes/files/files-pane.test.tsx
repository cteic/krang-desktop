// @vitest-environment jsdom
import { invoke } from '@tauri-apps/api/core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FilesContent } from '../../workspace/model';
import type { PaneActions } from '../pane-props';

import { FilesPane } from './files-pane';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

interface FakeEntry {
  name: string;
  isDir: boolean;
  size: number;
}

const MODIFIED_MS = new Date(2026, 0, 5, 9, 7).getTime();
const DENIED = '/home/pete/locked: Permission denied (os error 13)';

const TREE: Record<string, FakeEntry[]> = {
  '/': [{ name: 'home', isDir: true, size: 96 }],
  '/home': [{ name: 'pete', isDir: true, size: 96 }],
  '/home/pete': [
    { name: '.config', isDir: true, size: 96 },
    { name: 'empty', isDir: true, size: 64 },
    { name: 'locked', isDir: true, size: 64 },
    { name: 'src', isDir: true, size: 128 },
    { name: '.zshrc', isDir: false, size: 40 },
    { name: 'index.html', isDir: false, size: 2048 },
    { name: 'notes.md', isDir: false, size: 12 },
    { name: 'todo.txt', isDir: false, size: 300 },
  ],
  '/home/pete/empty': [],
  '/home/pete/locked': [{ name: 'secret.txt', isDir: false, size: 1 }],
  '/home/pete/src': [{ name: 'main.ts', isDir: false, size: 512 }],
};

let locked = true;

function join(directory: string, name: string): string {
  return directory === '/' ? `/${name}` : `${directory}/${name}`;
}

function parentOf(directory: string): string | null {
  if (directory === '/') {
    return null;
  }
  const index = directory.lastIndexOf('/');
  return index === 0 ? '/' : directory.slice(0, index);
}

function listingFor(directory: string) {
  const entries = TREE[directory];
  if (entries === undefined) {
    throw new Error(`${directory}: No such file or directory (os error 2)`);
  }
  return {
    path: directory,
    parent: parentOf(directory),
    entries: entries.map((entry) => ({
      ...entry,
      path: join(directory, entry.name),
      modifiedMs: MODIFIED_MS,
    })),
  };
}

function pathArgument(args: unknown): string {
  if (
    typeof args === 'object' &&
    args !== null &&
    'path' in args &&
    typeof args.path === 'string'
  ) {
    return args.path;
  }
  throw new Error('fs_list was called without a path');
}

function fakeInvoke(command: string, args?: unknown): Promise<unknown> {
  if (command === 'fs_home') {
    return Promise.resolve('/home/pete');
  }
  if (command === 'fs_list') {
    const path = pathArgument(args);
    if (path === '/home/pete/locked' && locked) {
      return Promise.reject(DENIED);
    }
    return Promise.resolve(listingFor(path));
  }
  return Promise.resolve(null);
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

interface Rendered {
  actions: PaneActions;
  rerenderWith: (directory: string | null) => void;
}

function renderPane(directory: string | null = null, debug = false): Rendered {
  const actions = makeActions();

  function pane(content: FilesContent) {
    return (
      <FilesPane
        paneId="pane-1"
        name="files"
        content={content}
        active
        debug={debug}
        actions={actions}
      />
    );
  }

  const view = render(pane({ type: 'files', directory }));
  return {
    actions,
    rerenderWith(next) {
      view.rerender(pane({ type: 'files', directory: next }));
    },
  };
}

function grid(): HTMLElement {
  return screen.getByRole('grid');
}

function rowNames(): string[] {
  return screen.getAllByRole('rowheader').map((cell) => cell.textContent);
}

function rowFor(name: string): HTMLElement {
  return screen.getByRole('row', { name: new RegExp(`^(Folder|File) ${name}\\b`) });
}

function selectedName(): string | null {
  const row = screen
    .getAllByRole('row')
    .find((item) => item.getAttribute('aria-selected') === 'true');
  return row === undefined ? null : within(row).getByRole('rowheader').textContent;
}

function listCalls(): unknown[] {
  return vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === 'fs_list')
    .map(([, args]) => args);
}

async function findListing(path: string): Promise<void> {
  await screen.findByRole('grid', { name: `Files in ${path}` });
  await waitFor(() => {
    expect(grid().getAttribute('aria-busy')).toBe('false');
  });
}

beforeEach(() => {
  locked = true;
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(fakeInvoke);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('FilesPane', () => {
  it('shows a loading state, then the home directory with dot files hidden', async () => {
    renderPane(null);

    expect(screen.getByText('Loading...', { selector: 'p' })).toBeDefined();

    await findListing('/home/pete');
    expect(rowNames()).toEqual(['empty', 'locked', 'src', 'index.html', 'notes.md', 'todo.txt']);
    expect(screen.queryByText('Loading...')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('6 of 8 items');
  });

  it('shows size and modified time for a file and no size for a directory', async () => {
    renderPane('/home/pete');
    await findListing('/home/pete');

    const file = within(rowFor('index.html'));
    expect(file.getByText('2.0K')).toBeDefined();
    expect(file.getByText('2026-01-05 09:07')).toBeDefined();
    expect(file.getByRole('img', { name: 'File' })).toBeDefined();

    const directory = within(rowFor('src'));
    expect(directory.getByRole('img', { name: 'Folder' })).toBeDefined();
    expect(directory.queryByText('128B')).toBeNull();
  });

  it('shows the path as breadcrumbs and opens the one clicked', async () => {
    const { actions } = renderPane('/home/pete/src');
    await findListing('/home/pete/src');

    const path = within(screen.getByRole('navigation', { name: 'Path' }));
    expect(path.getAllByRole('button').map((button) => button.textContent)).toEqual([
      '/',
      'home',
      'pete',
      'src',
    ]);
    expect(path.getByRole('button', { name: 'src' }).getAttribute('aria-current')).toBe('location');

    fireEvent.click(path.getByRole('button', { name: 'home' }));

    await findListing('/home');
    expect(rowNames()).toEqual(['pete']);
    expect(actions.replaceContent).toHaveBeenCalledWith({ type: 'files', directory: '/home' });
  });

  it('reveals dot files with the hidden files toggle', async () => {
    renderPane('/home/pete');
    await findListing('/home/pete');

    const toggle = screen.getByRole('button', { name: 'Show hidden files' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(rowNames()).toEqual([
      '.config',
      'empty',
      'locked',
      'src',
      '.zshrc',
      'index.html',
      'notes.md',
      'todo.txt',
    ]);
    expect(screen.getByRole('status').textContent).toBe('8 items');
  });

  it('moves the selection with the arrow keys and stops at the ends', async () => {
    renderPane('/home/pete');
    await findListing('/home/pete');

    expect(selectedName()).toBe('empty');
    fireEvent.keyDown(grid(), { key: 'ArrowUp' });
    expect(selectedName()).toBe('empty');
    fireEvent.keyDown(grid(), { key: 'ArrowDown' });
    fireEvent.keyDown(grid(), { key: 'ArrowDown' });
    expect(selectedName()).toBe('src');
    fireEvent.keyDown(grid(), { key: 'End' });
    fireEvent.keyDown(grid(), { key: 'ArrowDown' });
    expect(selectedName()).toBe('todo.txt');
    fireEvent.keyDown(grid(), { key: 'Home' });
    expect(selectedName()).toBe('empty');
  });

  it('points the grid at the selected row', async () => {
    renderPane('/home/pete');
    await findListing('/home/pete');

    fireEvent.keyDown(grid(), { key: 'ArrowDown' });

    expect(grid().getAttribute('aria-activedescendant')).toBe(rowFor('locked').id);
  });

  it('navigates into a directory with Enter and tells the workspace', async () => {
    const { actions } = renderPane('/home/pete');
    await findListing('/home/pete');

    fireEvent.click(rowFor('src'));
    fireEvent.keyDown(grid(), { key: 'Enter' });

    await findListing('/home/pete/src');
    expect(rowNames()).toEqual(['main.ts']);
    expect(actions.replaceContent).toHaveBeenCalledTimes(1);
    expect(actions.replaceContent).toHaveBeenCalledWith({
      type: 'files',
      directory: '/home/pete/src',
    });
    expect(actions.openPane).not.toHaveBeenCalled();
  });

  it('does not load again when the workspace hands the new directory back', async () => {
    const { rerenderWith } = renderPane('/home/pete');
    await findListing('/home/pete');

    fireEvent.doubleClick(rowFor('src'));
    await findListing('/home/pete/src');
    rerenderWith('/home/pete/src');
    rerenderWith('/home/pete/src');

    expect(listCalls()).toEqual([{ path: '/home/pete' }, { path: '/home/pete/src' }]);
  });

  it('loads a directory the workspace sets from outside', async () => {
    const { actions, rerenderWith } = renderPane('/home/pete');
    await findListing('/home/pete');

    rerenderWith('/home/pete/src');

    await findListing('/home/pete/src');
    expect(rowNames()).toEqual(['main.ts']);
    expect(actions.replaceContent).not.toHaveBeenCalled();
  });

  it('goes to the parent with Backspace and selects the directory it left', async () => {
    const { actions } = renderPane('/home/pete/src');
    await findListing('/home/pete/src');

    fireEvent.keyDown(grid(), { key: 'Backspace' });

    await findListing('/home/pete');
    expect(selectedName()).toBe('src');
    expect(actions.replaceContent).toHaveBeenCalledWith({ type: 'files', directory: '/home/pete' });
  });

  it('goes to the parent with Cmd+Up and with the up button', async () => {
    renderPane('/home/pete/src');
    await findListing('/home/pete/src');

    fireEvent.keyDown(grid(), { key: 'ArrowUp', metaKey: true });
    await findListing('/home/pete');

    fireEvent.click(screen.getByRole('button', { name: 'Go to parent directory' }));
    await findListing('/home');
    expect(selectedName()).toBe('pete');
  });

  it('disables the up button at the root', async () => {
    renderPane('/');
    await findListing('/');

    const up = screen.getByRole('button', { name: 'Go to parent directory' });
    expect(up).toHaveProperty('disabled', true);
  });

  it('narrows the list as the filter is typed', async () => {
    renderPane('/home/pete');
    await findListing('/home/pete');

    fireEvent.change(screen.getByRole('textbox', { name: 'Filter entries' }), {
      target: { value: 'T' },
    });

    expect(rowNames()).toEqual(['empty', 'index.html', 'notes.md', 'todo.txt']);
    expect(screen.getByRole('status').textContent).toBe('4 of 8 items');
  });

  it('says so when the filter matches nothing, and Escape clears it', async () => {
    renderPane('/home/pete');
    await findListing('/home/pete');
    const filter = screen.getByRole('textbox', { name: 'Filter entries' });

    fireEvent.change(filter, { target: { value: 'zzz' } });

    expect(screen.getByText('No entries match "zzz".')).toBeDefined();
    expect(screen.queryAllByRole('rowheader')).toEqual([]);

    fireEvent.keyDown(filter, { key: 'Escape' });

    expect(filter).toHaveProperty('value', '');
    expect(rowNames()).toHaveLength(6);
    expect(document.activeElement).toBe(grid());
  });

  it('opens the first match with Enter from the filter box', async () => {
    const { actions } = renderPane('/home/pete');
    await findListing('/home/pete');
    const filter = screen.getByRole('textbox', { name: 'Filter entries' });

    fireEvent.change(filter, { target: { value: 'notes' } });
    fireEvent.keyDown(filter, { key: 'Enter' });

    expect(actions.openPane).toHaveBeenCalledWith({ type: 'editor', path: '/home/pete/notes.md' });
  });

  it('clears the filter on entering another directory', async () => {
    renderPane('/home/pete');
    await findListing('/home/pete');
    const filter = screen.getByRole('textbox', { name: 'Filter entries' });

    fireEvent.change(filter, { target: { value: 'sr' } });
    fireEvent.keyDown(filter, { key: 'Enter' });

    await findListing('/home/pete/src');
    expect(filter).toHaveProperty('value', '');
    expect(rowNames()).toEqual(['main.ts']);
  });

  it('focuses the filter with a slash, and the list when the pane is active', async () => {
    renderPane('/home/pete');
    await findListing('/home/pete');

    expect(document.activeElement).toBe(grid());

    fireEvent.keyDown(grid(), { key: '/' });

    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Filter entries' }));
  });

  it('ignores keys while the pane is not the active one', async () => {
    const actions = makeActions();
    render(
      <FilesPane
        paneId="pane-1"
        name="files"
        content={{ type: 'files', directory: '/home/pete' }}
        active={false}
        debug={false}
        actions={actions}
      />,
    );
    await findListing('/home/pete');

    fireEvent.keyDown(grid(), { key: 'ArrowDown' });
    fireEvent.keyDown(grid(), { key: 'Enter' });

    expect(document.activeElement).not.toBe(grid());
    expect(selectedName()).toBe('empty');
    expect(listCalls()).toHaveLength(1);
  });

  it('opens a file in an editor pane beside this one', async () => {
    const { actions } = renderPane('/home/pete');
    await findListing('/home/pete');

    fireEvent.click(rowFor('notes.md'));
    fireEvent.keyDown(grid(), { key: 'Enter' });

    expect(actions.openPane).toHaveBeenCalledTimes(1);
    expect(actions.openPane).toHaveBeenCalledWith({ type: 'editor', path: '/home/pete/notes.md' });
    expect(actions.replaceContent).not.toHaveBeenCalled();
  });

  it('opens a file on a double click', async () => {
    const { actions } = renderPane('/home/pete');
    await findListing('/home/pete');

    fireEvent.doubleClick(rowFor('todo.txt'));

    expect(actions.openPane).toHaveBeenCalledWith({ type: 'editor', path: '/home/pete/todo.txt' });
  });

  it('opens an html file in the editor with Enter and in a web pane on request', async () => {
    const { actions } = renderPane('/home/pete');
    await findListing('/home/pete');
    const url = 'localfile://localhost/home/pete/index.html';

    fireEvent.click(rowFor('index.html'));
    fireEvent.keyDown(grid(), { key: 'Enter' });
    expect(actions.openPane).toHaveBeenLastCalledWith({
      type: 'editor',
      path: '/home/pete/index.html',
    });

    fireEvent.click(within(rowFor('index.html')).getByRole('button', { name: 'Open in web pane' }));
    expect(actions.openPane).toHaveBeenLastCalledWith({ type: 'web', url });

    fireEvent.keyDown(grid(), { key: 'Enter', metaKey: true });
    expect(actions.openPane).toHaveBeenCalledTimes(3);
    expect(actions.openPane).toHaveBeenLastCalledWith({ type: 'web', url });
  });

  it('offers the web pane only for html files', async () => {
    const { actions } = renderPane('/home/pete');
    await findListing('/home/pete');

    expect(screen.getAllByRole('button', { name: 'Open in web pane' })).toHaveLength(1);

    fireEvent.click(rowFor('notes.md'));
    fireEvent.keyDown(grid(), { key: 'Enter', metaKey: true });

    expect(actions.openPane).not.toHaveBeenCalled();
  });

  it('opens a terminal in a directory, below this pane', async () => {
    const { actions } = renderPane('/home/pete');
    await findListing('/home/pete');

    expect(screen.getAllByRole('button', { name: 'Open terminal here' })).toHaveLength(3);
    fireEvent.click(within(rowFor('src')).getByRole('button', { name: 'Open terminal here' }));

    expect(actions.openPane).toHaveBeenCalledWith(
      { type: 'terminal', directory: '/home/pete/src', commands: [] },
      { direction: 'column' },
    );
  });

  it('copies a path and says so', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderPane('/home/pete');
    await findListing('/home/pete');

    fireEvent.click(within(rowFor('notes.md')).getByRole('button', { name: 'Copy path' }));

    expect(writeText).toHaveBeenCalledWith('/home/pete/notes.md');
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('Copied /home/pete/notes.md');
    });
    vi.unstubAllGlobals();
  });

  it('reports a copy the system refused', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('Write permission denied.')));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    renderPane('/home/pete');
    await findListing('/home/pete');

    fireEvent.click(within(rowFor('src')).getByRole('button', { name: 'Copy path' }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        'Could not copy the path: Write permission denied.',
      );
    });
    vi.unstubAllGlobals();
  });

  it('sorts by a column on a click and reverses on the next', async () => {
    renderPane('/home/pete');
    await findListing('/home/pete');
    const size = screen.getByRole('button', { name: 'Size' });

    fireEvent.click(size);
    expect(rowNames()).toEqual(['empty', 'locked', 'src', 'notes.md', 'todo.txt', 'index.html']);
    expect(screen.getByRole('columnheader', { name: 'Size' }).getAttribute('aria-sort')).toBe(
      'ascending',
    );

    fireEvent.click(size);
    expect(rowNames()).toEqual(['empty', 'locked', 'src', 'index.html', 'todo.txt', 'notes.md']);
    expect(screen.getByRole('columnheader', { name: 'Size' }).getAttribute('aria-sort')).toBe(
      'descending',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(rowNames()).toEqual(['src', 'locked', 'empty', 'todo.txt', 'notes.md', 'index.html']);
  });

  it('says when a directory is empty', async () => {
    renderPane('/home/pete/empty');
    await findListing('/home/pete/empty');

    expect(screen.getByText('This directory is empty.')).toBeDefined();
    expect(screen.getByRole('status').textContent).toBe('0 items');
  });

  it('shows the error text, then recovers on retry', async () => {
    const { actions } = renderPane('/home/pete');
    await findListing('/home/pete');

    fireEvent.doubleClick(rowFor('locked'));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(DENIED)).toBeDefined();
    expect(screen.queryAllByRole('rowheader')).toEqual([]);
    expect(actions.replaceContent).not.toHaveBeenCalled();

    locked = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));

    await findListing('/home/pete/locked');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(rowNames()).toEqual(['secret.txt']);
    expect(actions.replaceContent).toHaveBeenCalledWith({
      type: 'files',
      directory: '/home/pete/locked',
    });
  });

  it('goes up from the error state', async () => {
    renderPane('/home/pete/locked');

    const alert = await screen.findByRole('alert');
    fireEvent.click(within(alert).getByRole('button', { name: 'Go up' }));

    await findListing('/home/pete');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(selectedName()).toBe('locked');
  });

  it('shows an error for a reply of the wrong shape', async () => {
    vi.mocked(invoke).mockResolvedValue({ entries: 'none' });
    renderPane('/home/pete');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/does not understand/)).toBeDefined();
  });

  it('reloads the directory with the refresh button', async () => {
    renderPane('/home/pete/src');
    await findListing('/home/pete/src');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(listCalls()).toEqual([{ path: '/home/pete/src' }, { path: '/home/pete/src' }]);
    });
    await findListing('/home/pete/src');
  });

  it('writes a debug snapshot of what it shows', async () => {
    renderPane('/home/pete', true);
    await findListing('/home/pete');

    fireEvent.change(screen.getByRole('textbox', { name: 'Filter entries' }), {
      target: { value: 's' },
    });

    await waitFor(
      () => {
        expect(invoke).toHaveBeenCalledWith('debug_snapshot', {
          id: 'files',
          text: '/home/pete\nd src/\nf notes.md 12B\n',
        });
      },
      { timeout: 3000 },
    );
  });
});
