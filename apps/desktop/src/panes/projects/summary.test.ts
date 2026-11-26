import { describe, expect, it } from 'vitest';

import { issue, ISSUES } from './fixtures';
import { NEXT_LIMIT, NO_PROJECT, stageOf, summariseProjects, totalsOf } from './summary';

describe('stageOf', () => {
  it('groups statuses into stages', () => {
    expect(stageOf('in_progress')).toBe('active');
    expect(stageOf('in_review')).toBe('active');
    expect(stageOf('todo')).toBe('ready');
    expect(stageOf('backlog')).toBe('backlog');
    expect(stageOf('done')).toBe('closed');
    expect(stageOf('cancelled')).toBe('closed');
  });

  it('treats a status it does not know as open work', () => {
    expect(stageOf('triage')).toBe('backlog');
  });
});

describe('summariseProjects', () => {
  const projects = summariseProjects(ISSUES);

  it('puts the project with work in hand first and the finished one last', () => {
    expect(projects.map((project) => project.name)).toEqual(['alpha', 'beta', NO_PROJECT, 'gamma']);
  });

  it('counts each stage of a project', () => {
    expect(projects[0]?.counts).toEqual({ active: 1, ready: 1, backlog: 1, closed: 1 });
    expect(projects[0]?.total).toBe(4);
    expect(projects[0]?.urgent).toBe(1);
  });

  it('counts an issue as blocked only while its blocker is open', () => {
    const alpha = projects.find((project) => project.name === 'alpha');
    const beta = projects.find((project) => project.name === 'beta');
    expect(alpha?.blocked).toBe(1);
    expect(beta?.blocked).toBe(0);
  });

  it('lists the next issues by stage, then priority, leaving out closed ones', () => {
    expect(projects[0]?.next.map((next) => next.id)).toEqual(['CTE-1', 'CTE-2', 'CTE-3']);
    expect(projects[1]?.next.map((next) => next.id)).toEqual(['CTE-6', 'CTE-5']);
  });

  it('keeps the latest change time of a project', () => {
    expect(projects[0]?.updated).toBe('2026-11-20T09:00:00.000Z');
  });

  it('shows at most a few next issues', () => {
    const many = Array.from({ length: NEXT_LIMIT + 3 }, (_, index) =>
      issue({ id: `CTE-${String(index + 1)}` }),
    );
    expect(summariseProjects(many)[0]?.next).toHaveLength(NEXT_LIMIT);
  });

  it('orders issue ids by number, not as text', () => {
    const ids = summariseProjects([issue({ id: 'CTE-10' }), issue({ id: 'CTE-9' })])[0]?.next;
    expect(ids?.map((next) => next.id)).toEqual(['CTE-9', 'CTE-10']);
  });
});

describe('totalsOf', () => {
  it('adds up every project', () => {
    expect(totalsOf(summariseProjects(ISSUES))).toEqual({
      active: 1,
      ready: 3,
      backlog: 2,
      closed: 2,
    });
  });
});
