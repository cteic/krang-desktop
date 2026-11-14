import { describe, expect, it } from 'vitest';

import { GRAPH, OVERVIEW, VAULT } from './fixtures';
import type { VaultGraph } from './vault-graph';
import {
  ALL_VIEW,
  buildView,
  defaultPageId,
  drawablePages,
  legendOf,
  layoutInput,
  resolveViewKey,
  splitTitle,
  viewBounds,
  viewOptions,
  withoutTypes,
  withoutUnlinked,
} from './view-model';
import type { GraphView, ViewEdge, ViewNode } from './view-model';

function nodeOf(view: GraphView, id: string): ViewNode {
  const node = view.nodes.find((item) => item.id === id);
  if (node === undefined) {
    throw new Error(`no node ${id}`);
  }
  return node;
}

function edgeOf(view: GraphView, id: string): ViewEdge {
  const edge = view.edges.find((item) => item.id === id);
  if (edge === undefined) {
    throw new Error(`no edge ${id}`);
  }
  return edge;
}

describe('viewOptions and resolveViewKey', () => {
  it('offers all nodes, then one view per canvas file', () => {
    expect(viewOptions(GRAPH)).toEqual([
      { key: 'all', label: 'All nodes' },
      { key: 'Overview', label: 'Overview' },
    ]);
  });

  it('finds a canvas by file name, with or without its extension', () => {
    expect(resolveViewKey(GRAPH, 'Overview')).toBe('Overview');
    expect(resolveViewKey(GRAPH, 'Overview.md')).toBe('Overview');
  });

  it('falls back to all nodes', () => {
    expect(resolveViewKey(GRAPH, null)).toBe(ALL_VIEW);
    expect(resolveViewKey(GRAPH, 'all')).toBe(ALL_VIEW);
    expect(resolveViewKey(GRAPH, 'No such canvas')).toBe(ALL_VIEW);
  });
});

describe('the all nodes view', () => {
  const view = buildView(GRAPH, ALL_VIEW);

  it('holds every node, coloured by type, with its note path', () => {
    expect(view.label).toBe('All nodes');
    expect(view.nodes.map((node) => node.title)).toEqual([
      'QUE - Does it scale',
      'CLM - It scales',
      'CLM - It does not',
      'EVD - Benchmark run',
      'CLM - Alone',
    ]);
    const question = nodeOf(view, 'id-q');
    expect(question.fill).toBe('#f2c123');
    expect(question.ink).toBe('#000000');
    expect(question.path).toBe(`${VAULT}/QUE - Does it scale.md`);
    const evidence = nodeOf(view, 'id-e');
    expect(evidence.fill).toBe('#8b1a30');
    expect(evidence.ink).toBe('#ffffff');
  });

  it('wraps a title into lines that fit the box', () => {
    const long: VaultGraph = {
      ...GRAPH,
      nodes: [
        {
          id: 'id-long',
          typeId: 'node_c',
          title:
            'CLM - Cumulative advantage reflects both real quality and status amplification, which are hard to tell apart',
          path: `${VAULT}/long.md`,
        },
      ],
      relations: [],
    };
    const node = nodeOf(buildView(long, ALL_VIEW), 'id-long');
    expect(node.lines.length).toBe(3);
    expect(node.lines[2]?.endsWith('…')).toBe(true);
    expect(node.lines.every((line) => line.length <= 23)).toBe(true);
  });

  it('shows the type as a chip, so the title starts at its first real word', () => {
    const claim = nodeOf(view, 'id-c1');
    expect(claim.title).toBe('CLM - It scales');
    expect(claim.chip).toBe('CLM');
    expect(claim.lines).toEqual(['It scales']);
    expect(claim.chipWidth).toBeGreaterThan(0);
    // Big enough to read: about a quarter of the box's height.
    expect(claim.fontSize / claim.rect.h).toBeGreaterThan(0.22);
  });

  it('keeps the first line clear of the chip', () => {
    const long: VaultGraph = {
      ...GRAPH,
      nodes: [
        {
          id: 'id-long',
          typeId: 'node_c',
          title: 'CLM - Status effects fade within a few years',
          path: `${VAULT}/long.md`,
        },
      ],
      relations: [],
    };
    const node = nodeOf(buildView(long, ALL_VIEW), 'id-long');
    const charWidth = node.fontSize * 0.56;
    const room = node.rect.w - node.padding * 2;
    expect((node.lines[0]?.length ?? 0) * charWidth + node.chipWidth).toBeLessThanOrEqual(room);
    expect(node.lines.length).toBeLessThanOrEqual(3);
    expect(node.lines.join(' ')).toBe('Status effects fade within a few years');
  });

  it('marks what each relation says and which node it is about', () => {
    expect(edgeOf(view, 'r1')).toMatchObject({ kind: 'supports', acted: 'id-q' });
    expect(edgeOf(view, 'r2')).toMatchObject({ kind: 'opposes', acted: 'id-q' });
    // Stored from the claim to the evidence, which the settings allow only the other way.
    const turned: VaultGraph = {
      ...GRAPH,
      relations: [
        {
          id: 'r1',
          typeId: 'rel_s',
          source: 'id-c1',
          destination: 'id-e',
          ambiguous: false,
          tentative: null,
        },
      ],
    };
    expect(edgeOf(buildView(turned, ALL_VIEW), 'r1')).toMatchObject({
      kind: 'supports',
      target: 'id-e',
      acted: 'id-c1',
    });
  });

  it('gives each label a background big enough for its text', () => {
    const supports = edgeOf(view, 'r1');
    expect(view.labelSize).toBe(10);
    expect(supports.labelBox.w).toBeGreaterThan('supports'.length * 10 * 0.5);
    expect(supports.labelBox.h).toBeGreaterThan(10);
  });

  it('knows when a label has no room between two boxes', () => {
    const box = { w: 176, h: 60 };
    function fits(claim: { x: number; y: number }): boolean {
      const placed = new Map(GRAPH.nodes.map((node) => [node.id, { x: 0, y: 0, ...box }]));
      placed.set('id-c1', { ...claim, ...box });
      return edgeOf(buildView(GRAPH, ALL_VIEW, null, placed), 'r1').labelFits;
    }
    // Side by side with a narrow gap: the label would lie over both boxes.
    expect(fits({ x: 200, y: 0 })).toBe(false);
    // Far enough apart sideways, or stacked with a row's gap between them.
    expect(fits({ x: 260, y: 0 })).toBe(true);
    expect(fits({ x: 0, y: 84 })).toBe(true);
    expect(fits({ x: 0, y: 70 })).toBe(false);
  });

  it('knows which nodes no relation touches, and can leave them out', () => {
    expect([...view.unlinked]).toEqual([`path:${VAULT}/CLM - Alone.md`]);
    const linked = withoutUnlinked(view);
    expect(linked.nodes.map((node) => node.title)).not.toContain('CLM - Alone');
    expect(linked.nodes.length).toBe(4);
    expect(linked.edges).toBe(view.edges);
    // With no relations at all there is nothing to hide the loose nodes behind.
    const bare = buildView({ ...GRAPH, relations: [] }, ALL_VIEW);
    expect(bare.unlinked.size).toBe(0);
    expect(withoutUnlinked(bare)).toBe(bare);
  });

  it('draws the nodes where it is told to, when given a layout', () => {
    const spot = { x: 900, y: -40, w: 176, h: 60 };
    const placed = new Map(GRAPH.nodes.map((node) => [node.id, spot]));
    expect(nodeOf(buildView(GRAPH, ALL_VIEW, null, placed), 'id-q').rect).toBe(spot);
    expect(layoutInput(GRAPH).nodes.map((node) => node.group)).toEqual([
      '000000',
      '000001',
      '000001',
      '000002',
      '000001',
    ]);
    expect(layoutInput(GRAPH).edges[0]).toEqual({ source: 'id-c1', target: 'id-q' });
  });

  it('draws the relations from the relations file, labelled and coloured by type', () => {
    expect(view.edges.map((edge) => edge.id)).toEqual(['r1', 'r2', 'r3']);
    const supports = edgeOf(view, 'r1');
    expect(supports).toMatchObject({
      source: 'id-c1',
      target: 'id-q',
      label: 'supports',
      color: '#40c057',
      dash: 'solid',
      note: null,
    });
    expect(supports.shape.path.startsWith('M ')).toBe(true);
    expect(edgeOf(view, 'r2')).toMatchObject({ label: 'opposes', color: '#ff6b6b' });
  });

  it('never takes relations from a canvas drawing', () => {
    expect(view.edges.some((edge) => edge.id === 'shape:arrow')).toBe(false);
    expect(view.edges.length).toBe(GRAPH.relations.length);
  });

  it('draws a relation marked not tentative dashed, and an ambiguous one dotted', () => {
    expect(edgeOf(view, 'r2').dash).toBe('dashed');
    const ambiguous = edgeOf(view, 'r3');
    expect(ambiguous.dash).toBe('dotted');
    expect(ambiguous.note).toContain('share an instance id');
  });

  it('reports the relations left out, and no pages', () => {
    expect(view.skipped).toBe(2);
    expect(view.pages).toEqual([]);
    expect(view.pageId).toBeNull();
    expect(view.notDrawn).toBe(0);
  });

  it('gives a relation of an unknown type no label and a neutral colour', () => {
    const odd: VaultGraph = {
      ...GRAPH,
      relations: [
        {
          id: 'r9',
          typeId: 'rel_gone',
          source: 'id-c1',
          destination: 'id-q',
          ambiguous: false,
          tentative: true,
        },
      ],
    };
    expect(edgeOf(buildView(odd, ALL_VIEW), 'r9')).toMatchObject({
      label: '',
      color: '#9aa4b2',
      dash: 'solid',
    });
  });

  it('bows two relations between the same pair apart', () => {
    const both: VaultGraph = {
      ...GRAPH,
      relations: [
        {
          id: 'r1',
          typeId: 'rel_s',
          source: 'id-c1',
          destination: 'id-q',
          ambiguous: false,
          tentative: null,
        },
        {
          id: 'r2',
          typeId: 'relation_o',
          source: 'id-q',
          destination: 'id-c1',
          ambiguous: false,
          tentative: null,
        },
      ],
    };
    const drawn = buildView(both, ALL_VIEW);
    const first = edgeOf(drawn, 'r1').shape;
    const second = edgeOf(drawn, 'r2').shape;
    expect(first.path.includes(' Q ')).toBe(true);
    expect(second.path.includes(' Q ')).toBe(true);
    const apart = Math.hypot(first.label.x - second.label.x, first.label.y - second.label.y);
    expect(apart).toBeGreaterThan(30);
  });

  it('is the same picture when built twice', () => {
    expect(buildView(GRAPH, ALL_VIEW)).toEqual(view);
  });
});

describe('a canvas view', () => {
  it('opens on the first page that has boxes, not the first page', () => {
    expect(drawablePages(OVERVIEW).map((page) => page.name)).toEqual(['Notes', 'Main', 'Detail']);
    expect(defaultPageId(OVERVIEW)).toBe('page:main');
    const view = buildView(GRAPH, 'Overview');
    expect(view.pageId).toBe('page:main');
    expect(view.label).toBe('Overview / Main');
    expect(view.pages.map((page) => page.id)).toEqual(['page:notes', 'page:main', 'page:detail']);
  });

  it('uses the saved positions and sizes, so it matches the plugin', () => {
    const view = buildView(GRAPH, 'Overview');
    expect(nodeOf(view, 'shape:q').rect).toEqual({ x: 400, y: 0, w: 400, h: 112 });
    expect(nodeOf(view, 'shape:c').rect).toEqual({ x: 0, y: 300, w: 200, h: 100 });
    expect(nodeOf(view, 'shape:q').fill).toBe('#f2c123');
    expect(nodeOf(view, 'shape:c').path).toBe(`${VAULT}/claims/CLM - It scales.md`);
  });

  it('sizes the text of a box as the canvas saved it, so a big box has big text', () => {
    const view = buildView(GRAPH, 'Overview');
    const question = nodeOf(view, 'shape:q');
    const claimBox = nodeOf(view, 'shape:c');
    // The question was saved at the medium size, the claim at the small one.
    expect(question.fontSize).toBe(25);
    expect(claimBox.fontSize).toBe(16);
    expect(question.chip).toBe('QUE');
    expect(question.lines).toEqual(['Does it scale']);
    expect(view.labelSize).toBe(18);
  });

  it('shrinks the text of a canvas box only as far as it must to fit whole', () => {
    const crowded: VaultGraph = {
      ...GRAPH,
      canvases: [
        {
          ...OVERVIEW,
          nodes: [
            {
              id: 'shape:long',
              pageId: 'page:main',
              x: 0,
              y: 0,
              w: 200,
              h: 100,
              size: 'xl',
              title: 'CLM - Status amplification explains most early citations of famous authors',
              typeId: 'node_c',
              path: null,
            },
          ],
          relations: [],
        },
      ],
    };
    const node = nodeOf(buildView(crowded, 'Overview'), 'shape:long');
    expect(node.fontSize).toBeLessThan(48);
    expect(node.fontSize).toBeGreaterThanOrEqual(9);
    expect(node.lines.at(-1)?.endsWith('…')).toBe(false);
    expect(node.lines.length * node.fontSize * 1.2).toBeLessThanOrEqual(100);
  });

  it('draws the arrows as saved, with the label at the middle of the line', () => {
    const view = buildView(GRAPH, 'Overview');
    const arrow = edgeOf(view, 'shape:arrow');
    expect(arrow).toMatchObject({
      source: 'shape:c',
      target: 'shape:q',
      label: 'backs up',
      color: '#40c057',
      dash: 'solid',
    });
    // Between the two boxes, which sit at (100, 350) and (600, 56).
    expect(arrow.shape.label.x).toBeGreaterThan(100);
    expect(arrow.shape.label.x).toBeLessThan(600);
    expect(arrow.shape.label.y).toBeGreaterThan(56);
    expect(arrow.shape.label.y).toBeLessThan(350);
    expect(view.skipped).toBe(1);
    expect(view.notDrawn).toBe(2);
  });

  it('shows one page at a time', () => {
    const detail = buildView(GRAPH, 'Overview', 'page:detail');
    expect(detail.nodes.map((node) => node.id)).toEqual(['shape:lost']);
    expect(detail.edges).toEqual([]);
    expect(nodeOf(detail, 'shape:lost').path).toBeNull();

    const notes = buildView(GRAPH, 'Overview', 'page:notes');
    expect(notes.nodes).toEqual([]);
    expect(notes.texts).toEqual([
      { id: 'shape:t', x: -100, y: -200, fontSize: 66, lines: ['Untested', 'claims'] },
    ]);
  });

  it('falls back to the default page for a page it does not have', () => {
    expect(buildView(GRAPH, 'Overview', 'page:empty').pageId).toBe('page:main');
    expect(buildView(GRAPH, 'Overview', 'page:nope').pageId).toBe('page:main');
  });

  it('names a one-page canvas without the page', () => {
    const single: VaultGraph = {
      ...GRAPH,
      canvases: [{ ...OVERVIEW, texts: [], nodes: OVERVIEW.nodes.slice(0, 2) }],
    };
    const view = buildView(single, 'Overview');
    expect(view.label).toBe('Overview');
    expect(view.pages.length).toBe(1);
  });

  it('copes with a canvas that has nothing to draw', () => {
    const bare: VaultGraph = {
      ...GRAPH,
      canvases: [{ ...OVERVIEW, nodes: [], relations: [], texts: [] }],
    };
    const view = buildView(bare, 'Overview');
    expect(view.pageId).toBeNull();
    expect(view.nodes).toEqual([]);
    expect(viewBounds(view)).toBeNull();
  });
});

describe('legendOf and withoutTypes', () => {
  const view = buildView(GRAPH, ALL_VIEW);

  it('lists the types on show in the settings order, with counts', () => {
    expect(legendOf(GRAPH, view)).toEqual([
      { typeId: 'node_q', name: 'Question', fill: '#f2c123', count: 1 },
      { typeId: 'node_c', name: 'Claim', fill: '#2e9e82', count: 3 },
      { typeId: 'node_e', name: 'Evidence', fill: '#8b1a30', count: 1 },
    ]);
  });

  it('counts only the page on show in a canvas', () => {
    expect(legendOf(GRAPH, buildView(GRAPH, 'Overview'))).toEqual([
      { typeId: 'node_q', name: 'Question', fill: '#f2c123', count: 1 },
      { typeId: 'node_c', name: 'Claim', fill: '#2e9e82', count: 1 },
    ]);
  });

  it('names a type the settings do not have', () => {
    const odd: VaultGraph = { ...GRAPH, nodeTypes: GRAPH.nodeTypes.slice(0, 2) };
    const entries = legendOf(odd, buildView(odd, ALL_VIEW));
    expect(entries[2]).toEqual({
      typeId: 'node_e',
      name: 'Unknown type',
      fill: '#6e7681',
      count: 1,
    });
  });

  it('hides a type with the relations that touch it', () => {
    const shown = withoutTypes(view, new Set(['node_c']));
    expect(shown.nodes.map((node) => node.id)).toEqual(['id-q', 'id-e']);
    expect(shown.edges).toEqual([]);
    // Positions do not move when a type is hidden.
    expect(nodeOf(shown, 'id-q').rect).toEqual(nodeOf(view, 'id-q').rect);
    expect(withoutTypes(view, new Set())).toBe(view);
  });
});

describe('viewBounds', () => {
  it('covers boxes and loose text', () => {
    const notes = buildView(GRAPH, 'Overview', 'page:notes');
    const bounds = viewBounds(notes);
    expect(bounds?.x).toBe(-100);
    expect(bounds?.y).toBe(-200);
    expect(bounds?.h).toBeCloseTo(165, 5);
    expect(bounds?.w).toBeGreaterThan(200);
    expect(viewBounds(buildView(GRAPH, 'Overview'))).toEqual({ x: 0, y: 0, w: 800, h: 400 });
  });
});

describe('splitTitle', () => {
  it("takes the short name off the front of a title that follows its type's pattern", () => {
    expect(splitTitle('CLM - It scales', 'CLM - {content}')).toEqual({
      chip: 'CLM',
      text: 'It scales',
    });
    expect(splitTitle('hyp- lower case', 'HYP- {content}')).toEqual({
      chip: 'HYP',
      text: 'lower case',
    });
    expect(splitTitle('[[EVD]] - Linked', '[[EVD]] - {content}')).toEqual({
      chip: 'EVD',
      text: 'Linked',
    });
  });

  it('leaves the title whole when there is no short name to take', () => {
    const whole = (title: string, format: string) => splitTitle(title, format).chip === null;
    expect(splitTitle('@smith2020', '@{content}')).toEqual({ chip: null, text: '@smith2020' });
    expect(whole('Something else', 'CLM - {content}')).toBe(true);
    expect(whole('CLM - ', 'CLM - {content}')).toBe(true);
    expect(whole('Anything', '{content}')).toBe(true);
    expect(whole('Anything', '')).toBe(true);
    expect(whole('Experiment - one', 'Experiment - {content}')).toBe(true);
  });
});
