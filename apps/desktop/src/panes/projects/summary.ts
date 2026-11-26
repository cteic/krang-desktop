import type { Issue } from './issues';

/** Where an issue sits, coarser than its status. */
export const STAGES = ['active', 'ready', 'backlog', 'closed'] as const;

export type Stage = (typeof STAGES)[number];

const STAGE_OF_STATUS = new Map<string, Stage>([
  ['in_progress', 'active'],
  ['in_review', 'active'],
  ['todo', 'ready'],
  ['backlog', 'backlog'],
  ['done', 'closed'],
  ['cancelled', 'closed'],
]);

/** A status krang adds later counts as open work waiting to start. */
export function stageOf(status: string): Stage {
  return STAGE_OF_STATUS.get(status) ?? 'backlog';
}

const PRIORITY_RANK = new Map<string, number>([
  ['urgent', 0],
  ['high', 1],
  ['medium', 2],
  ['low', 3],
  ['none', 4],
]);

function priorityRank(priority: string): number {
  return PRIORITY_RANK.get(priority) ?? PRIORITY_RANK.size;
}

/** The label for issues that belong to no project. */
export const NO_PROJECT = 'No project';

/** How many open issues a project shows before the rest are left out. */
export const NEXT_LIMIT = 5;

export interface ProjectSummary {
  name: string;
  total: number;
  counts: Record<Stage, number>;
  /** Open issues waiting on another issue that is still open. */
  blocked: number;
  urgent: number;
  /** The open issues to look at first: active, then ready, then backlog. */
  next: Issue[];
  /** The latest `updated` time of any issue in the project. */
  updated: string;
}

function isOpen(issue: Issue): boolean {
  return stageOf(issue.status) !== 'closed';
}

function byNext(a: Issue, b: Issue): number {
  const stage = STAGES.indexOf(stageOf(a.status)) - STAGES.indexOf(stageOf(b.status));
  if (stage !== 0) {
    return stage;
  }
  const priority = priorityRank(a.priority) - priorityRank(b.priority);
  if (priority !== 0) {
    return priority;
  }
  return a.id.localeCompare(b.id, 'en', { numeric: true });
}

function summarise(name: string, issues: Issue[], openIds: ReadonlySet<string>): ProjectSummary {
  const counts: Record<Stage, number> = { active: 0, ready: 0, backlog: 0, closed: 0 };
  let updated = '';
  for (const issue of issues) {
    counts[stageOf(issue.status)] += 1;
    if (issue.updated > updated) {
      updated = issue.updated;
    }
  }
  const open = issues.filter(isOpen);
  return {
    name,
    total: issues.length,
    counts,
    blocked: open.filter((issue) => issue.blocked_by.some((id) => openIds.has(id))).length,
    urgent: open.filter((issue) => issue.priority === 'urgent').length,
    next: [...open].sort(byNext).slice(0, NEXT_LIMIT),
    updated,
  };
}

function openCount(summary: ProjectSummary): number {
  return summary.total - summary.counts.closed;
}

/**
 * Projects with work in hand come first, then those with urgent work, then
 * by how much is open. A project with nothing open goes last.
 */
function byAttention(a: ProjectSummary, b: ProjectSummary): number {
  return (
    b.counts.active - a.counts.active ||
    b.urgent - a.urgent ||
    openCount(b) - openCount(a) ||
    a.name.localeCompare(b.name)
  );
}

/** Groups issues by project and orders the projects by what needs attention. */
export function summariseProjects(issues: readonly Issue[]): ProjectSummary[] {
  const openIds = new Set(issues.filter(isOpen).map((issue) => issue.id));
  const groups = new Map<string, Issue[]>();
  for (const issue of issues) {
    const name = issue.project ?? NO_PROJECT;
    const group = groups.get(name);
    if (group === undefined) {
      groups.set(name, [issue]);
    } else {
      group.push(issue);
    }
  }
  return [...groups].map(([name, group]) => summarise(name, group, openIds)).sort(byAttention);
}

/** Totals across every project, for the pane's header. */
export function totalsOf(projects: readonly ProjectSummary[]): Record<Stage, number> {
  const totals: Record<Stage, number> = { active: 0, ready: 0, backlog: 0, closed: 0 };
  for (const project of projects) {
    for (const stage of STAGES) {
      totals[stage] += project.counts[stage];
    }
  }
  return totals;
}
