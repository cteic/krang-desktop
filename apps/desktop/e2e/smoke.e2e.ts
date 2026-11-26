import { expect, test } from '@playwright/test';

import { fakeCalls, installFakeShell } from './fake-shell';

/** A layout with one projects pane, as the shell would hand it over. */
const LAYOUT = `
name = "smoke"
[[panes]]
id = "board"
type = "projects"
`;

function issue(id: string, project: string, status: string, priority: string) {
  return {
    id,
    title: `Title of ${id}`,
    status,
    project,
    priority,
    blocked_by: [],
    claimed_by: null,
    updated: '2026-11-20T09:00:00.000Z',
  };
}

const ISSUES = [
  issue('CTE-1', 'alpha', 'in_progress', 'high'),
  issue('CTE-2', 'alpha', 'todo', 'urgent'),
  issue('CTE-3', 'beta', 'backlog', 'low'),
  issue('CTE-4', 'gamma', 'done', 'medium'),
];

test.beforeEach(async ({ page }) => {
  await installFakeShell(page, {
    replies: {
      startup: {
        layout: { path: 'smoke.toml', text: LAYOUT },
        layoutError: null,
        saved: null,
        persist: false,
        debug: false,
      },
      projects_read: JSON.stringify(ISSUES),
      fs_home: '/home/test',
      fs_read_text: { path: '/home/test/.krang/work/issues/CTE-2.md', text: '# CTE-2\n' },
    },
  });
});

test('the window starts and shows the projects pane without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/');

  const projects = page.getByRole('list', { name: 'Projects' });
  await expect(projects.getByText('alpha')).toBeVisible();
  await expect(projects.getByText('beta')).toBeVisible();
  await expect(projects.getByText('gamma')).toHaveCount(0);
  await expect(page.getByText('1 active')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('an issue opens in an editor pane beside the projects pane', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: /alpha/ }).click();
  await page.getByRole('button', { name: /Title of CTE-2/ }).click();

  await expect(page.getByText('CTE-2.md').first()).toBeVisible();
  // The editor expands `~` through fs_home, then reads the file once it has
  // mounted, so wait for the call.
  await expect
    .poll(async () => (await fakeCalls(page)).filter((call) => call.command === 'fs_read_text'))
    .toContainEqual({
      command: 'fs_read_text',
      args: { path: '/home/test/.krang/work/issues/CTE-2.md' },
    });
});
