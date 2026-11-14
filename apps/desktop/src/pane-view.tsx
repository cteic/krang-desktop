import { Fragment, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { PaneTree, SplitNode } from './layout/layout';
import { equalShares, moveDivider } from './layout/split-sizes';
import { TerminalPane } from './terminal-pane';

export interface PaneViewProps {
  node: PaneTree;
  layoutTitle: string;
  accent: string;
  focusedId: string | null;
  debug: boolean;
}

export function PaneView({ node, layoutTitle, accent, focusedId, debug }: PaneViewProps) {
  if (node.kind === 'terminal') {
    return (
      <TerminalPane
        node={node}
        title={`${layoutTitle} · ${node.id}`}
        accent={accent}
        autoFocus={node.id === focusedId}
        debug={debug}
      />
    );
  }

  return (
    <SplitView
      node={node}
      layoutTitle={layoutTitle}
      accent={accent}
      focusedId={focusedId}
      debug={debug}
    />
  );
}

interface SplitViewProps extends Omit<PaneViewProps, 'node'> {
  node: SplitNode;
}

interface Drag {
  index: number;
  lastPosition: number;
}

function SplitView({ node, layoutTitle, accent, focusedId, debug }: SplitViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [shares, setShares] = useState(() => equalShares(node.children.length));
  const [dragging, setDragging] = useState(false);
  const horizontal = node.direction === 'row';

  function positionOf(event: ReactPointerEvent<HTMLDivElement>): number {
    return horizontal ? event.clientX : event.clientY;
  }

  function onPointerDown(index: number, event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { index, lastPosition: positionOf(event) };
    setDragging(true);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const container = containerRef.current;
    if (drag === null || container === null) {
      return;
    }
    const rect = container.getBoundingClientRect();
    const extent = horizontal ? rect.width : rect.height;
    if (extent <= 0) {
      return;
    }
    const position = positionOf(event);
    const delta = (position - drag.lastPosition) / extent;
    drag.lastPosition = position;
    setShares((current) => moveDivider(current, drag.index, delta));
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragging(false);
  }

  return (
    <div
      className="split"
      data-direction={node.direction}
      data-dragging={dragging}
      ref={containerRef}
    >
      {node.children.map((child, index) => (
        <Fragment key={child.id}>
          {index === 0 ? null : (
            <div
              className="split-divider"
              role="separator"
              aria-orientation={horizontal ? 'vertical' : 'horizontal'}
              onPointerDown={(event) => {
                onPointerDown(index - 1, event);
              }}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          )}
          <div className="split-child" style={{ flexGrow: shares[index] ?? 1 }}>
            <PaneView
              node={child}
              layoutTitle={layoutTitle}
              accent={accent}
              focusedId={focusedId}
              debug={debug}
            />
          </div>
        </Fragment>
      ))}
    </div>
  );
}
