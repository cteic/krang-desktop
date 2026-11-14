// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

describe('adding a pane', () => {
  it('opens a graph pane beside the focused one', () => {
    render(<Harness />);
    expect(screen.queryByText('graph')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '+ Graph' }));
    // A graph pane with no vault yet is named after its type.
    expect(screen.getByText('graph')).toBeTruthy();
    expect(screen.getByText('from the layout')).toBeTruthy();
  });
});
