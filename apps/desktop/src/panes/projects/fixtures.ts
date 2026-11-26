import type { Issue } from './issues';

/** An issue with every field the pane reads, overridable per test. */
export function issue(overrides: Partial<Issue> & Pick<Issue, 'id'>): Issue {
  return {
    title: `Title of ${overrides.id}`,
    status: 'todo',
    project: 'alpha',
    priority: 'medium',
    blocked_by: [],
    claimed_by: null,
    updated: '2026-11-01T10:00:00.000Z',
    ...overrides,
  };
}

/** Two projects, one with work in hand, plus one finished and one loose issue. */
export const ISSUES: Issue[] = [
  issue({ id: 'CTE-1', project: 'alpha', status: 'in_progress', priority: 'high' }),
  issue({ id: 'CTE-2', project: 'alpha', status: 'todo', priority: 'urgent' }),
  issue({ id: 'CTE-3', project: 'alpha', status: 'backlog', blocked_by: ['CTE-1'] }),
  issue({ id: 'CTE-4', project: 'alpha', status: 'done', updated: '2026-11-20T09:00:00.000Z' }),
  issue({ id: 'CTE-5', project: 'beta', status: 'backlog', priority: 'low' }),
  issue({ id: 'CTE-6', project: 'beta', status: 'todo', blocked_by: ['CTE-4'] }),
  issue({ id: 'CTE-7', project: 'gamma', status: 'done' }),
  issue({ id: 'CTE-8', project: null, status: 'todo' }),
];
