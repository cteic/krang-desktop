import { describe, expect, it } from 'vitest';

import { GRAPH } from './fixtures';
import { readoutOf, relationsText } from './readout';
import { ALL_VIEW, buildView } from './view-model';

const view = buildView(GRAPH, ALL_VIEW);

describe('relationsText', () => {
  it('says what a node is backed by, and what it backs', () => {
    // The evidence supports it, and it supports the question.
    expect(relationsText(view, 'id-c1')).toBe('supported by 1 · supports 1');
    expect(relationsText(view, 'id-q')).toBe('supported by 1 · opposed by 1');
    expect(relationsText(view, 'id-c2')).toBe('opposes 1');
  });

  it('counts every other kind of relation together, and says when there are none', () => {
    const other = {
      ...GRAPH,
      relations: GRAPH.relations.map((relation) =>
        relation.id === 'r1' ? { ...relation, typeId: 'rel_p' } : relation,
      ),
    };
    expect(relationsText(buildView(other, ALL_VIEW), 'id-q')).toBe('opposed by 1 · 1 other');
    expect(relationsText(view, 'path:/vault/CLM - Alone.md')).toBe('no relations');
  });
});

describe('readoutOf', () => {
  it('gives the whole title with the type and its colour', () => {
    const node = view.nodes.find((item) => item.id === 'id-e');
    expect(node === undefined ? null : readoutOf(view, node, 'Evidence')).toEqual({
      title: 'EVD - Benchmark run',
      typeName: 'Evidence',
      fill: '#8b1a30',
      relations: 'supports 1',
    });
  });
});
