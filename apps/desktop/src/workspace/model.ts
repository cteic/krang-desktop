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

export const EDITOR_MODES = ['edit', 'split', 'preview'] as const;

export type EditorMode = (typeof EDITOR_MODES)[number];

export interface EditorContent {
  type: 'editor';
  path: string | null;
  /** How a Markdown file is shown. Left out, the pane picks its default. */
  mode?: EditorMode | undefined;
}

export interface WebContent {
  type: 'web';
  url: string;
}

export const CHAT_MODES = ['read-only', 'edit'] as const;

export type ChatMode = (typeof CHAT_MODES)[number];

/** One line of a saved chat, as plain data. */
export type ChatHistoryItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; stopped: boolean }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'note'; text: string }
  | { kind: 'error'; text: string }
  /** A run that was still going when the pane went away. It was not restarted. */
  | { kind: 'interrupted' };

/** What a chat pane keeps of its conversation between runs of the app. */
export interface ChatHistory {
  /** The agent's id for the conversation, so a follow-up carries on from it. */
  sessionId: string | null;
  /** True when a run was in progress at the time this was saved. */
  running: boolean;
  /** True when older items were left out to keep the saved size bounded. */
  truncated: boolean;
  items: ChatHistoryItem[];
}

export interface ChatContent {
  type: 'chat';
  /** Which command-line agent answers. Null means the pane's default. */
  agent: string | null;
  directory: string | null;
  /** What the agent may do. Left out, the chat is read only. */
  mode?: ChatMode | undefined;
  /** The conversation so far. Left out, the chat is new. */
  history?: ChatHistory | undefined;
}

export interface GraphContent {
  type: 'graph';
  /** A notes vault that uses the Discourse Graphs plugin. Null asks for one. */
  directory: string | null;
  /** A canvas in the vault, by file name. Null shows every node. */
  view: string | null;
}

export type PaneContent =
  TerminalContent | FilesContent | EditorContent | WebContent | ChatContent | GraphContent;

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
  graph: 'graph',
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
  if ((content.type === 'files' || content.type === 'graph') && content.directory !== null) {
    return lastSegment(content.directory);
  }
  if (content.type === 'editor' && content.path !== null) {
    return lastSegment(content.path);
  }
  if (content.type === 'web') {
    try {
      const url = new URL(content.url);
      const isLocalFile = url.protocol === 'localfile:' || url.protocol === 'file:';
      return url.host === '' || isLocalFile
        ? lastSegment(decodeURIComponent(url.pathname))
        : url.host;
    } catch {
      return content.url;
    }
  }
  return FALLBACK_TITLES[content.type];
}
