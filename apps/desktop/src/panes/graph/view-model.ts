import { nodeColor, relationColor, textColorOn } from './colors';
import { boundsOf, edgeShape } from './geometry';
import type { EdgeShape, Rect } from './geometry';
import { DEFAULT_LAYOUT, layoutGraph } from './layout';
import type { Canvas, VaultGraph } from './vault-graph';
import { wrapText } from './wrap-text';

/**
 * Turns what was read from a vault into what one view draws: boxes with
 * wrapped titles, lines between them, and loose text.
 */

export const ALL_VIEW = 'all';
const ALL_LABEL = 'All nodes';
const UNKNOWN_TYPE_NAME = 'Unknown type';

/** Roughly how wide one character is, as a share of the font size. */
const CHAR_WIDTH = 0.56;
const BOX_PADDING_X = 8;
const BOX_PADDING_Y = 6;
const ALL_FONT_SIZE = 12;
const CANVAS_FONT_SIZE = 14;
const MAX_CANVAS_LINES = 6;
const LINE_HEIGHT = 1.25;
/** How far apart two relations between the same pair of boxes bow. */
const BEND_STEP = 44;

/** The canvas drawing's text sizes, in its own units. */
const TEXT_SIZES: Record<string, number> = { s: 18, m: 24, l: 36, xl: 44 };
const DEFAULT_TEXT_SIZE = 24;

export type EdgeDash = 'solid' | 'dashed' | 'dotted';

export interface ViewOption {
  key: string;
  label: string;
}

export interface PageOption {
  id: string;
  name: string;
}

export interface ViewNode {
  id: string;
  title: string;
  typeId: string;
  /** The note to open. Null when a canvas box names no note in the vault. */
  path: string | null;
  rect: Rect;
  fill: string;
  ink: string;
  lines: string[];
  fontSize: number;
}

export interface ViewEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  color: string;
  dash: EdgeDash;
  /** Something the reader should know about this line. Null when nothing. */
  note: string | null;
  shape: EdgeShape;
}

export interface ViewText {
  id: string;
  x: number;
  y: number;
  fontSize: number;
  lines: string[];
}

export interface GraphView {
  key: string;
  label: string;
  /** The pages of a canvas that have something to draw. Empty for all nodes. */
  pages: PageOption[];
  pageId: string | null;
  nodes: ViewNode[];
  edges: ViewEdge[];
  texts: ViewText[];
  /** Relations that could not be drawn. */
  skipped: number;
  skippedNote: string;
  /** Canvas shapes of kinds this pane does not draw. */
  notDrawn: number;
}

export interface LegendEntry {
  typeId: string;
  name: string;
  fill: string;
  count: number;
}

function withoutNoteSuffix(name: string): string {
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}

/** The views a vault offers: all nodes, then one per canvas file. */
export function viewOptions(graph: VaultGraph): ViewOption[] {
  const options: ViewOption[] = [{ key: ALL_VIEW, label: ALL_LABEL }];
  const seen = new Set<string>([ALL_VIEW]);
  for (const canvas of graph.canvases) {
    if (!seen.has(canvas.name)) {
      seen.add(canvas.name);
      options.push({ key: canvas.name, label: canvas.name });
    }
  }
  return options;
}

/**
 * The view a pane should show for the name its content carries. A name
 * that matches no canvas, with or without `.md`, falls back to all nodes.
 */
export function resolveViewKey(graph: VaultGraph, wanted: string | null): string {
  if (wanted === null || wanted === ALL_VIEW) {
    return ALL_VIEW;
  }
  const name = withoutNoteSuffix(wanted.trim());
  return graph.canvases.some((canvas) => canvas.name === name) ? name : ALL_VIEW;
}

/** The pages of a canvas that hold a box or some text. */
export function drawablePages(canvas: Canvas): PageOption[] {
  const used = new Set([
    ...canvas.nodes.map((node) => node.pageId),
    ...canvas.texts.map((text) => text.pageId),
  ]);
  return canvas.pages.filter((page) => used.has(page.id));
}

/** The page a canvas opens on: the first that has boxes, else the first with anything. */
export function defaultPageId(canvas: Canvas): string | null {
  const withNodes = new Set(canvas.nodes.map((node) => node.pageId));
  const pages = drawablePages(canvas);
  return (pages.find((page) => withNodes.has(page.id)) ?? pages[0])?.id ?? null;
}

function linesFor(title: string, rect: Rect, fontSize: number, maxLines: number): string[] {
  const maxChars = Math.floor((rect.w - BOX_PADDING_X * 2) / (fontSize * CHAR_WIDTH));
  const fits = Math.floor((rect.h - BOX_PADDING_Y * 2) / (fontSize * LINE_HEIGHT));
  return wrapText(title, Math.max(maxChars, 4), Math.min(Math.max(fits, 1), maxLines));
}

interface EdgeDraft {
  id: string;
  source: string;
  target: string;
  label: string;
  color: string;
  dash: EdgeDash;
  note: string | null;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** Gives each line its path. Lines that share both ends bow apart. */
function shapeEdges(drafts: readonly EdgeDraft[], rects: ReadonlyMap<string, Rect>): ViewEdge[] {
  const groups = new Map<string, EdgeDraft[]>();
  for (const draft of drafts) {
    const key = pairKey(draft.source, draft.target);
    groups.set(key, [...(groups.get(key) ?? []), draft]);
  }
  const edges: ViewEdge[] = [];
  for (const draft of drafts) {
    const source = rects.get(draft.source);
    const target = rects.get(draft.target);
    if (source === undefined || target === undefined) {
      continue;
    }
    const group = groups.get(pairKey(draft.source, draft.target)) ?? [draft];
    const offset = (group.indexOf(draft) - (group.length - 1) / 2) * BEND_STEP;
    // A bend is measured to the left of the line's direction, so two lines
    // that run opposite ways need opposite signs to bow the same way.
    const bend = draft.source < draft.target ? offset : -offset;
    edges.push({ ...draft, shape: edgeShape(source, target, bend) });
  }
  return edges;
}

function allNodesView(graph: VaultGraph): GraphView {
  const fills = new Map(graph.nodeTypes.map((type) => [type.id, nodeColor(type.color)]));
  const relationTypes = new Map(graph.relationTypes.map((type) => [type.id, type]));
  const typeOrder = new Map(graph.nodeTypes.map((type, index) => [type.id, index]));

  const drafts: EdgeDraft[] = graph.relations.map((relation) => {
    const type = relationTypes.get(relation.typeId);
    let dash: EdgeDash = relation.tentative === false ? 'dashed' : 'solid';
    if (relation.ambiguous) {
      dash = 'dotted';
    }
    return {
      id: relation.id,
      source: relation.source,
      target: relation.destination,
      label: type?.label ?? '',
      color: relationColor(type?.color ?? null),
      dash,
      note: relation.ambiguous
        ? 'Several notes share an instance id this relation names, so it may be drawn to the wrong note.'
        : null,
    };
  });

  const rects = layoutGraph(
    graph.nodes.map((node) => ({
      id: node.id,
      // Zero-padded, so the grid of unrelated nodes follows the settings' order.
      group: String(typeOrder.get(node.typeId) ?? graph.nodeTypes.length).padStart(6, '0'),
      label: node.title,
    })),
    drafts,
    DEFAULT_LAYOUT,
  );

  const nodes: ViewNode[] = [];
  for (const node of graph.nodes) {
    const rect = rects.get(node.id);
    if (rect === undefined) {
      continue;
    }
    const fill = fills.get(node.typeId) ?? nodeColor(null);
    nodes.push({
      id: node.id,
      title: node.title,
      typeId: node.typeId,
      path: node.path,
      rect,
      fill,
      ink: textColorOn(fill),
      lines: linesFor(node.title, rect, ALL_FONT_SIZE, 3),
      fontSize: ALL_FONT_SIZE,
    });
  }

  return {
    key: ALL_VIEW,
    label: ALL_LABEL,
    pages: [],
    pageId: null,
    nodes,
    edges: shapeEdges(drafts, rects),
    texts: [],
    skipped: graph.skippedRelations,
    skippedNote: 'Relations left out because an end names no note in the vault.',
    notDrawn: 0,
  };
}

function canvasView(graph: VaultGraph, canvas: Canvas, wantedPage: string | null): GraphView {
  const fills = new Map(graph.nodeTypes.map((type) => [type.id, nodeColor(type.color)]));
  const relationTypes = new Map(graph.relationTypes.map((type) => [type.id, type]));
  const pages = drawablePages(canvas);
  const pageId = pages.some((page) => page.id === wantedPage) ? wantedPage : defaultPageId(canvas);
  const page = pages.find((item) => item.id === pageId);

  const nodes: ViewNode[] = canvas.nodes
    .filter((node) => node.pageId === pageId)
    .map((node) => {
      const rect = { x: node.x, y: node.y, w: node.w, h: node.h };
      const fill = fills.get(node.typeId) ?? nodeColor(null);
      return {
        id: node.id,
        title: node.title,
        typeId: node.typeId,
        path: node.path,
        rect,
        fill,
        ink: textColorOn(fill),
        lines: linesFor(node.title, rect, CANVAS_FONT_SIZE, MAX_CANVAS_LINES),
        fontSize: CANVAS_FONT_SIZE,
      };
    });
  const rects = new Map(nodes.map((node) => [node.id, node.rect]));

  const drafts: EdgeDraft[] = canvas.relations
    .filter((relation) => relation.pageId === pageId)
    .map((relation) => {
      const type = relationTypes.get(relation.typeId);
      return {
        id: relation.id,
        source: relation.source,
        target: relation.destination,
        label: relation.label === '' ? (type?.label ?? '') : relation.label,
        color: relationColor(type?.color ?? null),
        dash: 'solid',
        note: null,
      };
    });

  const texts: ViewText[] = canvas.texts
    .filter((text) => text.pageId === pageId)
    .map((text) => ({
      id: text.id,
      x: text.x,
      y: text.y,
      fontSize: (TEXT_SIZES[text.size] ?? DEFAULT_TEXT_SIZE) * text.scale,
      lines: text.text.split('\n'),
    }));

  return {
    key: canvas.name,
    label: pages.length > 1 && page !== undefined ? `${canvas.name} / ${page.name}` : canvas.name,
    pages,
    pageId,
    nodes,
    edges: shapeEdges(drafts, rects),
    texts,
    skipped: canvas.unboundRelations,
    skippedNote: 'Arrows in this canvas that are not attached to a box at both ends.',
    notDrawn: canvas.otherShapes,
  };
}

/**
 * Builds one view. `key` is a view option's key. `pageId` picks a page of
 * a canvas. A page the canvas does not have gives its default page.
 */
export function buildView(graph: VaultGraph, key: string, pageId: string | null = null): GraphView {
  const canvas = graph.canvases.find((item) => item.name === key);
  return canvas === undefined ? allNodesView(graph) : canvasView(graph, canvas, pageId);
}

/** The node types a view holds, in the settings' order, with how many of each. */
export function legendOf(graph: VaultGraph, view: GraphView): LegendEntry[] {
  const counts = new Map<string, number>();
  for (const node of view.nodes) {
    counts.set(node.typeId, (counts.get(node.typeId) ?? 0) + 1);
  }
  const entries: LegendEntry[] = [];
  for (const type of graph.nodeTypes) {
    const count = counts.get(type.id);
    if (count !== undefined) {
      entries.push({ typeId: type.id, name: type.name, fill: nodeColor(type.color), count });
      counts.delete(type.id);
    }
  }
  const unknown = [...counts.keys()].sort();
  for (const typeId of unknown) {
    entries.push({
      typeId,
      name: UNKNOWN_TYPE_NAME,
      fill: nodeColor(null),
      count: counts.get(typeId) ?? 0,
    });
  }
  return entries;
}

/** A view without the nodes of the hidden types, or the lines that touch them. */
export function withoutTypes(view: GraphView, hidden: ReadonlySet<string>): GraphView {
  if (hidden.size === 0) {
    return view;
  }
  const nodes = view.nodes.filter((node) => !hidden.has(node.typeId));
  const kept = new Set(nodes.map((node) => node.id));
  return {
    ...view,
    nodes,
    edges: view.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target)),
  };
}

/** The box around everything a view draws. Null when it draws nothing. */
export function viewBounds(view: GraphView): Rect | null {
  const texts = view.texts.map((text) => {
    const longest = Math.max(0, ...text.lines.map((line) => line.length));
    return {
      x: text.x,
      y: text.y,
      w: longest * text.fontSize * CHAR_WIDTH,
      h: text.lines.length * text.fontSize * LINE_HEIGHT,
    };
  });
  return boundsOf([...view.nodes.map((node) => node.rect), ...texts]);
}
