import { describe, expect, it } from 'vitest';

import { GRAPH, OVERVIEW, VAULT } from './fixtures';
import { curveHitsRect, rectsOverlap } from './geometry';
import type { Rect } from './geometry';
import { layoutGraph } from './layout';
import type { Canvas, VaultGraph } from './vault-graph';
import {
  ALL_VIEW,
  buildView,
  canvasTextFloor,
  defaultPageId,
  drawablePages,
  fitCap,
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
    // Stored from the claim to the evidence, which the settings allow only
    // the other way. It is read as stored: the settings do not turn it round.
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
      acted: 'id-e',
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
    // Each relation says how wide its label is, so the layout can leave room for it.
    expect(layoutInput(GRAPH).edges[0]).toEqual({
      source: 'id-c1',
      target: 'id-q',
      labelWidth: edgeOf(view, 'r1').labelBox.w,
    });
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

describe('lines and labels among the boxes of the all nodes view', () => {
  const BOX = { w: 176, h: 60 };

  function pillOf(edge: ViewEdge): Rect {
    return {
      x: edge.shape.label.x - edge.labelBox.w / 2,
      y: edge.shape.label.y - edge.labelBox.h / 2,
      w: edge.labelBox.w,
      h: edge.labelBox.h,
    };
  }

  /** The question, one claim and the evidence in a row, the rest out of the way. */
  function row(middle: { x: number; y: number }): Map<string, Rect> {
    const placed = new Map(
      GRAPH.nodes.map((node, index) => [node.id, { x: 5000, y: index * 200, ...BOX }]),
    );
    placed.set('id-c1', { x: 0, y: 0, ...BOX });
    placed.set('id-c2', { ...middle, ...BOX });
    placed.set('id-q', { x: 700, y: 0, ...BOX });
    return placed;
  }

  it('puts every label clear of every box in a graph it laid out itself', () => {
    // Eight nodes, each claim tied to the question and to its neighbours.
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const links: [string, string][] = [
      ['b', 'a'],
      ['c', 'a'],
      ['d', 'a'],
      ['e', 'b'],
      ['f', 'b'],
      ['g', 'c'],
      ['h', 'd'],
      ['e', 'd'],
      ['f', 'c'],
      ['g', 'h'],
      ['h', 'b'],
    ];
    const graph: VaultGraph = {
      ...GRAPH,
      nodes: ids.map((id) => ({
        id,
        typeId: 'node_c',
        title: `CLM - Claim ${id}`,
        path: `${VAULT}/CLM - Claim ${id}.md`,
      })),
      relations: links.map(([source, destination], index) => ({
        id: `l${String(index)}`,
        typeId: index % 2 === 0 ? 'rel_s' : 'relation_o',
        source,
        destination,
        ambiguous: false,
        tentative: null,
      })),
      canvases: [],
    };
    const input = layoutInput(graph);
    const built = buildView(graph, ALL_VIEW, null, layoutGraph(input.nodes, input.edges));
    expect(built.edges.length).toBe(links.length);
    for (const edge of built.edges) {
      expect(edge.labelFits, edge.id).toBe(true);
      for (const node of built.nodes) {
        expect(rectsOverlap(pillOf(edge), node.rect), `${edge.id} on ${node.id}`).toBe(false);
      }
      // No line runs under a box that is not at one of its ends.
      for (const node of built.nodes) {
        const { curve } = edge.shape;
        if (curve !== null && node.id !== edge.source && node.id !== edge.target) {
          expect(curveHitsRect(curve, node.rect), `${edge.id} under ${node.id}`).toBe(false);
        }
      }
    }
    // And no label lies on another.
    built.edges.forEach((edge, index) => {
      for (const other of built.edges.slice(index + 1)) {
        expect(rectsOverlap(pillOf(edge), pillOf(other)), `${edge.id} on ${other.id}`).toBe(false);
      }
    });
  });

  it('puts a label in the middle of the open part of its line when that is clear', () => {
    const edge = edgeOf(buildView(GRAPH, ALL_VIEW, null, row({ x: 5000, y: 3000 })), 'r1');
    expect(edge.labelFits).toBe(true);
    // From the right edge of one box, at 176, to the left edge of the other, at 700.
    expect(edge.shape.label.x).toBeCloseTo((176 + 700) / 2, 5);
    expect(edge.shape.label.y).toBeCloseTo(30, 5);
  });

  it('moves a label along its line, off a box that sits by the middle', () => {
    // A box just above the middle of the line: the line passes, the label would not.
    const placed = row({ x: 350, y: -37 });
    const edge = edgeOf(buildView(GRAPH, ALL_VIEW, null, placed), 'r1');
    expect(edge.shape.path.includes('Q')).toBe(false);
    expect(edge.labelFits).toBe(true);
    expect(Math.abs(edge.shape.label.x - 438)).toBeGreaterThan(40);
    for (const rect of placed.values()) {
      expect(rectsOverlap(pillOf(edge), rect)).toBe(false);
    }
  });

  it('bows a line around a box that is in its way', () => {
    const placed = row({ x: 350, y: 0 });
    const edge = edgeOf(buildView(GRAPH, ALL_VIEW, null, placed), 'r1');
    expect(edge.shape.path.includes('Q')).toBe(true);
    const { curve } = edge.shape;
    const blocker = placed.get('id-c2');
    expect(curve !== null && blocker !== undefined && curveHitsRect(curve, blocker)).toBe(false);
    // Its label goes with it, clear of the box.
    expect(edge.labelFits).toBe(true);
    expect(blocker !== undefined && rectsOverlap(pillOf(edge), blocker)).toBe(false);
  });

  it('keeps a label back when no place along its line is clear', () => {
    const placed = row({ x: 5000, y: 3000 });
    placed.set('id-q', { x: 200, y: 0, ...BOX });
    const edge = edgeOf(buildView(GRAPH, ALL_VIEW, null, placed), 'r1');
    expect(edge.labelFits).toBe(false);
    // It still has a place, for when one of its boxes is selected.
    expect(edge.shape.label.x).toBeCloseTo(188, 5);
  });

  it('fits a few nodes larger than full size, but keeps their titles to about 18 px', () => {
    const all = buildView(GRAPH, ALL_VIEW);
    const cap = fitCap(all);
    expect(cap).toBeGreaterThan(1.25);
    expect(nodeOf(all, 'id-q').fontSize * cap).toBeLessThanOrEqual(18.001);
    expect(fitCap(buildView(GRAPH, 'Overview'))).toBe(1.25);
  });
});

describe('the text of a canvas box', () => {
  const LONG = 'CLM - Status amplification explains most early citations of famous authors';

  function canvasWith(size: string, box: { w: number; h: number }): VaultGraph {
    return {
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
              ...box,
              size,
              title: LONG,
              typeId: 'node_c',
              path: null,
            },
          ],
          relations: [],
        },
      ],
    };
  }

  it('shrinks to fit its box, but not below what reads with the canvas fitted', () => {
    const graph = canvasWith('m', { w: 200, h: 100 });
    // Fitted at about a third of full size, 5 px on screen is about 15 in the canvas.
    const floor = canvasTextFloor(0.35);
    expect(floor * 0.35).toBeGreaterThanOrEqual(5);
    expect(floor * 0.35).toBeLessThan(6);
    const node = nodeOf(buildView(graph, 'Overview', null, null, floor), 'shape:long');
    expect(node.fontSize).toBe(floor);
    // What does not fit at that size is cut short, never dropped.
    expect(node.lines.length).toBeGreaterThan(1);
    expect(node.lines.at(-1)?.endsWith('…')).toBe(true);
    expect(node.lines.length * node.fontSize * 1.2).toBeLessThanOrEqual(100);
    expect(node.chip).toBe('CLM');
  });

  it('keeps the saved size when the title fits at it', () => {
    const graph = canvasWith('s', { w: 400, h: 121 });
    const node = nodeOf(
      buildView(graph, 'Overview', null, null, canvasTextFloor(0.35)),
      'shape:long',
    );
    expect(node.fontSize).toBe(16);
    expect(node.lines.at(-1)?.endsWith('…')).toBe(false);
  });

  it('never grows text past the size the canvas saved', () => {
    // Fitted very small, the floor is above the saved size. The saved size stays.
    const graph = canvasWith('s', { w: 120, h: 60 });
    const node = nodeOf(
      buildView(graph, 'Overview', null, null, canvasTextFloor(0.1)),
      'shape:long',
    );
    expect(node.fontSize).toBe(16);
    expect(node.lines.at(-1)?.endsWith('…')).toBe(true);
  });

  it('moves its floor in steps, so a small change of zoom wraps nothing again', () => {
    expect(canvasTextFloor(0.35)).toBe(canvasTextFloor(0.36));
    expect(canvasTextFloor(0.2)).toBeGreaterThan(canvasTextFloor(0.4));
    expect(canvasTextFloor(0)).toBe(9);
  });
});

describe('loose text on a canvas', () => {
  function withText(text: Partial<Canvas['texts'][number]>): GraphView {
    const canvas: Canvas = {
      ...OVERVIEW,
      texts: [
        {
          id: 'shape:t',
          pageId: 'page:main',
          x: -1164,
          y: 427,
          w: 260,
          size: 'xl',
          scale: 1.3,
          text: 'Untested claims!!',
          ...text,
        },
      ],
    };
    return buildView({ ...GRAPH, canvases: [canvas] }, 'Overview', 'page:main');
  }

  it('wraps at the width the canvas saved, measured before the text is scaled', () => {
    const [text] = withText({}).texts;
    // At 44 units a line of 260 holds about nine letters, so the two words part.
    expect(text?.lines).toEqual(['Untested', 'claims!!']);
    expect(text?.fontSize).toBeCloseTo(44 * 1.3, 5);
    // The room it takes is the saved width, scaled: it stops short of a box at -786.
    expect(text?.w).toBeCloseTo(338, 5);
    expect((text?.x ?? 0) + (text?.w ?? 0)).toBeLessThan(-786);
    expect(text?.h).toBeCloseTo(2 * 44 * 1.3 * 1.35, 5);
  });

  it('leaves text that sets its own width on the lines it was written on', () => {
    const [text] = withText({ w: 0, text: 'Untested claims!!\nsecond line' }).texts;
    expect(text?.lines).toEqual(['Untested claims!!', 'second line']);
    expect(text?.w).toBeGreaterThan(400);
  });

  it('keeps an empty line between two paragraphs', () => {
    const [text] = withText({ w: 600, text: 'one\n\ntwo' }).texts;
    expect(text?.lines).toEqual(['one', '', 'two']);
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
      {
        id: 'shape:t',
        x: -100,
        y: -200,
        w: 390,
        h: 2 * 66 * 1.35,
        fontSize: 66,
        lines: ['Untested', 'claims'],
      },
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
    expect(bounds?.h).toBeCloseTo(178.2, 5);
    expect(bounds?.w).toBe(390);
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
