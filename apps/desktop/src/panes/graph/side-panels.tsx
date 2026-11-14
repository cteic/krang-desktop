import { useState } from 'react';
import type { KeyboardEvent } from 'react';

import { noteName } from './candidates';
import type { CandidateGroup } from './candidates';
import type { IssueGroup } from './issues';
import { lensSummary } from './lens';
import type { Backer, ClaimRow, Lens, ListedNote } from './lens';

/** The lists that open beside the drawing: claims, candidates and issues. */

export interface TypeLook {
  fill: string;
  ink: string;
  /** The type's short name, such as `CLM`. */
  chip: string;
  /** A title of this type without its short name in front. */
  strip: (title: string) => string;
}

function openOnEnter(event: KeyboardEvent<HTMLButtonElement>, open: () => void) {
  if (event.key === 'Enter') {
    event.preventDefault();
    open();
  }
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

interface BarProps {
  count: number;
  side: 'for' | 'against';
}

/** A count drawn as a short bar that grows with it, up to a point. */
function Bar({ count, side }: BarProps) {
  return (
    <span className="graph-bar" data-side={side} data-empty={count === 0}>
      <span className="graph-bar-fill" style={{ width: `${String(Math.min(count, 5) * 5)}px` }} />
      {count}
    </span>
  );
}

function isListedNote(backer: Backer | ListedNote): backer is ListedNote {
  return 'kind' in backer;
}

interface BackersProps {
  title: string;
  side: 'for' | 'against' | 'tentative' | 'related';
  /** A line shown above the list, for the lists the counts leave out. */
  heading?: string;
  backers: readonly (Backer | ListedNote)[];
  onSelect: (id: string) => void;
  onOpen: (path: string) => void;
}

function Backers({ title, side, heading, backers, onSelect, onOpen }: BackersProps) {
  if (backers.length === 0) {
    return null;
  }
  return (
    <>
      {heading === undefined ? null : <p className="graph-backers-head">{heading}</p>}
      <ul className="graph-backers" aria-label={title} data-side={side}>
        {backers.map((backer) => (
          <BackerItem
            key={isListedNote(backer) ? `${backer.kind} ${backer.id}` : backer.id}
            backer={backer}
            onSelect={onSelect}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </>
  );
}

interface BackerItemProps {
  backer: Backer | ListedNote;
  onSelect: (id: string) => void;
  onOpen: (path: string) => void;
}

function BackerItem({ backer, onSelect, onOpen }: BackerItemProps) {
  return (
    <li>
      <button
        type="button"
        title={`${backer.title}\nClick to find it in the graph. Double-click or Enter opens the note.`}
        onClick={() => {
          onSelect(backer.id);
        }}
        onDoubleClick={() => {
          onOpen(backer.path);
        }}
        onKeyDown={(event) => {
          openOnEnter(event, () => {
            onOpen(backer.path);
          });
        }}
      >
        {isListedNote(backer) ? (
          <span className="graph-backer-kind" data-kind={backer.kind}>
            {backer.kind}:{' '}
          </span>
        ) : null}
        {backer.title}
      </button>
    </li>
  );
}

export interface ClaimsPanelProps {
  lens: Lens;
  looks: ReadonlyMap<string, TypeLook>;
  /** The id of the selected node, when it is one of the claims. */
  selectedId: string | null;
  /** Selects a node and brings it to the middle of the drawing. */
  onSelect: (id: string) => void;
  onOpen: (path: string) => void;
}

/** Every claim, hypothesis and conclusion, with what backs it and what opposes it. */
export function ClaimsPanel({ lens, looks, selectedId, onSelect, onOpen }: ClaimsPanelProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  }

  function row(claim: ClaimRow) {
    const look = looks.get(claim.typeId);
    const open = expanded.has(claim.id);
    const backed =
      claim.supports.length + claim.opposes.length + claim.tentative.length + claim.related.length >
      0;
    const status = claim.status ?? 'not counted';
    return (
      <li key={claim.id} className="graph-claim" data-status={claim.status ?? undefined}>
        <div className="graph-claim-row">
          <button
            type="button"
            className="graph-claim-more"
            aria-expanded={open}
            aria-label={`Evidence for ${claim.title}`}
            title={
              backed ? 'Show what supports or opposes this' : 'Nothing supports or opposes this'
            }
            disabled={!backed}
            onClick={() => {
              toggle(claim.id);
            }}
          >
            {open ? '▾' : '▸'}
          </button>
          <button
            type="button"
            className="graph-claim-main"
            aria-pressed={claim.id === selectedId}
            aria-label={`${claim.title}, ${status}, ${String(claim.supports.length)} supporting, ${String(claim.opposes.length)} opposing`}
            title={`${claim.title}\nClick to find it in the graph. Double-click or Enter opens the note.`}
            onClick={() => {
              onSelect(claim.id);
            }}
            onDoubleClick={() => {
              onOpen(claim.path);
            }}
            onKeyDown={(event) => {
              openOnEnter(event, () => {
                onOpen(claim.path);
              });
            }}
          >
            <span className="graph-mark" data-status={claim.status ?? undefined} />
            <span
              className="graph-type-chip"
              style={{ background: look?.fill, color: look?.ink }}
              title={claim.typeName}
            >
              {look?.chip ?? claim.typeName}
            </span>
            <span className="graph-claim-title">{look?.strip(claim.title) ?? claim.title}</span>
            <Bar count={claim.supports.length} side="for" />
            <Bar count={claim.opposes.length} side="against" />
          </button>
        </div>
        {open ? (
          <div className="graph-claim-evidence">
            <Backers
              title={`Supports ${claim.title}`}
              side="for"
              backers={claim.supports}
              onSelect={onSelect}
              onOpen={onOpen}
            />
            <Backers
              title={`Opposes ${claim.title}`}
              side="against"
              backers={claim.opposes}
              onSelect={onSelect}
              onOpen={onOpen}
            />
            <Backers
              title={`Tentative evidence for ${claim.title}`}
              side="tentative"
              heading="Tentative, not counted"
              backers={claim.tentative}
              onSelect={onSelect}
              onOpen={onOpen}
            />
            <Backers
              title={`Related claims for ${claim.title}`}
              side="related"
              heading="Related claims, not counted"
              backers={claim.related}
              onSelect={onSelect}
              onOpen={onOpen}
            />
          </div>
        ) : null}
      </li>
    );
  }

  return (
    <section className="graph-panel" aria-label="Claims">
      <p className="graph-panel-head">{lensSummary(lens)}</p>
      <ul className="graph-panel-list">{lens.rows.map(row)}</ul>
    </section>
  );
}

export interface CandidatesPanelProps {
  groups: readonly CandidateGroup[];
  onOpen: (path: string) => void;
}

/** The lines marked as candidates for a node, by node type. */
export function CandidatesPanel({ groups, onOpen }: CandidatesPanelProps) {
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  return (
    <section className="graph-panel" aria-label="Candidates">
      <p className="graph-panel-head">
        {total === 0
          ? 'No lines in this vault carry a candidate tag.'
          : `${plural(total, 'candidate', 'candidates')}: lines tagged to become nodes`}
      </p>
      {groups.map((group) => (
        <div key={group.typeId} className="graph-panel-group">
          <h3>
            <span className="graph-swatch" style={{ background: group.fill }} />
            {group.name}
            <span className="graph-legend-count">{group.items.length}</span>
            <span className="graph-panel-tag">#{group.tag}</span>
          </h3>
          <ul className="graph-panel-list">
            {group.items.map((item) => (
              <li key={`${item.path}:${String(item.line)}`}>
                <button
                  type="button"
                  className="graph-candidate"
                  title={`${item.text}\n${item.path}, line ${String(item.line)}`}
                  onClick={() => {
                    onOpen(item.path);
                  }}
                >
                  <span className="graph-candidate-text">{item.text}</span>
                  <span className="graph-candidate-where">
                    {noteName(item.path)}, line {item.line}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

export interface IssuesPanelProps {
  groups: readonly IssueGroup[];
  onOpen: (path: string) => void;
}

/** What was left out of the picture or may be drawn wrong. */
export function IssuesPanel({ groups, onOpen }: IssuesPanelProps) {
  return (
    <section className="graph-panel" aria-label="Issues">
      {groups.length === 0 ? (
        <p className="graph-panel-head">Nothing was left out and nothing looks wrong.</p>
      ) : null}
      {groups.map((group) => (
        <div key={group.kind} className="graph-panel-group">
          <h3>
            {group.title}
            <span className="graph-legend-count">{group.rows.length}</span>
          </h3>
          <ul className="graph-panel-list">
            {group.rows.map((issue) => (
              <li key={issue.key}>
                {issue.path === null ? (
                  <span className="graph-issue">{issue.text}</span>
                ) : (
                  <button
                    type="button"
                    className="graph-issue"
                    title={`${issue.text}\nClick to open the note.`}
                    onClick={() => {
                      if (issue.path !== null) {
                        onOpen(issue.path);
                      }
                    }}
                  >
                    {issue.text}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
