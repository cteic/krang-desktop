import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useEffect } from 'react';
import type { Dispatch } from 'react';

import type { Workspace } from '../workspace/model';
import type { WorkspaceAction } from '../workspace/reducer';

import { actionsForRequest, replyFor } from './actions-for-request';
import type { Outcome } from './actions-for-request';
import { REQUEST_EVENT, requestIdOf } from './request';

function outcomeOf(payload: unknown, workspace: Workspace): Outcome {
  try {
    return actionsForRequest(payload, workspace);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Applies requests that arrive from outside the window, such as the
 * command-line tool run inside a pane, and tells the sender how each went.
 */
export function useIpcRequests(
  dispatch: Dispatch<WorkspaceAction>,
  getWorkspace: () => Workspace,
): void {
  useEffect(() => {
    // Listening starts and stops asynchronously. Once the effect is cleaned
    // up, a listener that is still attached must do nothing, or a request
    // could be applied twice.
    let stopped = false;
    const unlisten = getCurrentWebviewWindow().listen<unknown>(REQUEST_EVENT, (event) => {
      if (stopped) {
        return;
      }
      const outcome = outcomeOf(event.payload, getWorkspace());
      if (outcome.ok) {
        outcome.actions.forEach(dispatch);
      }
      const requestId = requestIdOf(event.payload);
      if (requestId === null) {
        console.error('[ipc] request without an id', event.payload);
        return;
      }
      invoke('ipc_reply', { requestId, payload: replyFor(outcome) }).catch((error: unknown) => {
        console.error('[ipc] reply', error);
      });
    });
    return () => {
      stopped = true;
      unlisten
        .then((stop) => {
          stop();
        })
        .catch((error: unknown) => {
          console.error('[ipc] unlisten', error);
        });
    };
  }, [dispatch, getWorkspace]);
}
