import { describe, expect, it } from 'vitest';

import { debugText } from './debug-text';
import { GRAPH } from './fixtures';
import { ALL_VIEW, buildView, withoutTypes } from './view-model';

describe('debugText', () => {
  it('gives the vault, the view, the counts and the node titles', () => {
    expect(debugText('/vault', buildView(GRAPH, ALL_VIEW))).toBe(
      [
        '/vault',
        'view: All nodes',
        'nodes: 5',
        'relations: 3',
        'skipped: 2',
        '- QUE - Does it scale',
        '- CLM - It scales',
        '- CLM - It does not',
        '- EVD - Benchmark run',
        '- CLM - Alone',
        '',
      ].join('\n'),
    );
  });

  it('lists only what is on show', () => {
    const view = withoutTypes(buildView(GRAPH, 'Overview'), new Set(['node_c']));
    expect(debugText('/vault', view)).toBe(
      '/vault\nview: Overview / Main\nnodes: 1\nrelations: 0\nskipped: 1\n- QUE - Does it scale\n',
    );
  });

  it('says when support could not be counted, and gives no counts for it', () => {
    const text = debugText('/vault', buildView(GRAPH, 'Overview'), null, {
      unlinkedHidden: 0,
      claims: 3,
      supportCounted: false,
      unsupported: 0,
      opposed: 0,
      contested: 0,
      supported: 0,
      candidates: 0,
      issues: 0,
    });
    expect(text.split('\n')).toContain('claims: 3 (support not counted)');
  });

  it('adds what the lists beside the drawing hold', () => {
    const text = debugText('/vault', buildView(GRAPH, 'Overview'), null, {
      unlinkedHidden: 1,
      claims: 3,
      supportCounted: true,
      unsupported: 2,
      opposed: 1,
      contested: 0,
      supported: 1,
      candidates: 2,
      issues: 6,
    });
    expect(text.split('\n').slice(4, 9)).toEqual([
      'skipped: 1',
      'unlinked hidden: 1',
      'claims: 3 (2 unsupported, 1 opposed, 0 contested, 1 supported)',
      'candidates: 2',
      'issues: 6',
    ]);
  });

  it('reports a problem after the path', () => {
    expect(debugText('/nope', null, '/nope: No such file or directory (os error 2)')).toBe(
      '/nope\n! /nope: No such file or directory (os error 2)\n',
    );
  });
});
