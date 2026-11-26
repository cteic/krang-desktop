import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ProjectsContent } from '../../workspace/model';
import { useDebugSnapshot } from '../debug-snapshot';
import type { PaneProps } from '../pane-props';

import { errorText, fetchIssues } from './issues';
import type { Issue } from './issues';
import './projects-pane.css';
import { stageOf, STAGES, summariseProjects, totalsOf } from './summary';
import type { ProjectSummary, Stage } from './summary';

/** How often the pane reads the work store again. */
const POLL_MS = 30_000;

/** Where krang keeps one file per issue. */
const ISSUE_DIR = '~/.krang/work/issues';

const STAGE_LABEL: Record<Stage, string> = {
  active: 'active',
  ready: 'ready',
  backlog: 'backlog',
  closed: 'closed',
};

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; issues: Issue[]; readAt: Date }
  | { kind: 'failed'; message: string; issues: Issue[] | null };

function timeText(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dateText(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

interface StageBarProps {
  counts: Record<Stage, number>;
  total: number;
}

function StageBar({ counts, total }: StageBarProps) {
  return (
    <div className="projects-bar" aria-hidden="true">
      {STAGES.map((stage) =>
        counts[stage] === 0 ? null : (
          <span
            key={stage}
            className={`projects-bar-${stage}`}
            style={{ flexGrow: counts[stage] / Math.max(total, 1) }}
          />
        ),
      )}
    </div>
  );
}

interface ProjectRowProps {
  project: ProjectSummary;
  expanded: boolean;
  onToggle(name: string): void;
  onOpenIssue(id: string): void;
}

function ProjectRow({ project, expanded, onToggle, onOpenIssue }: ProjectRowProps) {
  const open = project.total - project.counts.closed;
  return (
    <li className="projects-row">
      <button
        type="button"
        className="projects-head"
        aria-expanded={expanded}
        onClick={() => {
          onToggle(project.name);
        }}
      >
        <span className="projects-name">{project.name}</span>
        <span className="projects-chips">
          {project.counts.active > 0 && (
            <span className="projects-chip projects-chip-active">
              {project.counts.active} active
            </span>
          )}
          {project.urgent > 0 && (
            <span className="projects-chip projects-chip-urgent">{project.urgent} urgent</span>
          )}
          {project.blocked > 0 && (
            <span className="projects-chip projects-chip-blocked">{project.blocked} blocked</span>
          )}
          <span className="projects-chip">
            {open} open of {project.total}
          </span>
        </span>
        <StageBar counts={project.counts} total={project.total} />
      </button>
      {expanded && (
        <div className="projects-detail">
          {project.next.length === 0 ? (
            <p className="projects-empty">Nothing open.</p>
          ) : (
            <ul className="projects-issues">
              {project.next.map((issue) => (
                <li key={issue.id}>
                  <button
                    type="button"
                    className="projects-issue"
                    title={`Open ${issue.id} in an editor pane`}
                    onClick={() => {
                      onOpenIssue(issue.id);
                    }}
                  >
                    <span className="projects-issue-id">{issue.id}</span>
                    <span className="projects-issue-title">{issue.title}</span>
                    <span className={`projects-stage projects-stage-${stageOf(issue.status)}`}>
                      {issue.status.replace('_', ' ')}
                    </span>
                    <span className="projects-priority">{issue.priority}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="projects-updated">Last change {dateText(project.updated)}</p>
        </div>
      )}
    </li>
  );
}

/**
 * Every krang project at a glance: how much is active, ready, waiting and
 * closed, what is blocked, and the next few issues of each. It reads the
 * work store through `krang issue ls` and changes nothing.
 */
export function ProjectsPane({ name, debug, actions }: PaneProps<ProjectsContent>) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [showClosed, setShowClosed] = useState(false);

  const refresh = useCallback(() => {
    fetchIssues().then(
      (issues) => {
        setLoad({ kind: 'ready', issues, readAt: new Date() });
      },
      (error: unknown) => {
        setLoad((previous) => ({
          kind: 'failed',
          message: errorText(error),
          issues: previous.kind === 'loading' ? null : previous.issues,
        }));
      },
    );
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [refresh]);

  const issues = load.kind === 'loading' ? null : load.issues;
  const projects = useMemo(() => (issues === null ? [] : summariseProjects(issues)), [issues]);
  const shown = showClosed
    ? projects
    : projects.filter((project) => project.total > project.counts.closed);
  const totals = totalsOf(projects);

  const toggle = useCallback((project: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(project)) {
        next.delete(project);
      } else {
        next.add(project);
      }
      return next;
    });
  }, []);

  const openIssue = useCallback(
    (id: string) => {
      actions.openPane({ type: 'editor', path: `${ISSUE_DIR}/${id}.md`, mode: 'preview' });
    },
    [actions],
  );

  useDebugSnapshot(name, debug, () =>
    [
      `load: ${load.kind}`,
      `projects: ${String(projects.length)} (${String(shown.length)} shown)`,
      ...STAGES.map((stage) => `${stage}: ${String(totals[stage])}`),
    ].join('\n'),
  );

  return (
    <div className="projects-pane">
      <header className="projects-header">
        <span className="projects-totals">
          {STAGES.map((stage) => (
            <span key={stage} className={`projects-total projects-stage-${stage}`}>
              {totals[stage]} {STAGE_LABEL[stage]}
            </span>
          ))}
        </span>
        <label className="projects-toggle">
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(event) => {
              setShowClosed(event.target.checked);
            }}
          />
          finished projects
        </label>
        {load.kind === 'ready' && (
          <span className="projects-read-at">read {timeText(load.readAt)}</span>
        )}
        <button type="button" className="projects-refresh" onClick={refresh}>
          Refresh
        </button>
      </header>
      {load.kind === 'failed' && (
        <p className="projects-error" role="alert">
          {load.message}
        </p>
      )}
      {load.kind === 'loading' && <p className="projects-empty">Reading the work store…</p>}
      {issues !== null && shown.length === 0 && (
        <p className="projects-empty">No projects with open work.</p>
      )}
      <ul className="projects-list" aria-label="Projects">
        {shown.map((project) => (
          <ProjectRow
            key={project.name}
            project={project}
            expanded={expanded.has(project.name)}
            onToggle={toggle}
            onOpenIssue={openIssue}
          />
        ))}
      </ul>
    </div>
  );
}
