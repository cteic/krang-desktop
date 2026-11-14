import { describe, expect, it } from 'vitest';

import { GRAPH, VAULT } from './fixtures';
import { buildIssues, issueCount } from './issues';
import type { VaultGraph } from './vault-graph';

describe('buildIssues', () => {
  it('lists what the fixture vault leaves out or may draw wrong, by kind', () => {
    const groups = buildIssues(GRAPH);
    expect(groups.map((group) => [group.title, group.rows.map((row) => row.text)])).toEqual([
      [
        'Relations left out',
        [
          'Relation r8: supports, from "CLM - It scales" to unknown id id-gone',
          'Relation r9: supports, from "CLM - It scales" to nothing',
        ],
      ],
      [
        'Relations that may be drawn to the wrong note',
        ['supports: "EVD - Benchmark run" to "CLM - It scales"'],
      ],
      ['Canvas boxes whose note is missing', ['"CLM - Deleted since" on Overview / Detail']],
      [
        'Canvas shapes not drawn',
        [
          'Overview: 1 arrow is not attached to a box at both ends',
          'Overview: 2 other shapes are not drawn',
        ],
      ],
    ]);
    expect(issueCount(groups)).toBe(6);
  });

  it('gives a row its note when it is about one', () => {
    const graph: VaultGraph = {
      ...GRAPH,
      nodes: [
        ...GRAPH.nodes,
        { id: 'id-c1#2', typeId: 'node_c', title: 'CLM - Copy', path: `${VAULT}/CLM - Copy.md` },
      ],
      issues: [
        {
          kind: 'sharedId',
          text: '"CLM - Copy" carries the same instance id as "CLM - It scales"',
          path: `${VAULT}/CLM - Copy.md`,
        },
        { kind: 'file', text: 'relations.json is not valid JSON (line 1, column 2)', path: null },
        { kind: 'someday', text: 'a kind this pane has not heard of', path: null },
      ],
      canvases: [],
    };
    const groups = buildIssues(graph);
    expect(groups.map((group) => group.title)).toEqual([
      'Files that could not be read',
      'Notes that share an instance id',
      'Relations that may be drawn to the wrong note',
      'Other',
    ]);
    expect(groups[1]?.rows[0]?.path).toBe(`${VAULT}/CLM - Copy.md`);
    // The relation's shared end is the claim, so that is the note to look at.
    expect(groups[2]?.rows[0]?.path).toBe(`${VAULT}/claims/CLM - It scales.md`);
  });

  it('is empty for a vault with nothing wrong', () => {
    const clean: VaultGraph = {
      ...GRAPH,
      relations: GRAPH.relations.slice(0, 2),
      issues: [],
      canvases: [],
    };
    expect(buildIssues(clean)).toEqual([]);
    expect(issueCount([])).toBe(0);
  });
});
