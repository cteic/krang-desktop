import { useEffect } from 'react';
import type { Dispatch } from 'react';

import type { Workspace } from '../workspace/model';
import type { WorkspaceAction } from '../workspace/reducer';

/**
 * Applies requests that arrive from outside the window, such as the
 * command-line tool run inside a pane. Not wired up yet: this is the seam.
 */
export function useIpcRequests(
  dispatch: Dispatch<WorkspaceAction>,
  getWorkspace: () => Workspace,
): void {
  useEffect(() => {
    // Nothing listens yet.
  }, [dispatch, getWorkspace]);
}
