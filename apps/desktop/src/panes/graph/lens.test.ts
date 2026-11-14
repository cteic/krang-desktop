import { describe, expect, it } from 'vitest';

import { GRAPH, VAULT } from './fixtures';
import { buildLens, isClaimType, lensSummary, relationReader, relationSense } from './lens';
import type { VaultGraph } from './vault-graph';

function claim(id: string, title: string, typeId = 'node_c') {
  return { id, typeId, title, path: `${VAULT}/${title}.md` };
}

function relation(id: string, typeId: string, source: string, destination: string) {
  return { id, typeId, source, destination, ambiguous: false, tentative: null };
}

describe('isClaimType', () => {
  it('takes claims, hypotheses and conclusions, whatever their capitals', () => {
    expect(['Claim', 'hypothesis', ' CONCLUSION '].map(isClaimType)).toEqual([true, true, true]);
    expect(['Evidence', 'Question', 'Claims', ''].map(isClaimType)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('relationSense', () => {
  it('reads a label either way round, whatever its capitals', () => {
    expect(relationSense('Supports')).toEqual({ kind: 'supports', inverse: false });
    expect(relationSense(' is  supported by ')).toEqual({ kind: 'supports', inverse: true });
    expect(relationSense('OPPOSES')).toEqual({ kind: 'opposes', inverse: false });
    expect(relationSense('Is Opposed By')).toEqual({ kind: 'opposes', inverse: true });
    expect(relationSense('informs')).toEqual({ kind: 'informs', inverse: false });
    expect(relationSense('produces')).toEqual({ kind: 'other', inverse: false });
  });
});

describe('relationReader', () => {
  it('spots a relation stored the other way round from the one the settings allow', () => {
    const backwards = relationReader(GRAPH);
    expect(backwards('rel_s', 'node_e', 'node_c')).toBe(false);
    expect(backwards('rel_s', 'node_c', 'node_e')).toBe(true);
    // Allowed both ways, or not listed at all: taken as stored.
    expect(backwards('rel_s', 'node_q', 'node_q')).toBe(false);
    expect(backwards('rel_p', 'node_c', 'node_e')).toBe(false);
  });
});

describe('buildLens', () => {
  it('counts what supports and opposes each claim in the fixture vault', () => {
    const lens = buildLens(GRAPH);
    expect(lens.rows.map((row) => [row.title, row.status])).toEqual([
      ['CLM - Alone', 'unsupported'],
      ['CLM - It does not', 'unsupported'],
      ['CLM - It scales', 'supported'],
    ]);
    expect(lens.rows[2]?.supports.map((backer) => backer.title)).toEqual(['EVD - Benchmark run']);
    // A question is not a claim, so what backs it is not counted.
    expect(lens.rows.some((row) => row.title.startsWith('QUE'))).toBe(false);
    expect(lensSummary(lens)).toBe('3 claims: 2 unsupported, 0 contested, 1 supported');
  });

  const vault: VaultGraph = {
    ...GRAPH,
    nodeTypes: [
      ...GRAPH.nodeTypes,
      { id: 'node_h', name: 'Hypothesis', format: 'HYP- {content}', color: null, tag: null },
      { id: 'node_n', name: 'Conclusion', format: 'CON - {content}', color: null, tag: null },
    ],
    relationTypes: [
      { id: 'rel_s', label: 'Supports', complement: 'is supported by', color: 'green' },
      { id: 'rel_o', label: 'opposes', complement: 'is opposed by', color: 'red' },
      { id: 'rel_by', label: 'Is supported by', complement: 'supports', color: null },
      { id: 'rel_i', label: 'informs', complement: 'is informed by', color: 'blue' },
    ],
    allowedRelations: [
      { sourceTypeId: 'node_e', destinationTypeId: 'node_c', relationTypeId: 'rel_s' },
      { sourceTypeId: 'node_e', destinationTypeId: 'node_n', relationTypeId: 'rel_o' },
    ],
    nodes: [
      claim('c-plain', 'CLM - Plain'),
      claim('c-both', 'CLM - Both'),
      claim('c-backed', 'CLM - Backed'),
      claim('h-turned', 'HYP- Turned', 'node_h'),
      claim('n-against', 'CON - Against', 'node_n'),
      claim('e1', 'EVD - One', 'node_e'),
      claim('e2', 'EVD - Two', 'node_e'),
    ],
    relations: [
      relation('r1', 'rel_s', 'e1', 'c-both'),
      relation('r2', 'rel_o', 'e2', 'c-both'),
      relation('r3', 'rel_s', 'e1', 'c-backed'),
      // Stored from the claim to the evidence, which the settings allow only the other way.
      relation('r4', 'rel_s', 'c-backed', 'e2'),
      // Labelled from the far end: the hypothesis is the one supported.
      relation('r5', 'rel_by', 'h-turned', 'e1'),
      // Stored back to front as well.
      relation('r6', 'rel_o', 'n-against', 'e2'),
      relation('r7', 'rel_i', 'e1', 'c-plain'),
      relation('r8', 'rel_gone', 'e1', 'c-plain'),
      relation('r9', 'rel_s', 'c-plain', 'c-plain'),
    ],
  };

  it('puts the unsupported first, then the contested, then the supported', () => {
    const lens = buildLens(vault);
    expect(lens.rows.map((row) => [row.title, row.status])).toEqual([
      ['CON - Against', 'unsupported'],
      ['CLM - Plain', 'unsupported'],
      ['CLM - Both', 'contested'],
      ['CLM - Backed', 'supported'],
      ['HYP- Turned', 'supported'],
    ]);
    expect(lensSummary(lens)).toBe('5 claims: 2 unsupported, 1 contested, 2 supported');
  });

  it('counts a relation stored or labelled the other way round for the right node', () => {
    const rows = new Map(buildLens(vault).rows.map((row) => [row.id, row]));
    expect(rows.get('c-backed')?.supports.map((backer) => backer.id)).toEqual(['e1', 'e2']);
    expect(rows.get('h-turned')?.supports.map((backer) => backer.id)).toEqual(['e1']);
    expect(rows.get('n-against')?.opposes.map((backer) => backer.id)).toEqual(['e2']);
    // Informs, an unknown type, and a relation from a claim to itself count for nothing.
    expect(rows.get('c-plain')).toMatchObject({ supports: [], opposes: [] });
  });

  it('says so when a vault has no claims', () => {
    const lens = buildLens({ ...GRAPH, nodes: [], relations: [] });
    expect(lens.rows).toEqual([]);
    expect(lensSummary(lens)).toBe('No claims, hypotheses or conclusions in this vault.');
    expect(
      lensSummary(buildLens({ ...GRAPH, nodes: GRAPH.nodes.slice(1, 2), relations: [] })),
    ).toBe('1 claim: 1 unsupported, 0 contested, 0 supported');
  });
});
