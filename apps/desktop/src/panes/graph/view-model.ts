import { nodeColor, relationColor, relationColors, textColorOn } from './colors';
import { boundsOf, curveHitsRect, curvePoint, edgeShape } from './geometry';
import type { EdgeShape, Point, Rect, Size } from './geometry';
import { DEFAULT_LAYOUT, layoutGraph } from './layout';
import type { LayoutEdge, LayoutNode } from './layout';
import { RectIndex } from './rect-index';
import { relationSense, relationTypeSense } from './lens';
import type { RelationKind } from './lens';
import type { Canvas, NodeType, VaultGraph } from './vault-graph';
import { wrapText } from './wrap-text';

/**
 * Turns what was read from a vault into what one view draws: boxes with
 * wrapped titles, lines between them, and loose text.
 */

export const ALL_VIEW = 'all';
const ALL_LABEL = 'All nodes';
const UNKNOWN_TYPE_NAME = 'Unknown type';
const NO_IDS: ReadonlySet<string> = new Set();

/** Roughly how wide one character is, as a share of the font size. */
const CHAR_WIDTH = 0.56;
const ALL_PADDING_X = 8;
const ALL_PADDING_Y = 4;
const ALL_FONT_SIZE = 14;
const ALL_MAX_LINES = 3;
const ALL_LABEL_SIZE = 10;
/** The space the canvas leaves between a box's edge and its text. */
const CANVAS_PADDING = 12;
/** The canvas drawing's sizes for the text in a box, in its own units. */
const NODE_FONT_SIZES: Record<string, number> = { s: 16, m: 25, l: 38, xl: 48 };
const DEFAULT_NODE_FONT_SIZE = 16;
const MIN_CANVAS_FONT_SIZE = 9;
const MAX_CANVAS_LINES = 12;
const CANVAS_LABEL_SIZE = 18;
/** The smallest a canvas box's text is shrunk to, on screen, with the canvas fitted to the pane. */
const CANVAS_MIN_TEXT_PX = 5;
/** The line height of loose text on a canvas, as the canvas draws it. */
export const TEXT_LINE_HEIGHT = 1.35;
/**
 * Roughly how wide one character of loose text is where the canvas wraps
 * it, as a share of the font size. Its handwriting font runs wide.
 */
const TEXT_CHAR_WIDTH = 0.6;
/** The narrowest the canvas lets loose text wrap. */
const MIN_TEXT_WIDTH = 16;
/** The largest a title in the all nodes view is drawn on screen when the view is fitted. */
const MAX_TITLE_PX = 18;
/** A canvas is fitted a little over full size at most. */
const CANVAS_FIT_SCALE = 1.25;
/** The line height of the text in a box. */
export const NODE_LINE_HEIGHT = 1.2;
/** The type chip's letters, as a share of the box's font size. */
export const CHIP_FONT = 0.72;
const CHIP_CHAR_WIDTH = 0.66;
const CHIP_PADDING = 0.45;
const CHIP_GAP = 0.4;
const MAX_CHIP_CHARS = 6;
const LABEL_CHAR_WIDTH = 0.58;
/** The space a label needs beyond its own size to sit clear of the boxes. */
const LABEL_CLEARANCE = 4;
const ALL_INSET: Size = { w: ALL_PADDING_X, h: ALL_PADDING_Y };
const CANVAS_INSET: Size = { w: CANVAS_PADDING, h: CANVAS_PADDING };
/** How far apart two relations between the same pair of boxes bow. */
const BEND_STEP = 44;
/** With up to this many related nodes, a line that would run under a box is bowed around it. */
const ROUTE_LIMIT = 40;
/** The bows tried, in order, for a line that would run under a box. */
const ROUTE_BENDS = [70, -70, 120, -120, 170, -170, 230, -230];
/** How far a bowed line stays from the boxes it goes around. */
const ROUTE_CLEARANCE = 4;
/** Where along a line its label is tried, as a share of the way: the middle first. */
const LABEL_STOPS = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74];

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
  /**
   * The short name of the node's type, taken from the front of its title,
   * such as `CLM`. Drawn as a chip. Null when the title has no such front.
   */
  chip: string | null;
  /** How wide the chip is drawn. Zero without a chip. */
  chipWidth: number;
  /** The title without the chip's part, wrapped. The first line sits beside the chip. */
  lines: string[];
  fontSize: number;
  /** The space between the box's edge and its text, on each side. */
  padding: number;
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
  kind: RelationKind;
  /**
   * The node the relation acts on: the one supported, opposed or informed.
   * The target, unless the relation is stored or labelled back to front.
   */
  acted: string;
  shape: EdgeShape;
  /** The size of the label's background. */
  labelBox: Size;
  /**
   * True when the label has a place on the open part of the line where it
   * covers no box. A label with no such place is drawn only while one of
   * the boxes at its ends is selected.
   */
  labelFits: boolean;
}

export interface ViewText {
  id: string;
  x: number;
  y: number;
  /** The room the text takes, for fitting the view to the pane. */
  w: number;
  h: number;
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
  /**
   * The nodes no line touches, which can be hidden. Empty when no node has
   * a line, and always for a canvas, which is drawn as saved.
   */
  unlinked: ReadonlySet<string>;
  /** The font size of the labels on the lines. */
  labelSize: number;
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

export interface TitleParts {
  chip: string | null;
  text: string;
}

/**
 * Splits a title into its type's short name and the rest, going by the
 * type's naming pattern. `CLM - It scales` under `CLM - {content}` gives
 * `CLM` and `It scales`. A title that does not follow the pattern, or a
 * pattern with no short name in front, gives the whole title and no chip.
 */
export function splitTitle(title: string, format: string): TitleParts {
  const whole = { chip: null, text: title };
  const slot = format.indexOf('{content}');
  if (slot <= 0) {
    return whole;
  }
  const front = format.slice(0, slot).trimEnd();
  const chip = front.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (chip === '' || chip.length > MAX_CHIP_CHARS) {
    return whole;
  }
  if (!title.toLowerCase().startsWith(front.toLowerCase())) {
    return whole;
  }
  const text = title.slice(front.length).trimStart();
  return text === '' ? whole : { chip, text };
}

interface TextFit {
  chipWidth: number;
  lines: string[];
  fontSize: number;
}

function chipWidthOf(chip: string | null, fontSize: number): number {
  if (chip === null) {
    return 0;
  }
  return fontSize * CHIP_FONT * (chip.length * CHIP_CHAR_WIDTH + CHIP_PADDING * 2);
}

/** Wraps a title for a box at one font size. */
function fitAt(
  parts: TitleParts,
  rect: Rect,
  fontSize: number,
  padding: Size,
  maxLines: number,
): TextFit {
  const chipWidth = chipWidthOf(parts.chip, fontSize);
  const charWidth = fontSize * CHAR_WIDTH;
  const room = rect.w - padding.w * 2;
  const maxChars = Math.max(Math.floor(room / charWidth), 4);
  const beside = chipWidth === 0 ? room : room - chipWidth - fontSize * CHIP_GAP;
  const fits = Math.floor((rect.h - padding.h * 2) / (fontSize * NODE_LINE_HEIGHT));
  const lines = wrapText(
    parts.text,
    maxChars,
    Math.min(Math.max(fits, 1), maxLines),
    Math.floor(beside / charWidth),
  );
  return { chipWidth, lines, fontSize };
}

/**
 * Wraps a title for a canvas box. The text starts at the size the canvas
 * saved for the box, and shrinks only as far as it must to fit whole. It
 * never shrinks below `floor`: a title that still does not fit there
 * keeps the lines that do, and ends in an ellipsis.
 */
function fitCanvasText(parts: TitleParts, rect: Rect, size: string, floor: number): TextFit {
  let fontSize = NODE_FONT_SIZES[size] ?? DEFAULT_NODE_FONT_SIZE;
  const least = Math.min(fontSize, floor);
  let fit = fitAt(parts, rect, fontSize, CANVAS_INSET, MAX_CANVAS_LINES);
  while (fontSize > least && fit.lines.at(-1)?.endsWith('…') === true) {
    fontSize = Math.max(least, fontSize * 0.92);
    fit = fitAt(parts, rect, fontSize, CANVAS_INSET, MAX_CANVAS_LINES);
  }
  return fit;
}

/**
 * The smallest size the text of a canvas box may shrink to, in the
 * canvas's units, for a canvas shown at `fitScale`. It moves in steps, so
 * a pane that changes size a little wraps no title again.
 */
export function canvasTextFloor(fitScale: number): number {
  if (!Number.isFinite(fitScale) || fitScale <= 0) {
    return MIN_CANVAS_FONT_SIZE;
  }
  return 2 ** (Math.ceil(Math.log2(CANVAS_MIN_TEXT_PX / fitScale) * 4) / 4);
}

/** How far the view is zoomed in at most when it is fitted to the pane. */
export function fitCap(view: GraphView): number {
  return view.key === ALL_VIEW ? MAX_TITLE_PX / ALL_FONT_SIZE : CANVAS_FIT_SCALE;
}

function labelBoxOf(label: string, size: number): Size {
  return { w: label.length * size * LABEL_CHAR_WIDTH + size, h: size * 1.5 };
}

interface EdgeDraft {
  id: string;
  source: string;
  target: string;
  label: string;
  color: string;
  dash: EdgeDash;
  note: string | null;
  kind: RelationKind;
  acted: string;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function around(point: Point, size: Size, margin: number): Rect {
  return {
    x: point.x - size.w / 2 - margin,
    y: point.y - size.h / 2 - margin,
    w: size.w + margin * 2,
    h: size.h + margin * 2,
  };
}

/**
 * Gives each line of the all nodes view its path and a place for its
 * label. Lines that share both ends bow apart. In a small graph, a line
 * that would run under a box that is not its own is bowed around it. A
 * label goes at the first place along the open part of its line where it
 * covers no box and no other label.
 */
function routeEdges(
  drafts: readonly EdgeDraft[],
  rects: ReadonlyMap<string, Rect>,
  labelSize: number,
): ViewEdge[] {
  const groups = new Map<string, EdgeDraft[]>();
  const ends = new Set<string>();
  for (const draft of drafts) {
    const key = pairKey(draft.source, draft.target);
    groups.set(key, [...(groups.get(key) ?? []), draft]);
    if (rects.has(draft.source) && rects.has(draft.target)) {
      ends.add(draft.source);
      ends.add(draft.target);
    }
  }
  const taken = new RectIndex();
  for (const rect of rects.values()) {
    taken.add(rect);
  }
  // The boxes a line could run under: the ones that have a line themselves.
  const inTheWay: [string, Rect][] =
    ends.size > ROUTE_LIMIT
      ? []
      : [...ends].flatMap((id): [string, Rect][] => {
          const rect = rects.get(id);
          return rect === undefined
            ? []
            : [
                [
                  id,
                  around({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, rect, ROUTE_CLEARANCE),
                ],
              ];
        });

  const edges: ViewEdge[] = [];
  for (const draft of drafts) {
    const source = rects.get(draft.source);
    const target = rects.get(draft.target);
    if (source === undefined || target === undefined) {
      continue;
    }
    const group = groups.get(pairKey(draft.source, draft.target)) ?? [draft];
    const offset = (group.indexOf(draft) - (group.length - 1) / 2) * BEND_STEP;
    const bend = draft.source < draft.target ? offset : -offset;
    const blocked = (shape: EdgeShape): boolean => {
      const { curve } = shape;
      return (
        curve !== null &&
        inTheWay.some(
          ([id, rect]) => id !== draft.source && id !== draft.target && curveHitsRect(curve, rect),
        )
      );
    };
    let shape = edgeShape(source, target, bend);
    if (blocked(shape)) {
      for (const extra of ROUTE_BENDS) {
        const bowed = edgeShape(source, target, bend + extra);
        if (!blocked(bowed)) {
          shape = bowed;
          break;
        }
      }
    }

    const labelBox = labelBoxOf(draft.label, labelSize);
    const { curve } = shape;
    const spots = curve === null ? [shape.label] : LABEL_STOPS.map((t) => curvePoint(curve, t));
    const spot = spots.find((point) => !taken.hits(around(point, labelBox, LABEL_CLEARANCE / 2)));
    if (spot !== undefined && draft.label !== '') {
      taken.add(around(spot, labelBox, 0));
    }
    edges.push({
      ...draft,
      shape: spot === undefined ? shape : { ...shape, label: spot },
      labelBox,
      labelFits: spot !== undefined,
    });
  }
  return edges;
}

/** Gives each line its path. Lines that share both ends bow apart. */
function shapeEdges(
  drafts: readonly EdgeDraft[],
  rects: ReadonlyMap<string, Rect>,
  labelSize: number,
): ViewEdge[] {
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
    const shape = edgeShape(source, target, bend);
    const labelBox = labelBoxOf(draft.label, labelSize);
    edges.push({
      ...draft,
      shape,
      labelBox,
      // Room along the line, or room across it: either keeps the label off the boxes.
      labelFits:
        shape.span.w >= labelBox.w + LABEL_CLEARANCE ||
        shape.span.h >= labelBox.h + LABEL_CLEARANCE,
    });
  }
  return edges;
}

interface RelationLook {
  label: string;
  color: string;
  kind: RelationKind;
  /** True when the label reads from the far end, as in "is supported by". */
  inverse: boolean;
}

/** How each relation type is drawn. */
function relationLooks(graph: VaultGraph): Map<string, RelationLook> {
  const senses = graph.relationTypes.map((type) => ({ type, sense: relationTypeSense(type) }));
  const colors = relationColors(
    senses.map(({ type, sense }) => ({ id: type.id, color: type.color, kind: sense.kind })),
  );
  return new Map(
    senses.map(({ type, sense }) => [
      type.id,
      {
        label: type.label,
        color: colors.get(type.id) ?? relationColor(type.color),
        kind: sense.kind,
        inverse: sense.inverse,
      },
    ]),
  );
}

export interface LayoutInput {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

/** What the layout needs to place the nodes of the all nodes view. */
export function layoutInput(graph: VaultGraph): LayoutInput {
  const typeOrder = new Map(graph.nodeTypes.map((type, index) => [type.id, index]));
  const labels = new Map(graph.relationTypes.map((type) => [type.id, type.label]));
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      // Zero-padded, so the grid of unrelated nodes follows the settings' order.
      group: String(typeOrder.get(node.typeId) ?? graph.nodeTypes.length).padStart(6, '0'),
      label: node.title,
    })),
    edges: graph.relations.map((relation) => ({
      source: relation.source,
      target: relation.destination,
      labelWidth: labelBoxOf(labels.get(relation.typeId) ?? '', ALL_LABEL_SIZE).w,
    })),
  };
}

function allNodesView(graph: VaultGraph, placed: ReadonlyMap<string, Rect> | null): GraphView {
  const types = new Map(graph.nodeTypes.map((type) => [type.id, type]));
  const looks = relationLooks(graph);

  const drafts: EdgeDraft[] = graph.relations.map((relation) => {
    const look = looks.get(relation.typeId);
    let dash: EdgeDash = relation.tentative === false ? 'dashed' : 'solid';
    if (relation.ambiguous) {
      dash = 'dotted';
    }
    const turned = look?.inverse ?? false;
    return {
      id: relation.id,
      source: relation.source,
      target: relation.destination,
      label: look?.label ?? '',
      color: look?.color ?? relationColor(null),
      dash,
      note: relation.ambiguous
        ? 'Several notes share an instance id this relation names, so it may be drawn to the wrong note.'
        : null,
      kind: look?.kind ?? 'other',
      acted: turned ? relation.source : relation.destination,
    };
  });

  let rects = placed;
  if (rects === null) {
    const input = layoutInput(graph);
    rects = layoutGraph(input.nodes, input.edges, DEFAULT_LAYOUT);
  }

  const nodes: ViewNode[] = [];
  for (const node of graph.nodes) {
    const rect = rects.get(node.id);
    if (rect === undefined) {
      continue;
    }
    nodes.push(viewNode(node, rect, types.get(node.typeId), null, 0));
  }

  const edges = routeEdges(drafts, rects, ALL_LABEL_SIZE);
  const touched = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  const unlinked = nodes.filter((node) => !touched.has(node.id)).map((node) => node.id);
  return {
    key: ALL_VIEW,
    label: ALL_LABEL,
    pages: [],
    pageId: null,
    nodes,
    edges,
    texts: [],
    skipped: graph.skippedRelations,
    skippedNote: 'Relations left out because an end names no note in the vault.',
    notDrawn: 0,
    // With no relations at all there is nothing to set the loose nodes apart from.
    unlinked: unlinked.length === nodes.length ? NO_IDS : new Set(unlinked),
    labelSize: ALL_LABEL_SIZE,
  };
}

interface Titled {
  id: string;
  title: string;
  typeId: string;
  path: string | null;
}

/**
 * One box. `size` is a canvas box's saved text size, and null in the all
 * nodes view. `floor` is the smallest a canvas box's text may shrink to.
 */
function viewNode(
  node: Titled,
  rect: Rect,
  type: NodeType | undefined,
  size: string | null,
  floor: number,
): ViewNode {
  const fill = nodeColor(type?.color ?? null);
  const parts = splitTitle(node.title, type?.format ?? '');
  const fit =
    size === null
      ? fitAt(parts, rect, ALL_FONT_SIZE, ALL_INSET, ALL_MAX_LINES)
      : fitCanvasText(parts, rect, size, floor);
  return {
    id: node.id,
    title: node.title,
    typeId: node.typeId,
    path: node.path,
    rect,
    fill,
    ink: textColorOn(fill),
    chip: parts.chip,
    chipWidth: fit.chipWidth,
    lines: fit.lines,
    fontSize: fit.fontSize,
    padding: size === null ? ALL_PADDING_X : CANVAS_PADDING,
  };
}

/**
 * Loose text as the canvas draws it. Text with a width of its own wraps
 * there, at the size it has before it is scaled, and then the whole of it
 * is scaled.
 */
function viewText(text: Canvas['texts'][number]): ViewText {
  const base = TEXT_SIZES[text.size] ?? DEFAULT_TEXT_SIZE;
  const fontSize = base * text.scale;
  const written = text.text.split('\n');
  let lines = written;
  let width = Math.max(0, ...written.map((line) => line.length)) * fontSize * CHAR_WIDTH;
  if (text.w > 0) {
    const room = Math.max(MIN_TEXT_WIDTH, Math.floor(text.w));
    const maxChars = Math.max(1, Math.floor(room / (base * TEXT_CHAR_WIDTH)));
    lines = written.flatMap((line) => {
      const wrapped = wrapText(line, maxChars, Infinity);
      return wrapped.length === 0 ? [''] : wrapped;
    });
    width = room * text.scale;
  }
  return {
    id: text.id,
    x: text.x,
    y: text.y,
    w: width,
    h: lines.length * fontSize * TEXT_LINE_HEIGHT,
    fontSize,
    lines,
  };
}

function canvasView(
  graph: VaultGraph,
  canvas: Canvas,
  wantedPage: string | null,
  floor: number,
): GraphView {
  const types = new Map(graph.nodeTypes.map((type) => [type.id, type]));
  const looks = relationLooks(graph);
  const pages = drawablePages(canvas);
  const pageId = pages.some((page) => page.id === wantedPage) ? wantedPage : defaultPageId(canvas);
  const page = pages.find((item) => item.id === pageId);

  const nodes: ViewNode[] = canvas.nodes
    .filter((node) => node.pageId === pageId)
    .map((node) =>
      viewNode(
        node,
        { x: node.x, y: node.y, w: node.w, h: node.h },
        types.get(node.typeId),
        node.size,
        floor,
      ),
    );
  const rects = new Map(nodes.map((node) => [node.id, node.rect]));

  const drafts: EdgeDraft[] = canvas.relations
    .filter((relation) => relation.pageId === pageId)
    .map((relation) => {
      const look = looks.get(relation.typeId);
      // An arrow's own text wins over its type's label when it says which way it reads.
      const own = relationSense(relation.label);
      const sense = own.kind === 'other' ? look : own;
      const turned = sense?.inverse ?? false;
      return {
        id: relation.id,
        source: relation.source,
        target: relation.destination,
        label: relation.label === '' ? (look?.label ?? '') : relation.label,
        color: look?.color ?? relationColor(null),
        dash: 'solid',
        note: null,
        kind: sense?.kind ?? 'other',
        acted: turned ? relation.source : relation.destination,
      };
    });

  const texts: ViewText[] = canvas.texts.filter((text) => text.pageId === pageId).map(viewText);

  return {
    key: canvas.name,
    label: pages.length > 1 && page !== undefined ? `${canvas.name} / ${page.name}` : canvas.name,
    pages,
    pageId,
    nodes,
    edges: shapeEdges(drafts, rects, CANVAS_LABEL_SIZE),
    texts,
    skipped: canvas.unboundRelations,
    skippedNote: 'Arrows in this canvas that are not attached to a box at both ends.',
    notDrawn: canvas.otherShapes,
    unlinked: NO_IDS,
    labelSize: CANVAS_LABEL_SIZE,
  };
}

/**
 * Builds one view. `key` is a view option's key. `pageId` picks a page of
 * a canvas. A page the canvas does not have gives its default page.
 * `placed` is where the all nodes view puts each node. Left out, the
 * nodes are laid out from scratch. `textFloor` is the smallest the text
 * of a canvas box may shrink to. See `canvasTextFloor`.
 */
export function buildView(
  graph: VaultGraph,
  key: string,
  pageId: string | null = null,
  placed: ReadonlyMap<string, Rect> | null = null,
  textFloor: number = MIN_CANVAS_FONT_SIZE,
): GraphView {
  const canvas = graph.canvases.find((item) => item.name === key);
  return canvas === undefined
    ? allNodesView(graph, placed)
    : canvasView(graph, canvas, pageId, textFloor);
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

/** A view without the nodes no line touches. */
export function withoutUnlinked(view: GraphView): GraphView {
  if (view.unlinked.size === 0) {
    return view;
  }
  return { ...view, nodes: view.nodes.filter((node) => !view.unlinked.has(node.id)) };
}

/** The box around everything a view draws. Null when it draws nothing. */
export function viewBounds(view: GraphView): Rect | null {
  const texts = view.texts.map((text) => ({ x: text.x, y: text.y, w: text.w, h: text.h }));
  return boundsOf([...view.nodes.map((node) => node.rect), ...texts]);
}
