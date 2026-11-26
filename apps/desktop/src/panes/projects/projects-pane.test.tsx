// @vitest-environment jsdom
import { invoke } from '@tauri-apps/api/core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaneActions } from '../pane-props';

import { ISSUES } from './fixtures';
import { ProjectsPane } from './projects-pane';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

let reply: () => Promise<unknown>;

function makeActions(): PaneActions {
  return {
    openPane: vi.fn(),
    replaceContent: vi.fn(),
    setTitle: vi.fn(),
    setBadge: vi.fn(),
    close: vi.fn(),
  };
}

function renderPane(actions: PaneActions = makeActions()) {
  render(
    <ProjectsPane
      paneId="p1"
      name="projects"
      content={{ type: 'projects' }}
      active
      debug={false}
      actions={actions}
    />,
  );
  return actions;
}

beforeEach(() => {
  reply = () => Promise.resolve(JSON.stringify(ISSUES));
  vi.mocked(invoke).mockImplementation(() => reply());
});

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

describe('ProjectsPane', () => {
  it('lists the projects with open work, busiest first', async () => {
    renderPane();
    await screen.findByText('alpha');
    const list = screen.getByRole('list', { name: 'Projects' });
    const rows = within(list).getAllByRole('button', { expanded: false });
    expect(rows.map((row) => row.querySelector('.projects-name')?.textContent)).toEqual([
      'alpha',
      'beta',
      'No project',
    ]);
    expect(invoke).toHaveBeenCalledWith('projects_read');
  });

  it('shows a finished project once asked to', async () => {
    renderPane();
    await screen.findByText('alpha');
    expect(screen.queryByText('gamma')).toBeNull();
    fireEvent.click(screen.getByLabelText('finished projects'));
    expect(screen.getByText('gamma')).toBeTruthy();
  });

  it('opens a project to show its next issues, and an issue in an editor pane', async () => {
    const actions = renderPane();
    fireEvent.click(await screen.findByText('alpha'));
    fireEvent.click(screen.getByText('Title of CTE-2'));
    expect(actions.openPane).toHaveBeenCalledWith({
      type: 'editor',
      path: '~/.krang/work/issues/CTE-2.md',
      mode: 'preview',
    });
  });

  it('says what went wrong when krang cannot be read', async () => {
    reply = () => Promise.reject('krang is not installed: no `krang` on the usual paths');
    renderPane();
    expect((await screen.findByRole('alert')).textContent).toContain('krang is not installed');
  });

  it('keeps the last good list when a later read fails', async () => {
    renderPane();
    await screen.findByText('alpha');
    reply = () => Promise.resolve('not json');
    fireEvent.click(screen.getByText('Refresh'));
    expect((await screen.findByRole('alert')).textContent).toContain('not JSON');
    expect(screen.getByText('alpha')).toBeTruthy();
  });
});
