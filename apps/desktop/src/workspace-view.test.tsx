// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { act, useReducer } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PaneActions } from './panes/pane-props';
import { createWorkspace, workspaceReducer } from './workspace/reducer';
import type { TabDraft } from './workspace/reducer';
import { WorkspaceView } from './workspace-view';

const captured: { actions: PaneActions | null } = { actions: null };

vi.mock('./panes/pane-body', () => ({
  PaneBody({ actions }: { actions: PaneActions }) {
    captured.actions = actions;
    return null;
  },
}));

const NOTES: TabDraft = {
  title: 'tab',
  color: null,
  focusedId: 'notes',
  root: {
    kind: 'leaf',
    id: 'notes',
    title: 'from the layout',
    badge: null,
    content: { type: 'editor', path: '/tmp/a.md' },
  },
};

function Harness() {
  const [workspace, dispatch] = useReducer(workspaceReducer, NOTES, createWorkspace);
  return <WorkspaceView workspace={workspace} dispatch={dispatch} debug={false} />;
}

function paneActions(): PaneActions {
  if (captured.actions === null) {
    throw new Error('the pane body was not rendered');
  }
  return captured.actions;
}

afterEach(() => {
  cleanup();
  captured.actions = null;
});

describe('pane titles', () => {
  it('shows the title a layout gave the pane', () => {
    render(<Harness />);
    expect(screen.getByText('from the layout')).toBeTruthy();
  });

  it('goes back to the layout title when a pane clears its own temporary one', () => {
    render(<Harness />);

    act(() => {
      paneActions().setTitle('a.md •');
    });
    expect(screen.getByText('a.md •')).toBeTruthy();

    act(() => {
      paneActions().setTitle('a.md ••');
    });
    act(() => {
      paneActions().setTitle(null);
    });
    expect(screen.getByText('from the layout')).toBeTruthy();
  });

  it('keeps one actions object across title changes, so panes are not restarted', () => {
    render(<Harness />);
    const before = paneActions();
    act(() => {
      before.setTitle('changed');
    });
    expect(paneActions()).toBe(before);
  });
});
