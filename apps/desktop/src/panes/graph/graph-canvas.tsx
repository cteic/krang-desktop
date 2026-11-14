import { useEffect, useLayoutEffect, useRef } from 'react';
import type { MouseEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';

import { centerOf, panBy, zoomAt } from './geometry';
import type { Size, Transform } from './geometry';
import type { Neighbourhood } from './selection';
import type { GraphView, ViewEdge, ViewNode, ViewText } from './view-model';

/** How far the pointer moves before a press becomes a drag. */
const DRAG_THRESHOLD = 4;
const WHEEL_ZOOM = 0.0015;
/** A pinch arrives as a wheel event with the control key down, in small steps. */
const PINCH_ZOOM = 0.01;
const LINE_HEIGHT = 1.25;
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
  label: string;
  surfaceRef: RefObject<HTMLDivElement | null>;
  onSelect: (id: string | null) => void;
  onOpen: (node: ViewNode) => void;
  onTransform: (change: (current: Transform) => Transform) => void;
  onResize: (size: Size) => void;
}

interface Drag {
  pointerId: number;
  x: number;
  y: number;
  moved: boolean;
}

function nodeIdAt(target: EventTarget): string | null {
  if (!(target instanceof Element)) {
    return null;
  }
  return target.closest('[data-node-id]')?.getAttribute('data-node-id') ?? null;
}

interface NodeBoxProps {
  node: ViewNode;
  selected: boolean;
  dimmed: boolean;
}

function NodeBox({ node, selected, dimmed }: NodeBoxProps) {
  const { rect } = node;
  const center = centerOf(rect);
  const step = node.fontSize * LINE_HEIGHT;
  const firstLine = center.y - ((node.lines.length - 1) * step) / 2 + node.fontSize * 0.35;
  return (
    <g
      className="graph-node"
      role="button"
      aria-label={node.title}
      aria-pressed={selected}
      data-node-id={node.id}
      data-dimmed={dimmed}
      data-unlinked={node.path === null}
    >
      <title>{node.path === null ? `${node.title} (no note with this name)` : node.title}</title>
      <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={8} fill={node.fill} />
      <text textAnchor="middle" fontSize={node.fontSize} fill={node.ink}>
        {node.lines.map((line, index) => (
          <tspan key={index} x={center.x} y={firstLine + index * step}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
}

interface EdgeLineProps {
  edge: ViewEdge;
  dimmed: boolean;
}

function EdgeLine({ edge, dimmed }: EdgeLineProps) {
  return (
    <g className="graph-edge" data-edge-id={edge.id} data-dimmed={dimmed} data-dash={edge.dash}>
      {edge.note === null ? null : <title>{edge.note}</title>}
      <path d={edge.shape.path} stroke={edge.color} strokeDasharray={DASHES[edge.dash]} />
      <polygon points={edge.shape.head} fill={edge.color} />
      {edge.label === '' ? null : (
        <text x={edge.shape.label.x} y={edge.shape.label.y} textAnchor="middle" fill={edge.color}>
          {edge.label}
        </text>
      )}
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

/** The drawing itself: boxes, lines and text, with pan and zoom. */
export function GraphCanvas({
  view,
  transform,
  selectedId,
  near,
  label,
  surfaceRef,
  onSelect,
  onOpen,
  onTransform,
  onResize,
}: GraphCanvasProps) {
  const dragRef = useRef<Drag | null>(null);
  // True from the first move of a drag until the next press, so the click
  // that ends a drag does not also change the selection.
  const draggedRef = useRef(false);
  const onTransformRef = useRef(onTransform);
  onTransformRef.current = onTransform;
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

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
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      <svg className="graph-svg" width="100%" height="100%">
        <g
          transform={`translate(${String(transform.x)} ${String(transform.y)}) scale(${String(transform.k)})`}
        >
          {view.texts.map((text) => (
            <LooseText key={text.id} text={text} />
          ))}
          {view.edges.map((edge) => (
            <EdgeLine
              key={edge.id}
              edge={edge}
              dimmed={near !== null && !near.edgeIds.has(edge.id)}
            />
          ))}
          {view.nodes.map((node) => (
            <NodeBox
              key={node.id}
              node={node}
              selected={node.id === selectedId}
              dimmed={near !== null && !near.nodeIds.has(node.id)}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}
