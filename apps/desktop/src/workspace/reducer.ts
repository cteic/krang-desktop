import { findLeaf, leavesOf, tabOfPane } from './model';
import type {
  Badge,
  Direction,
  LeafNode,
  PaneContent,
  PaneTree,
  SplitNode,
  Tab,
  Workspace,
} from './model';
import { equalShares, moveDivider } from './split-sizes';

/** A tab before it joins a workspace. Its ids are local and get replaced. */
export interface TabDraft {
  title: string;
  color: string | null;
  root: PaneTree;
  focusedId: string | null;
}

export type WorkspaceAction =
  | { type: 'focus'; paneId: string }
  | { type: 'focus-next'; offset: 1 | -1 }
  | {
      type: 'split';
      paneId: string;
      direction: Direction;
      content: PaneContent;
      title?: string | null;
    }
  | { type: 'close'; paneId: string }
  | { type: 'toggle-magnify'; paneId: string }
  | { type: 'move-divider'; splitId: string; index: number; delta: number }
  | { type: 'replace-content'; paneId: string; content: PaneContent }
  | { type: 'set-title'; paneId: string; title: string | null }
  | { type: 'set-badge'; paneId: string; badge: Badge | null }
  | { type: 'add-tab'; draft: TabDraft }
  | { type: 'close-tab'; tabId: string }
  | { type: 'activate-tab'; tabId: string }
  | { type: 'activate-next-tab'; offset: 1 | -1 };

export const DEFAULT_CONTENT: PaneContent = { type: 'terminal', directory: null, commands: [] };

export function defaultDraft(): TabDraft {
  return {
    title: 'shell',
    color: null,
    root: { kind: 'leaf', id: 'shell', title: null, badge: null, content: DEFAULT_CONTENT },
    focusedId: 'shell',
  };
}

interface Minted {
  root: PaneTree;
  nextId: number;
  idMap: Map<string, string>;
}

/** Gives every node of a draft tree a workspace-unique id. */
function mint(tree: PaneTree, nextId: number): Minted {
  const idMap = new Map<string, string>();
  let counter = nextId;

  function visit(node: PaneTree): PaneTree {
    const id = `${node.kind === 'leaf' ? 'p' : 's'}${String(counter)}`;
    counter += 1;
    idMap.set(node.id, id);
    if (node.kind === 'leaf') {
      return { ...node, id };
    }
    return { ...node, id, children: node.children.map(visit) };
  }

  const root = visit(tree);
  return { root, nextId: counter, idMap };
}

function tabFromDraft(draft: TabDraft, nextId: number): { tab: Tab; nextId: number } {
  const minted = mint(draft.root, nextId);
  const leaves = leavesOf(minted.root);
  const first = leaves[0];
  if (first === undefined) {
    throw new Error('a tab needs at least one pane');
  }
  const wanted = draft.focusedId === null ? undefined : minted.idMap.get(draft.focusedId);
  const focusedId = leaves.find((leaf) => leaf.id === wanted)?.id ?? first.id;
  return {
    tab: {
      id: `t${String(minted.nextId)}`,
      title: draft.title,
      color: draft.color,
      root: minted.root,
      focusedId,
      magnifiedId: null,
    },
    nextId: minted.nextId + 1,
  };
}

export function createWorkspace(draft: TabDraft): Workspace {
  const { tab, nextId } = tabFromDraft(draft, 1);
  return { tabs: [tab], activeTabId: tab.id, nextId };
}

function mapTree(tree: PaneTree, change: (node: PaneTree) => PaneTree): PaneTree {
  const next =
    tree.kind === 'split'
      ? { ...tree, children: tree.children.map((child) => mapTree(child, change)) }
      : tree;
  return change(next);
}

function updateLeaf(
  tree: PaneTree,
  paneId: string,
  change: (leaf: LeafNode) => LeafNode,
): PaneTree {
  return mapTree(tree, (node) =>
    node.kind === 'leaf' && node.id === paneId ? change(node) : node,
  );
}

function replaceTab(workspace: Workspace, tab: Tab): Workspace {
  return { ...workspace, tabs: workspace.tabs.map((each) => (each.id === tab.id ? tab : each)) };
}

function splitLeaf(
  tree: PaneTree,
  paneId: string,
  direction: Direction,
  added: LeafNode,
  splitId: string,
): PaneTree {
  if (tree.kind === 'leaf') {
    if (tree.id !== paneId) {
      return tree;
    }
    return { kind: 'split', id: splitId, direction, children: [tree, added], shares: [0.5, 0.5] };
  }

  const index = tree.children.findIndex((child) => child.kind === 'leaf' && child.id === paneId);
  if (index !== -1 && tree.direction === direction) {
    // Same direction as the parent: become a sibling and halve the share,
    // rather than nesting a split inside a split of the same kind.
    const share = tree.shares[index] ?? 1 / tree.children.length;
    const children = [...tree.children];
    children.splice(index + 1, 0, added);
    const shares = [...tree.shares];
    shares.splice(index, 1, share / 2, share / 2);
    return { ...tree, children, shares };
  }

  return {
    ...tree,
    children: tree.children.map((child) => splitLeaf(child, paneId, direction, added, splitId)),
  };
}

/** Removes a pane. A split left with one child is replaced by that child. */
function removeLeaf(tree: PaneTree, paneId: string): PaneTree | null {
  if (tree.kind === 'leaf') {
    return tree.id === paneId ? null : tree;
  }

  const children: PaneTree[] = [];
  const shares: number[] = [];
  tree.children.forEach((child, index) => {
    const kept = removeLeaf(child, paneId);
    if (kept !== null) {
      children.push(kept);
      shares.push(tree.shares[index] ?? 0);
    }
  });

  const only = children[0];
  if (only === undefined) {
    return null;
  }
  if (children.length === 1) {
    return only;
  }
  const total = shares.reduce((sum, share) => sum + share, 0);
  const normalised =
    total > 0 ? shares.map((share) => share / total) : equalShares(children.length);
  return { ...tree, children, shares: normalised };
}

function closeTab(workspace: Workspace, tabId: string): Workspace {
  const index = workspace.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) {
    return workspace;
  }
  const tabs = workspace.tabs.filter((tab) => tab.id !== tabId);
  if (tabs.length === 0) {
    // A window always shows something. The last tab is replaced, not removed.
    const { tab, nextId } = tabFromDraft(defaultDraft(), workspace.nextId);
    return { tabs: [tab], activeTabId: tab.id, nextId };
  }
  if (workspace.activeTabId !== tabId) {
    return { ...workspace, tabs };
  }
  const neighbour = tabs[Math.min(index, tabs.length - 1)];
  return { ...workspace, tabs, activeTabId: neighbour?.id ?? workspace.activeTabId };
}

function closePane(workspace: Workspace, paneId: string): Workspace {
  const tab = tabOfPane(workspace, paneId);
  if (tab === null) {
    return workspace;
  }
  const before = leavesOf(tab.root);
  const index = before.findIndex((leaf) => leaf.id === paneId);
  const root = removeLeaf(tab.root, paneId);
  if (root === null) {
    return closeTab(workspace, tab.id);
  }
  const after = leavesOf(root);
  const fallback = after[Math.min(index, after.length - 1)];
  const focusedId = tab.focusedId === paneId ? (fallback?.id ?? tab.focusedId) : tab.focusedId;
  return replaceTab(workspace, {
    ...tab,
    root,
    focusedId,
    magnifiedId: tab.magnifiedId === paneId ? null : tab.magnifiedId,
  });
}

function withLeaf(
  workspace: Workspace,
  paneId: string,
  change: (leaf: LeafNode) => LeafNode,
): Workspace {
  const tab = tabOfPane(workspace, paneId);
  if (tab === null) {
    return workspace;
  }
  return replaceTab(workspace, { ...tab, root: updateLeaf(tab.root, paneId, change) });
}

function cycle(length: number, index: number, offset: 1 | -1): number {
  return (index + offset + length) % length;
}

export function workspaceReducer(workspace: Workspace, action: WorkspaceAction): Workspace {
  switch (action.type) {
    case 'focus': {
      const tab = tabOfPane(workspace, action.paneId);
      if (tab === null || (tab.focusedId === action.paneId && workspace.activeTabId === tab.id)) {
        return workspace;
      }
      return {
        ...replaceTab(workspace, { ...tab, focusedId: action.paneId }),
        activeTabId: tab.id,
      };
    }

    case 'focus-next': {
      const tab = workspace.tabs.find((each) => each.id === workspace.activeTabId);
      if (tab === undefined) {
        return workspace;
      }
      const leaves = leavesOf(tab.root);
      const index = leaves.findIndex((leaf) => leaf.id === tab.focusedId);
      const next = leaves[cycle(leaves.length, Math.max(index, 0), action.offset)];
      if (next === undefined || next.id === tab.focusedId) {
        return workspace;
      }
      return replaceTab(workspace, {
        ...tab,
        focusedId: next.id,
        magnifiedId: tab.magnifiedId === null ? null : next.id,
      });
    }

    case 'split': {
      const tab = tabOfPane(workspace, action.paneId);
      if (tab === null) {
        return workspace;
      }
      const paneId = `p${String(workspace.nextId)}`;
      const splitId = `s${String(workspace.nextId + 1)}`;
      const added: LeafNode = {
        kind: 'leaf',
        id: paneId,
        title: action.title ?? null,
        badge: null,
        content: action.content,
      };
      const root = splitLeaf(tab.root, action.paneId, action.direction, added, splitId);
      return {
        ...replaceTab(workspace, { ...tab, root, focusedId: paneId, magnifiedId: null }),
        activeTabId: tab.id,
        nextId: workspace.nextId + 2,
      };
    }

    case 'close':
      return closePane(workspace, action.paneId);

    case 'toggle-magnify': {
      const tab = tabOfPane(workspace, action.paneId);
      if (tab === null) {
        return workspace;
      }
      const magnifiedId = tab.magnifiedId === action.paneId ? null : action.paneId;
      return replaceTab(workspace, { ...tab, magnifiedId, focusedId: action.paneId });
    }

    case 'move-divider': {
      const tabs = workspace.tabs.map((tab) => ({
        ...tab,
        root: mapTree(tab.root, (node) => {
          if (node.kind !== 'split' || node.id !== action.splitId) {
            return node;
          }
          const split: SplitNode = {
            ...node,
            shares: moveDivider(node.shares, action.index, action.delta),
          };
          return split;
        }),
      }));
      return { ...workspace, tabs };
    }

    case 'replace-content':
      return withLeaf(workspace, action.paneId, (leaf) => ({ ...leaf, content: action.content }));

    case 'set-title':
      return withLeaf(workspace, action.paneId, (leaf) => ({ ...leaf, title: action.title }));

    case 'set-badge':
      return withLeaf(workspace, action.paneId, (leaf) => ({ ...leaf, badge: action.badge }));

    case 'add-tab': {
      const { tab, nextId } = tabFromDraft(action.draft, workspace.nextId);
      return { tabs: [...workspace.tabs, tab], activeTabId: tab.id, nextId };
    }

    case 'close-tab':
      return closeTab(workspace, action.tabId);

    case 'activate-tab':
      if (!workspace.tabs.some((tab) => tab.id === action.tabId)) {
        return workspace;
      }
      return { ...workspace, activeTabId: action.tabId };

    case 'activate-next-tab': {
      const index = workspace.tabs.findIndex((tab) => tab.id === workspace.activeTabId);
      const next = workspace.tabs[cycle(workspace.tabs.length, Math.max(index, 0), action.offset)];
      return next === undefined ? workspace : { ...workspace, activeTabId: next.id };
    }
  }
}

/** Whether a pane exists anywhere in the workspace. */
export function hasPane(workspace: Workspace, paneId: string): boolean {
  return workspace.tabs.some((tab) => findLeaf(tab.root, paneId) !== null);
}
