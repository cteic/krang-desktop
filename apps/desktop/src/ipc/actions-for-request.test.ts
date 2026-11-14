import { describe, expect, it } from 'vitest';

import { activeTab, leavesOf } from '../workspace/model';
import type { Workspace } from '../workspace/model';
import { createWorkspace, workspaceReducer } from '../workspace/reducer';
import type { WorkspaceAction } from '../workspace/reducer';

import { actionsForRequest, localFileUrl, replyFor } from './actions-for-request';
import { requestIdOf } from './request';

function start(): Workspace {
  const first = createWorkspace({
    title: 'one',
    color: null,
    focusedId: 'a',
    root: {
      kind: 'leaf',
      id: 'a',
      title: null,
      badge: null,
      content: { type: 'terminal', directory: '/work', commands: [] },
    },
  });
  return workspaceReducer(first, {
    type: 'add-tab',
    draft: {
      title: 'two',
      color: null,
      focusedId: 'notes',
      root: {
        kind: 'split',
        id: 'root',
        direction: 'row',
        shares: [0.5, 0.5],
        children: [
          {
            kind: 'leaf',
            id: 'notes',
            title: null,
            badge: null,
            content: { type: 'editor', path: '/work/notes.md' },
          },
          {
            kind: 'leaf',
            id: 'docs',
            title: 'Docs',
            badge: null,
            content: { type: 'web', url: 'https://example.com/guide' },
          },
        ],
      },
    },
  });
}

const WORKSPACE = start();

function paneIds(workspace: Workspace): string[] {
  return workspace.tabs.flatMap((tab) => leavesOf(tab.root).map((leaf) => leaf.id));
}

const [SHELL = '', NOTES = '', DOCS = ''] = paneIds(WORKSPACE);

function request(command: Record<string, unknown>, pane: string = SHELL) {
  return { requestId: 'r1', pane, command };
}

function actionsOf(command: Record<string, unknown>, pane: string = SHELL): WorkspaceAction[] {
  const outcome = actionsForRequest(request(command, pane), WORKSPACE);
  if (!outcome.ok) {
    throw new Error(outcome.error);
  }
  expect(outcome.data).toBeNull();
  return outcome.actions;
}

function errorOf(payload: unknown): string {
  const outcome = actionsForRequest(payload, WORKSPACE);
  if (outcome.ok) {
    throw new Error('expected the request to be refused');
  }
  return outcome.error;
}

const LAYOUT = `
name = "review"
title = "Review"

[[panes]]
id = "root"
split = "vertical"
children = ["diff", "shell"]

[[panes]]
id = "diff"
type = "editor"
path = "/work/a.diff"

[[panes]]
id = "shell"
is_focused = true
`;

describe('actionsForRequest', () => {
  it('has three panes to work with', () => {
    expect([SHELL, NOTES, DOCS].every((id) => id !== '')).toBe(true);
  });

  it('opens a file in an editor beside the calling pane', () => {
    expect(
      actionsOf({ name: 'view', path: '/work/readme.md', kind: 'file', direction: 'row' }),
    ).toEqual([
      {
        type: 'split',
        paneId: SHELL,
        direction: 'row',
        content: { type: 'editor', path: '/work/readme.md' },
      },
    ]);
  });

  it('opens a directory in a files pane, below when asked', () => {
    expect(
      actionsOf({ name: 'view', path: '/work/src', kind: 'directory', direction: 'column' }, NOTES),
    ).toEqual([
      {
        type: 'split',
        paneId: NOTES,
        direction: 'column',
        content: { type: 'files', directory: '/work/src' },
      },
    ]);
  });

  it('opens a web address as given', () => {
    expect(
      actionsOf({ name: 'web', target: { url: 'http://localhost:3000/a b' }, direction: 'row' }),
    ).toEqual([
      {
        type: 'split',
        paneId: SHELL,
        direction: 'row',
        content: { type: 'web', url: 'http://localhost:3000/a b' },
      },
    ]);
  });

  it('opens a file on disk through the local file scheme', () => {
    expect(
      actionsOf({
        name: 'web',
        target: { path: '/work/site out/index#1.html' },
        direction: 'column',
      }),
    ).toEqual([
      {
        type: 'split',
        paneId: SHELL,
        direction: 'column',
        content: { type: 'web', url: 'localfile://localhost/work/site%20out/index%231.html' },
      },
    ]);
  });

  it('opens a terminal with its startup command', () => {
    expect(actionsOf({ name: 'term', directory: '/work/api', command: 'pnpm dev' })).toEqual([
      {
        type: 'split',
        paneId: SHELL,
        direction: 'row',
        content: { type: 'terminal', directory: '/work/api', commands: ['pnpm dev'] },
      },
    ]);
  });

  it('opens a terminal with no command', () => {
    expect(actionsOf({ name: 'term', directory: '/work', command: null })).toEqual([
      {
        type: 'split',
        paneId: SHELL,
        direction: 'row',
        content: { type: 'terminal', directory: '/work', commands: [] },
      },
    ]);
  });

  it('opens a chat pane', () => {
    expect(actionsOf({ name: 'chat', agent: 'codex', directory: '/work' })).toEqual([
      {
        type: 'split',
        paneId: SHELL,
        direction: 'row',
        content: { type: 'chat', agent: 'codex', directory: '/work' },
      },
    ]);
    expect(actionsOf({ name: 'chat', agent: null, directory: '/work' })).toEqual([
      {
        type: 'split',
        paneId: SHELL,
        direction: 'row',
        content: { type: 'chat', agent: null, directory: '/work' },
      },
    ]);
  });

  it('opens a graph pane on a vault', () => {
    expect(actionsOf({ name: 'graph', directory: '/vault' })).toEqual([
      {
        type: 'split',
        paneId: SHELL,
        direction: 'row',
        content: { type: 'graph', directory: '/vault', view: null },
      },
    ]);
  });

  it('sets and clears the title of the calling pane', () => {
    expect(actionsOf({ name: 'title', title: 'build' }, DOCS)).toEqual([
      { type: 'set-title', paneId: DOCS, title: 'build' },
    ]);
    expect(actionsOf({ name: 'title', title: null })).toEqual([
      { type: 'set-title', paneId: SHELL, title: null },
    ]);
  });

  it('sets and clears the badge of the calling pane', () => {
    expect(actionsOf({ name: 'badge', badge: { text: '!', color: '#ff8800' } })).toEqual([
      { type: 'set-badge', paneId: SHELL, badge: { text: '!', color: '#ff8800' } },
    ]);
    expect(actionsOf({ name: 'badge', badge: { text: 'done', color: null } })).toEqual([
      { type: 'set-badge', paneId: SHELL, badge: { text: 'done', color: null } },
    ]);
    expect(actionsOf({ name: 'badge', badge: null })).toEqual([
      { type: 'set-badge', paneId: SHELL, badge: null },
    ]);
  });

  it('opens a layout as a new tab', () => {
    const actions = actionsOf({ name: 'layout', path: '/layouts/review.toml', text: LAYOUT });
    expect(actions).toHaveLength(1);
    const action = actions[0];
    if (action?.type !== 'add-tab') {
      throw new Error('expected an add-tab action');
    }
    expect(action.draft.title).toBe('Review');
    expect(action.draft.focusedId).toBe('shell');

    const next = workspaceReducer(WORKSPACE, action);
    expect(next.tabs).toHaveLength(3);
    expect(activeTab(next)?.title).toBe('Review');
  });

  it('reports a layout that does not parse, naming the file', () => {
    const error = errorOf(
      request({ name: 'layout', path: '/layouts/broken.toml', text: 'name = ' }),
    );
    expect(error).toContain('could not load /layouts/broken.toml: not valid TOML');
    expect(
      errorOf(request({ name: 'layout', path: '/layouts/empty.toml', text: 'name = "x"' })),
    ).toContain('could not load /layouts/empty.toml: layout does not match the expected shape');
  });

  it('describes every tab and pane, and dispatches nothing', () => {
    const outcome = actionsForRequest(request({ name: 'panes' }, NOTES), WORKSPACE);
    expect(outcome).toEqual({
      ok: true,
      actions: [],
      data: {
        tabs: [
          {
            id: WORKSPACE.tabs[0]?.id,
            title: 'one',
            active: false,
            panes: [{ id: SHELL, title: 'terminal', type: 'terminal', focused: false }],
          },
          {
            id: WORKSPACE.tabs[1]?.id,
            title: 'two',
            active: true,
            panes: [
              { id: NOTES, title: 'notes.md', type: 'editor', focused: true },
              { id: DOCS, title: 'Docs', type: 'web', focused: false },
            ],
          },
        ],
      },
    });
  });

  it('refuses a pane id that is not in the workspace', () => {
    expect(errorOf(request({ name: 'title', title: 'x' }, 'p999'))).toBe(
      'no pane with id p999 in this window',
    );
    expect(errorOf(request({ name: 'panes' }, 'p999'))).toBe('no pane with id p999 in this window');
  });

  it('refuses a malformed payload', () => {
    const malformed: unknown[] = [
      null,
      'view',
      {},
      { requestId: 'r1', pane: SHELL },
      { requestId: 'r1', pane: SHELL, command: { name: 'explode' } },
      { requestId: 'r1', pane: SHELL, command: { name: 'view', path: '/a' } },
      { requestId: 'r1', pane: SHELL, command: { name: 'view', path: '/a', kind: 'socket' } },
      { requestId: 'r1', pane: SHELL, command: { name: 'web', target: {}, direction: 'row' } },
      { requestId: 'r1', pane: SHELL, command: { name: 'badge', badge: { color: '#fff' } } },
      { requestId: 'r1', pane: 7, command: { name: 'panes' } },
      { pane: SHELL, command: { name: 'panes' } },
    ];
    for (const payload of malformed) {
      expect(errorOf(payload)).toMatch(/^the app could not read the request/);
    }
  });

  it('applies cleanly through the reducer', () => {
    const [action] = actionsOf({
      name: 'view',
      path: '/work/src',
      kind: 'directory',
      direction: 'row',
    });
    if (action === undefined) {
      throw new Error('expected one action');
    }
    const next = workspaceReducer(WORKSPACE, action);
    expect(paneIds(next)).toHaveLength(4);
    expect(activeTab(next)?.title).toBe('one');
  });
});

describe('localFileUrl', () => {
  it('keeps slashes and escapes everything else that needs it', () => {
    expect(localFileUrl('/work/index.html')).toBe('localfile://localhost/work/index.html');
    expect(localFileUrl('/a b/c?d/e%f/ü.html')).toBe(
      'localfile://localhost/a%20b/c%3Fd/e%25f/%C3%BC.html',
    );
  });
});

describe('replyFor', () => {
  it('carries data only when there is some', () => {
    expect(replyFor({ ok: true, actions: [], data: null })).toEqual({ ok: true });
    expect(replyFor({ ok: true, actions: [], data: { tabs: [] } })).toEqual({
      ok: true,
      data: { tabs: [] },
    });
    expect(replyFor({ ok: false, error: 'no' })).toEqual({ ok: false, error: 'no' });
  });
});

describe('requestIdOf', () => {
  it('finds the id even when the rest is unusable', () => {
    expect(requestIdOf({ requestId: 'r7', command: 'nonsense' })).toBe('r7');
    expect(requestIdOf({ requestId: '' })).toBeNull();
    expect(requestIdOf('r7')).toBeNull();
    expect(requestIdOf(null)).toBeNull();
  });
});
