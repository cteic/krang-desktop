import { describe, expect, it } from 'vitest';

import { GRAPH, VAULT } from './fixtures';
import {
  buildLens,
  isClaimType,
  isEvidenceType,
  lensSummary,
  relationSense,
  relationTypeSense,
} from './lens';
import type { VaultGraph } from './vault-graph';

function claim(id: string, title: string, typeId = 'node_c') {
  return { id, typeId, title, path: `${VAULT}/${title}.md` };
}

function relation(
  id: string,
  typeId: string,
  source: string,
  destination: string,
  tentative: boolean | null = null,
) {
  return { id, typeId, source, destination, ambiguous: false, tentative };
}

function rowsById(graph: VaultGraph) {
  return new Map(buildLens(graph).rows.map((row) => [row.id, row]));
}

function ids(notes: readonly { id: string }[] | undefined): string[] {
  return (notes ?? []).map((note) => note.id);
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

describe('isEvidenceType', () => {
  it('takes evidence and results, whatever their capitals, and nothing else', () => {
    expect(['Evidence', ' RESULT ', 'result'].map(isEvidenceType)).toEqual([true, true, true]);
    expect(
      ['Claim', 'Hypothesis', 'Question', 'Source', 'Results', ''].map(isEvidenceType),
    ).toEqual([false, false, false, false, false, false]);
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

  it('finds the word when the label says more around it', () => {
    expect(relationSense('Supports (strong)')).toEqual({ kind: 'supports', inverse: false });
    expect(relationSense('strongly opposes')).toEqual({ kind: 'opposes', inverse: false });
    expect(relationSense('Supported by (weak)')).toEqual({ kind: 'supports', inverse: true });
  });

  it('takes the word only when it stands whole', () => {
    for (const label of [
      'unsupported by',
      'Unsupported',
      'supportsx',
      'presupposes',
      'disinforms',
    ]) {
      expect(relationSense(label)).toEqual({ kind: 'other', inverse: false });
    }
  });

  it('leaves a label alone when it says not, or names two kinds', () => {
    for (const label of ['does not support', 'not supported by', 'supports or opposes']) {
      expect(relationSense(label)).toEqual({ kind: 'other', inverse: false });
    }
  });
});

describe('relationTypeSense', () => {
  it('reads the label first, then the complement the other way round', () => {
    expect(relationTypeSense({ label: 'Supports', complement: 'is supported by' })).toEqual({
      kind: 'supports',
      inverse: false,
    });
    expect(relationTypeSense({ label: 'backs', complement: 'Is supported by' })).toEqual({
      kind: 'supports',
      inverse: false,
    });
    expect(relationTypeSense({ label: 'rests on', complement: 'opposes' })).toEqual({
      kind: 'opposes',
      inverse: true,
    });
    expect(relationTypeSense({ label: 'cites', complement: 'is cited by' })).toEqual({
      kind: 'other',
      inverse: false,
    });
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
    expect(lensSummary(lens)).toBe(
      '3 claims by evidence: 2 unsupported, 0 opposed, 0 contested, 1 supported',
    );
  });

  const vault: VaultGraph = {
    ...GRAPH,
    nodeTypes: [
      ...GRAPH.nodeTypes,
      { id: 'node_h', name: 'Hypothesis', format: 'HYP- {content}', color: null, tag: null },
      { id: 'node_n', name: 'Conclusion', format: 'CON - {content}', color: null, tag: null },
      { id: 'node_r', name: 'Result', format: 'RES - {content}', color: null, tag: null },
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
      claim('r1', 'RES - One', 'node_r'),
      claim('q1', 'QUE - One', 'node_q'),
    ],
    relations: [
      relation('r1', 'rel_s', 'e1', 'c-both'),
      relation('r2', 'rel_o', 'e2', 'c-both'),
      relation('r3', 'rel_s', 'e1', 'c-backed'),
      relation('r4', 'rel_s', 'r1', 'c-backed'),
      // Labelled from the far end: the hypothesis is the one supported.
      relation('r5', 'rel_by', 'h-turned', 'e1'),
      relation('r6', 'rel_o', 'e2', 'n-against'),
      relation('r7', 'rel_i', 'e1', 'c-plain'),
      relation('r8', 'rel_gone', 'e1', 'c-plain'),
      relation('r9', 'rel_s', 'c-plain', 'c-plain'),
      // A question is neither evidence nor a claim, so it is not listed.
      relation('r10', 'rel_s', 'q1', 'c-plain'),
    ],
  };

  it('puts the unsupported first, then the opposed, the contested and the supported', () => {
    const lens = buildLens(vault);
    expect(lens.rows.map((row) => [row.title, row.status])).toEqual([
      ['CLM - Plain', 'unsupported'],
      ['CON - Against', 'opposed'],
      ['CLM - Both', 'contested'],
      ['CLM - Backed', 'supported'],
      ['HYP- Turned', 'supported'],
    ]);
    expect(lensSummary(lens)).toBe(
      '5 claims by evidence: 1 unsupported, 1 opposed, 1 contested, 2 supported',
    );
  });

  it('counts evidence and results, and reads a label from the far end', () => {
    const rows = rowsById(vault);
    expect(ids(rows.get('c-backed')?.supports)).toEqual(['e1', 'r1']);
    expect(ids(rows.get('h-turned')?.supports)).toEqual(['e1']);
    expect(ids(rows.get('n-against')?.opposes)).toEqual(['e2']);
    // Informs, an unknown type, a question, and a relation from a claim to
    // itself count for nothing.
    expect(rows.get('c-plain')).toMatchObject({
      supports: [],
      opposes: [],
      related: [],
      tentative: [],
    });
  });

  it('tells a claim with only opposing evidence from one with no evidence', () => {
    const rows = rowsById(vault);
    expect(rows.get('n-against')?.status).toBe('opposed');
    expect(rows.get('c-plain')?.status).toBe('unsupported');
  });

  // The four cases an adversarial review found the lens counting wrongly.
  describe('regressions', () => {
    const base: VaultGraph = { ...vault, relations: [] };

    it('(a) does not call two claims supported because they support each other', () => {
      const lens = buildLens({
        ...base,
        relations: [
          relation('a1', 'rel_s', 'c-plain', 'c-both'),
          relation('a2', 'rel_s', 'c-both', 'c-plain'),
        ],
      });
      const rows = new Map(lens.rows.map((row) => [row.id, row]));
      expect(rows.get('c-plain')).toMatchObject({ status: 'unsupported', supports: [] });
      expect(rows.get('c-both')).toMatchObject({ status: 'unsupported', supports: [] });
      // Each is listed under the other as a related claim, and not counted.
      expect(rows.get('c-plain')?.related).toEqual([
        { id: 'c-both', title: 'CLM - Both', path: `${VAULT}/CLM - Both.md`, kind: 'supports' },
      ]);
      expect(ids(rows.get('c-both')?.related)).toEqual(['c-plain']);
      expect(lens.supported).toBe(0);
      expect(lens.unsupported).toBe(5);
    });

    it('(b) reads "Supports (strong)", and says so when no label can be read', () => {
      const strong = buildLens({
        ...base,
        relationTypes: [
          { id: 'rel_s', label: 'Supports (strong)', complement: '', color: null },
          { id: 'rel_u', label: 'Unsupported by', complement: '', color: null },
        ],
        relations: [
          relation('b1', 'rel_s', 'e1', 'c-plain'),
          relation('b2', 'rel_u', 'e1', 'c-both'),
        ],
      });
      const rows = new Map(strong.rows.map((row) => [row.id, row]));
      expect(rows.get('c-plain')?.status).toBe('supported');
      expect(rows.get('c-both')).toMatchObject({
        status: 'unsupported',
        supports: [],
        opposes: [],
      });

      const unreadable = buildLens({
        ...base,
        relationTypes: [
          { id: 'rel_s', label: 'Backs', complement: 'Backed by', color: null },
          { id: 'rel_i', label: 'informs', complement: 'is informed by', color: null },
        ],
        relations: [relation('b3', 'rel_s', 'e1', 'c-plain')],
      });
      expect(unreadable.counted).toBe(false);
      // No claim is called unsupported when nothing could be counted.
      expect(unreadable.rows.map((row) => row.status)).toEqual([null, null, null, null, null]);
      expect(unreadable.unsupported).toBe(0);
      expect(lensSummary(unreadable)).toBe(
        '5 claims. Support is not counted: no relation type here is labelled supports or opposes.',
      );
    });

    it('(c) reads a relation the way it is stored, whatever the settings allow', () => {
      const stored = [relation('c1', 'rel_s', 'h-turned', 'c-plain')];
      const rules = [
        [],
        // Only the other way round is allowed: this used to flip the relation.
        [{ sourceTypeId: 'node_c', destinationTypeId: 'node_h', relationTypeId: 'rel_s' }],
        [{ sourceTypeId: 'node_h', destinationTypeId: 'node_c', relationTypeId: 'rel_s' }],
      ];
      const results = rules.map((allowedRelations) =>
        buildLens({ ...base, allowedRelations, relations: stored }),
      );
      for (const lens of results) {
        const rows = new Map(lens.rows.map((row) => [row.id, row]));
        // The hypothesis supports the claim, never the claim the hypothesis.
        expect(ids(rows.get('c-plain')?.related)).toEqual(['h-turned']);
        expect(rows.get('h-turned')).toMatchObject({ related: [], supports: [] });
      }
      // Editing the allowed relations changes nothing in the lens.
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);

      // Evidence stored from the claim to the evidence is not turned round.
      const backwards = buildLens({
        ...base,
        allowedRelations: vault.allowedRelations,
        relations: [relation('c2', 'rel_s', 'c-plain', 'e1')],
      });
      expect(backwards.rows.find((row) => row.id === 'c-plain')).toMatchObject({
        status: 'unsupported',
        supports: [],
      });
    });

    it('(d) counts a note once however many relations join the same pair', () => {
      const rows = rowsById({
        ...base,
        relations: [
          relation('d1', 'rel_s', 'e1', 'c-plain'),
          relation('d2', 'rel_s', 'e1', 'c-plain'),
          // The same pair again through the label that reads the other way.
          relation('d3', 'rel_by', 'c-plain', 'e1'),
          relation('d4', 'rel_o', 'e2', 'c-plain'),
          relation('d5', 'rel_o', 'e2', 'c-plain'),
          relation('d6', 'rel_s', 'c-both', 'c-plain'),
          relation('d7', 'rel_s', 'c-both', 'c-plain'),
        ],
      });
      const row = rows.get('c-plain');
      expect(ids(row?.supports)).toEqual(['e1']);
      expect(ids(row?.opposes)).toEqual(['e2']);
      expect(ids(row?.related)).toEqual(['c-both']);
    });

    it('counts one note on both sides when it supports and opposes the same claim', () => {
      const row = rowsById({
        ...base,
        relations: [
          relation('d8', 'rel_s', 'e1', 'c-plain'),
          relation('d9', 'rel_o', 'e1', 'c-plain'),
        ],
      }).get('c-plain');
      expect(row).toMatchObject({ status: 'contested' });
      expect(ids(row?.supports)).toEqual(['e1']);
      expect(ids(row?.opposes)).toEqual(['e1']);
    });

    it('lists a tentative relation, marked, without counting it', () => {
      const rows = rowsById({
        ...base,
        relations: [
          relation('t1', 'rel_s', 'e1', 'c-plain', false),
          relation('t2', 'rel_o', 'e2', 'c-plain', false),
          relation('t3', 'rel_o', 'e2', 'c-plain', false),
          // Accepted and tentative for the same pair: counted, listed once.
          relation('t4', 'rel_s', 'e1', 'c-both', false),
          relation('t5', 'rel_s', 'e1', 'c-both', true),
        ],
      });
      expect(rows.get('c-plain')).toMatchObject({
        status: 'unsupported',
        supports: [],
        opposes: [],
      });
      expect(rows.get('c-plain')?.tentative.map((note) => [note.id, note.kind])).toEqual([
        ['e1', 'supports'],
        ['e2', 'opposes'],
      ]);
      expect(rows.get('c-both')).toMatchObject({ status: 'supported', tentative: [] });
      expect(ids(rows.get('c-both')?.supports)).toEqual(['e1']);
    });
  });

  it('says so when a vault has no claims', () => {
    const lens = buildLens({ ...GRAPH, nodes: [], relations: [] });
    expect(lens.rows).toEqual([]);
    expect(lensSummary(lens)).toBe('No claims, hypotheses or conclusions in this vault.');
    expect(
      lensSummary(buildLens({ ...GRAPH, nodes: GRAPH.nodes.slice(1, 2), relations: [] })),
    ).toBe('1 claim by evidence: 1 unsupported, 0 opposed, 0 contested, 0 supported');
  });
});
