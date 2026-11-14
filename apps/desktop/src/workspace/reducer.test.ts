import { describe, expect, it } from 'vitest';

import { activeTab, leavesOf } from './model';
import type { LeafNode, PaneContent, PaneTree, Workspace } from './model';
import {
  createWorkspace,
  createWorkspaceWithTabs,
  defaultDraft,
  hasPane,
  workspaceReducer,
} from './reducer';
import type { TabDraft, WorkspaceAction } from './reducer';

const TERMINAL: PaneContent = { type: 'terminal', directory: null, commands: [] };
const FILES: PaneContent = { type: 'files', directory: '/tmp' };

function leaf(id: string): LeafNode {
  return { kind: 'leaf', id, title: id, badge: null, content: TERMINAL };
}

const COCKPIT: TabDraft = {
  title: 'krang',
  color: 'blue',
  focusedId: 'agent',
  root: {
    kind: 'split',
    id: 'root',
    direction: 'row',
    shares: [0.5, 0.5],
    children: [
      {
        kind: 'split',
        id: 'left',
        direction: 'column',
        shares: [0.5, 0.5],
        children: [leaf('shell'), leaf('state')],
      },
      leaf('agent'),
    ],
  },
};

function run(workspace: Workspace, ...actions: WorkspaceAction[]): Workspace {
  return actions.reduce(workspaceReducer, workspace);
}

function tabOf(workspace: Workspace) {
  const tab = activeTab(workspace);
  if (tab === null) {
    throw new Error('no active tab');
  }
  return tab;
}

function idByTitle(workspace: Workspace, title: string): string {
  const found = workspace.tabs
    .flatMap((tab) => leavesOf(tab.root))
    .find((each) => each.title === title);
  if (found === undefined) {
    throw new Error(`no pane titled ${title}`);
  }
  return found.id;
}

function titles(tree: PaneTree): (string | null)[] {
  return leavesOf(tree).map((each) => each.title);
}

function allIds(workspace: Workspace): string[] {
  const ids: string[] = [];
  function visit(node: PaneTree) {
    ids.push(node.id);
    if (node.kind === 'split') {
      node.children.forEach(visit);
    }
  }
  workspace.tabs.forEach((tab) => {
    ids.push(tab.id);
    visit(tab.root);
  });
  return ids;
}

describe('createWorkspace', () => {
  it('keeps the draft shape, focus and titles, with fresh ids', () => {
    const workspace = createWorkspace(COCKPIT);
    const tab = tabOf(workspace);

    expect(tab.title).toBe('krang');
    expect(titles(tab.root)).toEqual(['shell', 'state', 'agent']);
    expect(tab.focusedId).toBe(idByTitle(workspace, 'agent'));
    expect(leavesOf(tab.root).map((each) => each.id)).not.toContain('agent');
  });

  it('focuses the first pane when the draft names none', () => {
    const workspace = createWorkspace({ ...COCKPIT, focusedId: null });
    expect(tabOf(workspace).focusedId).toBe(idByTitle(workspace, 'shell'));
  });
});

describe('split', () => {
  it('nests a new split when the direction differs from the parent', () => {
    const start = createWorkspace(defaultDraft());
    const first = tabOf(start).focusedId;
    const next = run(start, { type: 'split', paneId: first, direction: 'row', content: FILES });
    const root = tabOf(next).root;

    expect(root.kind).toBe('split');
    expect(leavesOf(root).map((each) => each.content.type)).toEqual(['terminal', 'files']);
    expect(root.kind === 'split' ? root.shares : []).toEqual([0.5, 0.5]);
  });

  it('adds a sibling and halves the share when the direction matches the parent', () => {
    const start = createWorkspace(COCKPIT);
    const shell = idByTitle(start, 'shell');
    const next = run(start, { type: 'split', paneId: shell, direction: 'column', content: FILES });
    const root = tabOf(next).root;
    const left = root.kind === 'split' ? root.children[0] : undefined;

    expect(left?.kind).toBe('split');
    expect(left?.kind === 'split' ? left.children.length : 0).toBe(3);
    expect(left?.kind === 'split' ? left.shares : []).toEqual([0.25, 0.25, 0.5]);
    expect(leavesOf(root).map((each) => each.content.type)).toEqual([
      'terminal',
      'files',
      'terminal',
      'terminal',
    ]);
  });

  it('focuses the new pane and leaves magnify', () => {
    const start = createWorkspace(COCKPIT);
    const shell = idByTitle(start, 'shell');
    const next = run(
      start,
      { type: 'toggle-magnify', paneId: shell },
      { type: 'split', paneId: shell, direction: 'row', content: FILES, title: 'docs' },
    );
    const tab = tabOf(next);

    expect(tab.magnifiedId).toBeNull();
    expect(tab.focusedId).toBe(idByTitle(next, 'docs'));
  });

  it('keeps every id unique across many splits and tabs', () => {
    let workspace = createWorkspace(COCKPIT);
    workspace = run(workspace, { type: 'add-tab', draft: COCKPIT });
    for (let round = 0; round < 6; round += 1) {
      const target = tabOf(workspace).focusedId;
      workspace = run(workspace, {
        type: 'split',
        paneId: target,
        direction: round % 2 === 0 ? 'row' : 'column',
        content: FILES,
      });
    }
    const ids = allIds(workspace);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ignores a pane that does not exist', () => {
    const start = createWorkspace(COCKPIT);
    expect(run(start, { type: 'split', paneId: 'nope', direction: 'row', content: FILES })).toBe(
      start,
    );
  });
});

describe('close', () => {
  it('collapses a split left with one child and keeps the other panes', () => {
    const start = createWorkspace(COCKPIT);
    const next = run(start, { type: 'close', paneId: idByTitle(start, 'state') });
    const root = tabOf(next).root;

    expect(titles(root)).toEqual(['shell', 'agent']);
    expect(root.kind === 'split' ? root.children.map((child) => child.kind) : []).toEqual([
      'leaf',
      'leaf',
    ]);
    expect(root.kind === 'split' ? root.shares : []).toEqual([0.5, 0.5]);
  });

  it('keeps the same pane objects, so their terminals are not restarted', () => {
    const start = createWorkspace(COCKPIT);
    const agentBefore = leavesOf(tabOf(start).root).find((each) => each.title === 'agent');
    const next = run(start, { type: 'close', paneId: idByTitle(start, 'state') });
    const agentAfter = leavesOf(tabOf(next).root).find((each) => each.title === 'agent');

    expect(agentAfter).toBe(agentBefore);
  });

  it('moves focus to a neighbour when the focused pane closes', () => {
    const start = createWorkspace(COCKPIT);
    const next = run(start, { type: 'close', paneId: idByTitle(start, 'agent') });
    expect(tabOf(next).focusedId).toBe(idByTitle(next, 'state'));
  });

  it('gives the freed share back so shares still sum to one', () => {
    const start = createWorkspace(COCKPIT);
    const shell = idByTitle(start, 'shell');
    const split = run(start, { type: 'split', paneId: shell, direction: 'column', content: FILES });
    const next = run(split, { type: 'close', paneId: shell });
    const root = tabOf(next).root;
    const left = root.kind === 'split' ? root.children[0] : undefined;
    const shares = left?.kind === 'split' ? left.shares : [];

    expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1);
    expect(shares).toHaveLength(2);
  });

  it('replaces the last tab with a fresh shell when its last pane closes', () => {
    const start = createWorkspace(defaultDraft());
    const only = tabOf(start).focusedId;
    const next = run(start, { type: 'close', paneId: only });

    expect(next.tabs).toHaveLength(1);
    expect(hasPane(next, only)).toBe(false);
    expect(leavesOf(tabOf(next).root)).toHaveLength(1);
  });

  it('closes the tab when its last pane closes and another tab exists', () => {
    const start = run(createWorkspace(COCKPIT), { type: 'add-tab', draft: defaultDraft() });
    const only = tabOf(start).focusedId;
    const next = run(start, { type: 'close', paneId: only });

    expect(next.tabs).toHaveLength(1);
    expect(tabOf(next).title).toBe('krang');
  });
});

describe('magnify and focus', () => {
  it('toggles magnify on one pane', () => {
    const start = createWorkspace(COCKPIT);
    const state = idByTitle(start, 'state');
    const on = run(start, { type: 'toggle-magnify', paneId: state });
    expect(tabOf(on).magnifiedId).toBe(state);
    expect(tabOf(on).focusedId).toBe(state);
    expect(tabOf(run(on, { type: 'toggle-magnify', paneId: state })).magnifiedId).toBeNull();
  });

  it('cycles focus in reading order and wraps', () => {
    const start = createWorkspace(COCKPIT);
    const next = run(start, { type: 'focus-next', offset: 1 });
    expect(tabOf(next).focusedId).toBe(idByTitle(start, 'shell'));
    const back = run(next, { type: 'focus-next', offset: -1 });
    expect(tabOf(back).focusedId).toBe(idByTitle(start, 'agent'));
  });

  it('carries magnify along when focus cycles', () => {
    const start = createWorkspace(COCKPIT);
    const agent = idByTitle(start, 'agent');
    const next = run(
      start,
      { type: 'toggle-magnify', paneId: agent },
      { type: 'focus-next', offset: 1 },
    );
    expect(tabOf(next).magnifiedId).toBe(idByTitle(start, 'shell'));
  });

  it('returns the same workspace when focus does not change', () => {
    const start = createWorkspace(COCKPIT);
    expect(run(start, { type: 'focus', paneId: tabOf(start).focusedId })).toBe(start);
  });

  it('activates the tab that owns a focused pane', () => {
    const first = createWorkspace(COCKPIT);
    const shell = idByTitle(first, 'shell');
    const two = run(first, { type: 'add-tab', draft: defaultDraft() });
    const next = run(two, { type: 'focus', paneId: shell });
    expect(tabOf(next).title).toBe('krang');
    expect(tabOf(next).focusedId).toBe(shell);
  });
});

describe('pane fields', () => {
  it('sets title, badge and content on one pane only', () => {
    const start = createWorkspace(COCKPIT);
    const state = idByTitle(start, 'state');
    const next = run(
      start,
      { type: 'set-title', paneId: state, title: 'renamed' },
      { type: 'set-badge', paneId: state, badge: { text: '!', color: '#e0b956' } },
      { type: 'replace-content', paneId: state, content: FILES },
    );
    const changed = leavesOf(tabOf(next).root).find((each) => each.id === state);

    expect(changed?.title).toBe('renamed');
    expect(changed?.badge).toEqual({ text: '!', color: '#e0b956' });
    expect(changed?.content).toBe(FILES);
    expect(titles(tabOf(next).root)).toEqual(['shell', 'renamed', 'agent']);
  });

  it('moves a divider by share', () => {
    const start = createWorkspace(COCKPIT);
    const rootId = tabOf(start).root.id;
    const next = run(start, { type: 'move-divider', splitId: rootId, index: 0, delta: 0.1 });
    const root = tabOf(next).root;
    expect(root.kind === 'split' ? root.shares[0] : 0).toBeCloseTo(0.6);
  });
});

describe('tabs', () => {
  it('adds a tab and activates it', () => {
    const next = run(createWorkspace(COCKPIT), { type: 'add-tab', draft: defaultDraft() });
    expect(next.tabs.map((tab) => tab.title)).toEqual(['krang', 'shell']);
    expect(tabOf(next).title).toBe('shell');
  });

  it('activates a neighbour when the active tab closes', () => {
    const two = run(createWorkspace(COCKPIT), { type: 'add-tab', draft: defaultDraft() });
    const next = run(two, { type: 'close-tab', tabId: two.activeTabId });
    expect(tabOf(next).title).toBe('krang');
  });

  it('cycles tabs and wraps', () => {
    const two = run(createWorkspace(COCKPIT), { type: 'add-tab', draft: defaultDraft() });
    expect(tabOf(run(two, { type: 'activate-next-tab', offset: 1 })).title).toBe('krang');
    expect(tabOf(run(two, { type: 'activate-next-tab', offset: -1 })).title).toBe('krang');
  });

  it('ignores an unknown tab', () => {
    const start = createWorkspace(COCKPIT);
    expect(run(start, { type: 'activate-tab', tabId: 'nope' })).toBe(start);
    expect(run(start, { type: 'close-tab', tabId: 'nope' })).toBe(start);
  });
});

describe('createWorkspaceWithTabs', () => {
  it('makes one tab per draft with unique ids and the first tab active', () => {
    const workspace = createWorkspaceWithTabs([COCKPIT, defaultDraft(), COCKPIT]);

    expect(workspace.tabs.map((tab) => tab.title)).toEqual(['krang', 'shell', 'krang']);
    expect(workspace.activeTabId).toBe(workspace.tabs[0]?.id);
    const ids = workspace.tabs.flatMap((tab) => [tab.id, ...leavesOf(tab.root).map((l) => l.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => Number(id.slice(1)) < workspace.nextId)).toBe(true);
    expect(createWorkspaceWithTabs([COCKPIT])).toEqual(createWorkspace(COCKPIT));
  });

  it('is the default workspace when given no drafts', () => {
    expect(createWorkspaceWithTabs([])).toEqual(createWorkspace(defaultDraft()));
  });
});
