import { activeTab, findLeaf } from './model';
import type { PaneContent, Workspace } from './model';
import { DEFAULT_CONTENT, defaultDraft } from './reducer';
import type { WorkspaceAction } from './reducer';

/** Menu item ids. The Rust shell sends one of these when an item is chosen. */
export const MENU_ACTIONS = [
  'new-tab',
  'close-tab',
  'next-tab',
  'previous-tab',
  'split-right',
  'split-down',
  'close-pane',
  'magnify-pane',
  'next-pane',
  'previous-pane',
] as const;

export type MenuAction = (typeof MENU_ACTIONS)[number];

export function isMenuAction(value: unknown): value is MenuAction {
  return typeof value === 'string' && MENU_ACTIONS.some((action) => action === value);
}

/**
 * What a split shows. A terminal splits into another terminal in the same
 * directory, without rerunning the first one's startup commands. Anything
 * else splits into a plain terminal.
 */
export function contentForSplit(source: PaneContent | null): PaneContent {
  if (source?.type === 'terminal') {
    return { type: 'terminal', directory: source.directory, commands: [] };
  }
  return DEFAULT_CONTENT;
}

/** Turns a menu choice into a workspace change. Null when there is nothing to do. */
export function actionForMenu(menu: MenuAction, workspace: Workspace): WorkspaceAction | null {
  const tab = activeTab(workspace);
  switch (menu) {
    case 'new-tab':
      return { type: 'add-tab', draft: defaultDraft() };
    case 'next-tab':
      return { type: 'activate-next-tab', offset: 1 };
    case 'previous-tab':
      return { type: 'activate-next-tab', offset: -1 };
    case 'next-pane':
      return { type: 'focus-next', offset: 1 };
    case 'previous-pane':
      return { type: 'focus-next', offset: -1 };
    default:
      break;
  }
  if (tab === null) {
    return null;
  }
  const paneId = tab.focusedId;
  switch (menu) {
    case 'close-tab':
      return { type: 'close-tab', tabId: tab.id };
    case 'close-pane':
      return { type: 'close', paneId };
    case 'magnify-pane':
      return { type: 'toggle-magnify', paneId };
    case 'split-right':
    case 'split-down': {
      const source = findLeaf(tab.root, paneId)?.content ?? null;
      return {
        type: 'split',
        paneId,
        direction: menu === 'split-right' ? 'row' : 'column',
        content: contentForSplit(source),
      };
    }
    default:
      return null;
  }
}
