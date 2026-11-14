/**
 * The workspace is everything one window shows: tabs, and in each tab a tree
 * of splits whose leaves are panes. A pane's content says what kind it is.
 */

export interface TerminalContent {
  type: 'terminal';
  directory: string | null;
  commands: string[];
}

export interface FilesContent {
  type: 'files';
  directory: string | null;
}

export interface EditorContent {
  type: 'editor';
  path: string | null;
}

export interface WebContent {
  type: 'web';
  url: string;
}

export interface ChatContent {
  type: 'chat';
  /** Which command-line agent answers. Null means the pane's default. */
  agent: string | null;
  directory: string | null;
}

export type PaneContent = TerminalContent | FilesContent | EditorContent | WebContent | ChatContent;

export type PaneType = PaneContent['type'];

export type Direction = 'row' | 'column';

export interface Badge {
  text: string;
  color: string | null;
}

export interface LeafNode {
  kind: 'leaf';
  id: string;
  /** Set by a layout file or the person. Null means "derive from content". */
  title: string | null;
  badge: Badge | null;
  content: PaneContent;
}

export interface SplitNode {
  kind: 'split';
  id: string;
  direction: Direction;
  children: PaneTree[];
  /** One share per child. They sum to 1. */
  shares: number[];
}

export type PaneTree = LeafNode | SplitNode;

export interface Tab {
  id: string;
  title: string;
  color: string | null;
  root: PaneTree;
  focusedId: string;
  magnifiedId: string | null;
}

export interface Workspace {
  tabs: Tab[];
  activeTabId: string;
  /** Source of new ids. Every pane, split and tab id in a workspace is unique. */
  nextId: number;
}

export function leavesOf(tree: PaneTree): LeafNode[] {
  if (tree.kind === 'leaf') {
    return [tree];
  }
  return tree.children.flatMap(leavesOf);
}

export function findLeaf(tree: PaneTree, paneId: string): LeafNode | null {
  return leavesOf(tree).find((leaf) => leaf.id === paneId) ?? null;
}

export function activeTab(workspace: Workspace): Tab | null {
  return workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ?? null;
}

export function tabOfPane(workspace: Workspace, paneId: string): Tab | null {
  return workspace.tabs.find((tab) => findLeaf(tab.root, paneId) !== null) ?? null;
}

const FALLBACK_TITLES: Record<PaneType, string> = {
  terminal: 'terminal',
  files: 'files',
  editor: 'untitled',
  web: 'web',
  chat: 'chat',
};

function lastSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  const segment = index === -1 ? trimmed : trimmed.slice(index + 1);
  return segment === '' ? path : segment;
}

/** The text shown in a pane's title bar. */
export function paneTitle(leaf: LeafNode): string {
  if (leaf.title !== null) {
    return leaf.title;
  }
  const content = leaf.content;
  if (content.type === 'files' && content.directory !== null) {
    return lastSegment(content.directory);
  }
  if (content.type === 'editor' && content.path !== null) {
    return lastSegment(content.path);
  }
  if (content.type === 'web') {
    try {
      const url = new URL(content.url);
      return url.host === '' ? lastSegment(url.pathname) : url.host;
    } catch {
      return content.url;
    }
  }
  return FALLBACK_TITLES[content.type];
}
