import { describe, expect, it } from 'vitest';

import { GRAPH } from './fixtures';
import { countsText, statusText } from './status';
import { ALL_VIEW, buildView } from './view-model';

const ALL = buildView(GRAPH, ALL_VIEW);

describe('statusText', () => {
  it('says it is loading before there is a graph', () => {
    expect(statusText({ graph: null, loading: true, stale: null })).toBe('Loading...');
    expect(statusText({ graph: null, loading: false, stale: null })).toBe('');
  });

  it('gives a hint when there is nothing to report', () => {
    expect(statusText({ graph: GRAPH, loading: false, stale: null })).toBe(
      'Double-click a node, or press Enter, to open its note.',
    );
  });

  it('leaves a standing warning to the issues list', () => {
    const graph = { ...GRAPH, warnings: ['3 notes share an instance id with an earlier note'] };
    expect(statusText({ graph, loading: false, stale: null })).toBe(
      'Double-click a node, or press Enter, to open its note.',
    );
  });

  it('says what could not be read just now', () => {
    const graph = {
      ...GRAPH,
      incomplete: true,
      warnings: ['relations.json is not valid JSON (line 1, column 2)'],
    };
    expect(statusText({ graph, loading: false, stale: null })).toBe(
      'relations.json is not valid JSON (line 1, column 2)',
    );
  });

  it('says when the graph on screen is an older one', () => {
    expect(
      statusText({
        graph: GRAPH,
        loading: false,
        stale: 'relations.json is not valid JSON (line 3, column 1)',
      }),
    ).toBe(
      'Showing the last graph that read cleanly. relations.json is not valid JSON (line 3, column 1)',
    );
  });
});

describe('countsText', () => {
  it('counts nodes, relations and what was skipped', () => {
    expect(countsText(ALL)).toBe('5 nodes · 3 relations · 2 skipped');
    expect(countsText({ ...ALL, nodes: ALL.nodes.slice(0, 1), edges: ALL.edges.slice(0, 1) })).toBe(
      '1 node · 1 relation · 2 skipped',
    );
  });
});
