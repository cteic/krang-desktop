import { LayoutError, parseLayout } from '../layout/layout';
import { leavesOf, paneTitle } from '../workspace/model';
import type { PaneContent, PaneType, Workspace } from '../workspace/model';
import { hasPane } from '../workspace/reducer';
import type { WorkspaceAction } from '../workspace/reducer';

import { requestSchema } from './request';
import type { IpcCommand, IpcRequest } from './request';

export interface PaneSummary {
  id: string;
  title: string;
  type: PaneType;
  /** True for the one pane that holds the keyboard in this window. */
  focused: boolean;
}

export interface TabSummary {
  id: string;
  title: string;
  active: boolean;
  panes: PaneSummary[];
}

export interface PanesReply {
  tabs: TabSummary[];
}

export interface Accepted {
  ok: true;
  actions: WorkspaceAction[];
  /** What the tool prints. Null when the command has nothing to say. */
  data: PanesReply | null;
}

export interface Refused {
  ok: false;
  error: string;
}

export type Outcome = Accepted | Refused;

/** The answer sent back to the tool: `{ ok, error?, data? }`. */
export interface Reply {
  ok: boolean;
  error?: string;
  data?: PanesReply;
}

/**
 * The address a web pane uses to show a file from disk. Slashes are kept so
 * the page's relative links to its own styles and images still resolve.
 */
export function localFileUrl(path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `localfile://localhost${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}

export function panesReply(workspace: Workspace): PanesReply {
  return {
    tabs: workspace.tabs.map((tab) => {
      const active = tab.id === workspace.activeTabId;
      return {
        id: tab.id,
        title: tab.title,
        active,
        panes: leavesOf(tab.root).map((leaf) => ({
          id: leaf.id,
          title: paneTitle(leaf),
          type: leaf.content.type,
          focused: active && leaf.id === tab.focusedId,
        })),
      };
    }),
  };
}

function accept(actions: WorkspaceAction[], data: PanesReply | null = null): Accepted {
  return { ok: true, actions, data };
}

function refuse(error: string): Refused {
  return { ok: false, error };
}

function split(request: IpcRequest, direction: 'row' | 'column', content: PaneContent): Accepted {
  return accept([{ type: 'split', paneId: request.pane, direction, content }]);
}

function outcomeFor(request: IpcRequest, command: IpcCommand, workspace: Workspace): Outcome {
  const paneId = request.pane;
  switch (command.name) {
    case 'view':
      return split(
        request,
        command.direction,
        command.kind === 'directory'
          ? { type: 'files', directory: command.path }
          : { type: 'editor', path: command.path },
      );
    case 'web':
      return split(request, command.direction, {
        type: 'web',
        url: 'url' in command.target ? command.target.url : localFileUrl(command.target.path),
      });
    case 'term':
      return split(request, 'row', {
        type: 'terminal',
        directory: command.directory,
        commands: command.command === null ? [] : [command.command],
      });
    case 'chat':
      return split(request, 'row', {
        type: 'chat',
        agent: command.agent,
        directory: command.directory,
      });
    case 'title':
      return accept([{ type: 'set-title', paneId, title: command.title }]);
    case 'badge':
      return accept([{ type: 'set-badge', paneId, badge: command.badge }]);
    case 'layout':
      try {
        return accept([{ type: 'add-tab', draft: parseLayout(command.text) }]);
      } catch (error) {
        if (error instanceof LayoutError) {
          return refuse(`could not load ${command.path}: ${error.message}`);
        }
        throw error;
      }
    case 'panes':
      return accept([], panesReply(workspace));
  }
}

/**
 * Turns a request from the command-line tool into workspace changes, or
 * into the reason it cannot be done. Pure: it reads the workspace and
 * dispatches nothing.
 */
export function actionsForRequest(payload: unknown, workspace: Workspace): Outcome {
  const result = requestSchema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue === undefined ? '' : `: ${issue.path.join('.')}: ${issue.message}`;
    return refuse(`the app could not read the request${where}`);
  }
  const request = result.data;
  if (!hasPane(workspace, request.pane)) {
    return refuse(`no pane with id ${request.pane} in this window`);
  }
  return outcomeFor(request, request.command, workspace);
}

export function replyFor(outcome: Outcome): Reply {
  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }
  return outcome.data === null ? { ok: true } : { ok: true, data: outcome.data };
}
