import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { MouseEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';

import { panBy, zoomAt } from './geometry';
import type { Size, Transform } from './geometry';
import type { SupportStatus } from './lens';
import type { Neighbourhood } from './selection';
import { CHIP_FONT, NODE_LINE_HEIGHT } from './view-model';
import type { GraphView, ViewEdge, ViewNode, ViewText } from './view-model';

/** How far the pointer moves before a press becomes a drag. */
const DRAG_THRESHOLD = 4;
const WHEEL_ZOOM = 0.0015;
/** A pinch arrives as a wheel event with the control key down, in small steps. */
const PINCH_ZOOM = 0.01;
const LINE_HEIGHT = 1.25;
/** Text that would be drawn smaller than this on screen is not drawn at all. */
export const MIN_TEXT_PX = 7;
const DASHES: Record<ViewEdge['dash'], string | undefined> = {
  solid: undefined,
  dashed: '7 5',
  dotted: '2 5',
};

export interface GraphCanvasProps {
  view: GraphView;
  transform: Transform;
  selectedId: string | null;
  /** The selected node's surroundings. Null when nothing is selected. */
  near: Neighbourhood | null;
  /** How well each claim on show is backed, by node id. Null when the lens is off. */
  lens: ReadonlyMap<string, SupportStatus> | null;
  /** The nodes that have just appeared, which are picked out for a moment. */
  fresh: ReadonlySet<string>;
  label: string;
  surfaceRef: RefObject<HTMLDivElement | null>;
  onSelect: (id: string | null) => void;
  onOpen: (node: ViewNode) => void;
  /** The node under the pointer. Null when it is over none. */
  onHover: (id: string | null) => void;
  /** Called when the person pans or zooms. */
  onTransform: (change: (current: Transform) => Transform) => void;
  onResize: (size: Size) => void;
}

interface Drag {
  pointerId: number;
  x: number;
  y: number;
  moved: boolean;
}

function nodeIdAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) {
    return null;
  }
  return target.closest('[data-node-id]')?.getAttribute('data-node-id') ?? null;
}

interface NodeBoxProps {
  node: ViewNode;
  selected: boolean;
  dimmed: boolean;
  status: SupportStatus | null;
  fresh: boolean;
  /** False when the text would be too small to read. */
  detailed: boolean;
  /** True when a box without its text still has room for its type's short name. */
  coded: boolean;
}

/**
 * The size of a type's short name when it has a box to itself: as big as
 * the box allows.
 */
export function codeSize(node: ViewNode): number {
  const letters = Math.max(node.chip?.length ?? 1, 1);
  return Math.min(node.rect.h * 0.6, (node.rect.w * 0.8) / (letters * 0.66));
}

function NodeBox({ node, selected, dimmed, status, fresh, detailed, coded }: NodeBoxProps) {
  const { rect, fontSize } = node;
  const step = fontSize * NODE_LINE_HEIGHT;
  const top = rect.y + rect.h / 2 - (Math.max(node.lines.length, 1) * step) / 2;
  const left = rect.x + node.padding;
  const chipHeight = fontSize * 0.98;
  const chipFont = fontSize * CHIP_FONT;
  // An unsupported claim is drawn hollow, so its text goes on the background.
  const hollow = status === 'unsupported';
  const ink = hollow ? 'var(--text)' : node.ink;
  let chipFill = node.ink === '#000000' ? 'rgb(0 0 0 / 20%)' : 'rgb(255 255 255 / 26%)';
  if (hollow) {
    chipFill = node.fill;
  }
  const middle = rect.x + rect.w / 2;
  const bottom = rect.y + rect.h;
  const right = rect.x + rect.w;
  return (
    <g
      className="graph-node"
      role="button"
      aria-label={node.title}
      aria-pressed={selected}
      data-node-id={node.id}
      data-dimmed={dimmed}
      data-unlinked={node.path === null}
      data-lens={status ?? undefined}
      data-fresh={fresh ? 'true' : undefined}
    >
      <title>{node.path === null ? `${node.title} (no note with this name)` : node.title}</title>
      {fresh ? (
        <rect
          className="graph-node-halo"
          x={rect.x - 6}
          y={rect.y - 6}
          width={rect.w + 12}
          height={rect.h + 12}
          rx={12}
        />
      ) : null}
      <rect
        className="graph-node-box"
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        rx={8}
        fill={hollow ? 'var(--bg)' : node.fill}
        stroke={hollow ? node.fill : undefined}
      />
      {status === 'contested' ? (
        <>
          <path
            className="graph-lens-for"
            d={`M ${String(middle)} ${String(rect.y)} H ${String(rect.x)} V ${String(bottom)} H ${String(middle)}`}
          />
          <path
            className="graph-lens-against"
            d={`M ${String(middle)} ${String(rect.y)} H ${String(right)} V ${String(bottom)} H ${String(middle)}`}
          />
        </>
      ) : null}
      {detailed && node.chip !== null ? (
        <>
          <rect
            className="graph-chip"
            x={left}
            y={top + (step - chipHeight) / 2}
            width={node.chipWidth}
            height={chipHeight}
            rx={chipHeight * 0.28}
            fill={chipFill}
          />
          <text
            className="graph-chip-text"
            x={left + node.chipWidth / 2}
            y={top + step / 2 + chipFont * 0.36}
            textAnchor="middle"
            fontSize={chipFont}
            fill={hollow ? node.ink : ink}
          >
            {node.chip}
          </text>
        </>
      ) : null}
      {!detailed && coded && node.chip !== null ? (
        <text
          className="graph-chip-text"
          x={middle}
          y={rect.y + rect.h / 2 + codeSize(node) * 0.36}
          textAnchor="middle"
          fontSize={codeSize(node)}
          fill={ink}
        >
          {node.chip}
        </text>
      ) : null}
      {detailed ? (
        <text className="graph-node-text" fontSize={fontSize} fill={ink}>
          {node.lines.map((line, index) => (
            <tspan
              key={index}
              x={index === 0 && node.chip !== null ? left + node.chipWidth + fontSize * 0.4 : left}
              y={top + index * step + step / 2 + fontSize * 0.35}
            >
              {line}
            </tspan>
          ))}
        </text>
      ) : null}
    </g>
  );
}

interface EdgeLineProps {
  edge: ViewEdge;
  dimmed: boolean;
}

function EdgeLine({ edge, dimmed }: EdgeLineProps) {
  return (
    <g
      className="graph-edge"
      data-edge-id={edge.id}
      data-dimmed={dimmed}
      data-dash={edge.dash}
      data-kind={edge.kind}
    >
      {edge.note === null ? null : <title>{edge.note}</title>}
      <path d={edge.shape.path} stroke={edge.color} strokeDasharray={DASHES[edge.dash]} />
      <polygon points={edge.shape.head} fill={edge.color} />
    </g>
  );
}

interface EdgeLabelProps {
  edge: ViewEdge;
  dimmed: boolean;
  fontSize: number;
}

/** A relation's label, on a pill of the background colour so it reads over anything. */
function EdgeLabel({ edge, dimmed, fontSize }: EdgeLabelProps) {
  const { label, labelBox } = edge;
  return (
    <g className="graph-edge-label" data-label-for={edge.id} data-dimmed={dimmed}>
      <rect
        x={edge.shape.label.x - labelBox.w / 2}
        y={edge.shape.label.y - labelBox.h / 2}
        width={labelBox.w}
        height={labelBox.h}
        rx={labelBox.h / 2}
        stroke={edge.color}
      />
      <text
        x={edge.shape.label.x}
        y={edge.shape.label.y + fontSize * 0.35}
        textAnchor="middle"
        fontSize={fontSize}
        fill={edge.color}
      >
        {label}
      </text>
    </g>
  );
}

interface LooseTextProps {
  text: ViewText;
}

function LooseText({ text }: LooseTextProps) {
  return (
    <text className="graph-text" fontSize={text.fontSize}>
      {text.lines.map((line, index) => (
        <tspan key={index} x={text.x} y={text.y + text.fontSize * (1 + index * LINE_HEIGHT)}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

interface SceneProps {
  view: GraphView;
  selectedId: string | null;
  near: Neighbourhood | null;
  lens: ReadonlyMap<string, SupportStatus> | null;
  fresh: ReadonlySet<string>;
  /** Boxes whose text is at least this size have it drawn. */
  minFont: number;
  /** True when the boxes too small for their text can still show their type's short name. */
  codes: boolean;
  labels: boolean;
}

/**
 * Everything that is drawn, in the drawing's own units. It is kept apart
 * from the pan and zoom, and remembered, so moving the view redraws none
 * of it: only the group around it gets a new transform.
 */
const Scene = memo(function Scene({
  view,
  selectedId,
  near,
  lens,
  fresh,
  minFont,
  codes,
  labels,
}: SceneProps) {
  return (
    <>
      {view.texts.map((text) => (
        <LooseText key={text.id} text={text} />
      ))}
      {view.edges.map((edge) => (
        <EdgeLine key={edge.id} edge={edge} dimmed={near !== null && !near.edgeIds.has(edge.id)} />
      ))}
      {view.nodes.map((node) => (
        <NodeBox
          key={node.id}
          node={node}
          selected={node.id === selectedId}
          dimmed={near !== null && !near.nodeIds.has(node.id)}
          status={lens?.get(node.id) ?? null}
          fresh={fresh.has(node.id)}
          detailed={node.fontSize >= minFont}
          coded={codes}
        />
      ))}
      {labels
        ? view.edges.map((edge) =>
            edge.label === '' || !(edge.labelFits || near?.edgeIds.has(edge.id) === true) ? null : (
              <EdgeLabel
                key={edge.id}
                edge={edge}
                dimmed={near !== null && !near.edgeIds.has(edge.id)}
                fontSize={view.labelSize}
              />
            ),
          )
        : null}
    </>
  );
});

/**
 * The smallest text size in a view that is still readable at a zoom. It
 * moves in steps, one per text size in the view, so zooming a little
 * leaves it alone. Infinity when nothing is readable.
 */
export function readableFrom(sizes: readonly number[], scale: number): number {
  const needed = MIN_TEXT_PX / scale;
  let smallest = Infinity;
  for (const size of sizes) {
    if (size >= needed && size < smallest) {
      smallest = size;
    }
  }
  return smallest;
}

/** The drawing itself: boxes, lines and text, with pan and zoom. */
export function GraphCanvas({
  view,
  transform,
  selectedId,
  near,
  lens,
  fresh,
  label,
  surfaceRef,
  onSelect,
  onOpen,
  onHover,
  onTransform,
  onResize,
}: GraphCanvasProps) {
  const dragRef = useRef<Drag | null>(null);
  // True from the first move of a drag until the next press, so the click
  // that ends a drag does not also change the selection.
  const draggedRef = useRef(false);
  const hoverRef = useRef<string | null>(null);
  const onTransformRef = useRef(onTransform);
  onTransformRef.current = onTransform;
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  const sizes = useMemo(() => [...new Set(view.nodes.map((node) => node.fontSize))], [view]);
  const minFont = readableFrom(sizes, transform.k);
  // The smallest short name in the view decides for all, so the boxes change together.
  const smallestCode = useMemo(
    () => Math.min(...view.nodes.filter((node) => node.chip !== null).map(codeSize)),
    [view],
  );
  const codes = smallestCode * transform.k >= MIN_TEXT_PX;
  let detail = 'boxes';
  if (minFont !== Infinity) {
    detail = 'text';
  } else if (codes) {
    detail = 'codes';
  }
  const labels = view.labelSize * transform.k >= MIN_TEXT_PX;

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) {
      return;
    }
    function measure() {
      if (surface !== null) {
        onResizeRef.current({ w: surface.clientWidth, h: surface.clientHeight });
      }
    }
    measure();
    // Not every DOM has it: the one the tests run in does not.
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => {
      observer.disconnect();
    };
  }, [surfaceRef]);

  // React listens for the wheel passively, and a passive listener cannot
  // stop the page from scrolling, so this one is attached by hand.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) {
      return;
    }
    function onWheel(event: WheelEvent) {
      if (surface === null) {
        return;
      }
      event.preventDefault();
      const box = surface.getBoundingClientRect();
      const point = { x: event.clientX - box.left, y: event.clientY - box.top };
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? PINCH_ZOOM : WHEEL_ZOOM));
      onTransformRef.current((current) => zoomAt(current, point, factor));
    }
    surface.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      surface.removeEventListener('wheel', onWheel);
    };
  }, [surfaceRef]);

  function hover(id: string | null) {
    if (hoverRef.current !== id) {
      hoverRef.current = id;
      onHover(id);
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    draggedRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
        return;
      }
      drag.moved = true;
      draggedRef.current = true;
      // Captured only once the drag is real. Capturing on the press would
      // send the click to the surface instead of the node under it.
      if (typeof event.currentTarget.setPointerCapture === 'function') {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    }
    drag.x = event.clientX;
    drag.y = event.clientY;
    onTransform((current) => panBy(current, dx, dy));
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    if (drag.moved && typeof event.currentTarget.releasePointerCapture === 'function') {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    onSelect(nodeIdAt(event.target));
  }

  function handleDoubleClick(event: MouseEvent<HTMLDivElement>) {
    const id = nodeIdAt(event.target);
    const node = view.nodes.find((item) => item.id === id);
    if (node !== undefined) {
      onOpen(node);
    }
  }

  return (
    <div
      ref={surfaceRef}
      className="graph-surface"
      role="group"
      aria-label={label}
      tabIndex={0}
      data-selecting={near !== null}
      data-detail={detail}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onPointerOver={(event) => {
        hover(nodeIdAt(event.target));
      }}
      onPointerLeave={() => {
        hover(null);
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      <svg className="graph-svg" width="100%" height="100%">
        <g
          transform={`translate(${String(transform.x)} ${String(transform.y)}) scale(${String(transform.k)})`}
        >
          <Scene
            view={view}
            selectedId={selectedId}
            near={near}
            lens={lens}
            fresh={fresh}
            minFont={minFont}
            codes={codes}
            labels={labels}
          />
        </g>
      </svg>
    </div>
  );
}
