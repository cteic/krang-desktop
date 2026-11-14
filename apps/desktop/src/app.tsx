import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { useIpcRequests } from './ipc/use-ipc-requests';
import { toSession } from './startup';
import type { Session } from './startup';
import { actionForMenu, isMenuAction } from './workspace/menu-actions';
import { activeTab } from './workspace/model';
import type { Workspace } from './workspace/model';
import { createWorkspace, workspaceReducer } from './workspace/reducer';
import { WorkspaceView } from './workspace-view';

const MENU_EVENT = 'menu-action';

export function App() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<unknown>('startup')
      .then((reply) => {
        if (!cancelled) {
          setSession(toSession(reply));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSession(toSession({ layout: null, layoutError: String(error), debug: false }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (session === null) {
    return null;
  }
  return <Window session={session} />;
}

interface WindowProps {
  session: Session;
}

function Window({ session }: WindowProps) {
  const [workspace, dispatch] = useReducer(workspaceReducer, session.layout, createWorkspace);
  const workspaceRef = useRef<Workspace>(workspace);
  workspaceRef.current = workspace;

  const title = activeTab(workspace)?.title ?? '';
  useEffect(() => {
    getCurrentWebviewWindow()
      .setTitle(title)
      .catch((error: unknown) => {
        console.error('[app] set title', error);
      });
  }, [title]);

  useEffect(() => {
    const unlisten = getCurrentWebviewWindow().listen<unknown>(MENU_EVENT, (event) => {
      if (!isMenuAction(event.payload)) {
        return;
      }
      const action = actionForMenu(event.payload, workspaceRef.current);
      if (action !== null) {
        dispatch(action);
      }
    });
    return () => {
      unlisten
        .then((stop) => {
          stop();
        })
        .catch((error: unknown) => {
          console.error('[app] unlisten', error);
        });
    };
  }, []);

  const getWorkspace = useCallback(() => workspaceRef.current, []);
  useIpcRequests(dispatch, getWorkspace);

  return (
    <div className="window">
      {session.problem === null ? null : (
        <div className="problem" role="alert">
          Layout not loaded. {session.problem}
        </div>
      )}
      <WorkspaceView workspace={workspace} dispatch={dispatch} debug={session.debug} />
    </div>
  );
}
