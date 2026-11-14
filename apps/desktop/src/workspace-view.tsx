import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, PointerEvent as ReactPointerEvent } from 'react';

import { accentFor, badgeColorFor } from './accent';
import { PaneBody } from './panes/pane-body';
import type { PaneActions } from './panes/pane-props';
import { computeGeometry } from './workspace/geometry';
import type { DividerLine, Rect } from './workspace/geometry';
import { contentForSplit } from './workspace/menu-actions';
import { leavesOf, paneTitle } from './workspace/model';
import type { LeafNode, PaneContent, Tab, Workspace } from './workspace/model';
import { defaultDraft } from './workspace/reducer';
import type { WorkspaceAction } from './workspace/reducer';

export interface WorkspaceViewProps {
  workspace: Workspace;
  dispatch: Dispatch<WorkspaceAction>;
  debug: boolean;
}

interface NewPaneChoice {
  label: string;
  content: PaneContent;
}

const NEW_PANE_CHOICES: NewPaneChoice[] = [
  { label: 'Terminal', content: { type: 'terminal', directory: null, commands: [] } },
  { label: 'Files', content: { type: 'files', directory: null } },
  { label: 'Editor', content: { type: 'editor', path: null } },
  { label: 'Web', content: { type: 'web', url: '' } },
  { label: 'Chat', content: { type: 'chat', agent: null, directory: null } },
  { label: 'Graph', content: { type: 'graph', directory: null, view: null } },
];

function percent(value: number): string {
  return `${String(value * 100)}%`;
}

function rectStyle(rect: Rect) {
  return {
    left: percent(rect.x),
    top: percent(rect.y),
    width: percent(rect.w),
    height: percent(rect.h),
  };
}

/** Pane ids are `p<number>`. Creation order keeps DOM order stable. */
function creationOrder(a: LeafNode, b: LeafNode): number {
  return Number(a.id.slice(1)) - Number(b.id.slice(1));
}

export function WorkspaceView({ workspace, dispatch, debug }: WorkspaceViewProps) {
  const active = workspace.tabs.find((tab) => tab.id === workspace.activeTabId);

  return (
    <div className="workspace">
      <div className="tab-bar" role="tablist">
        {workspace.tabs.map((tab) => (
          <div
            className="tab"
            role="tab"
            key={tab.id}
            aria-selected={tab.id === workspace.activeTabId}
            style={{ borderTopColor: accentFor(tab.color) }}
            onClick={() => {
              dispatch({ type: 'activate-tab', tabId: tab.id });
            }}
          >
            <span className="tab-title">{tab.title}</span>
            {leavesOf(tab.root).some((leaf) => leaf.badge !== null) ? (
              <span className="tab-badge" aria-label="needs attention" />
            ) : null}
            <button
              className="tab-close"
              type="button"
              aria-label={`Close tab ${tab.title}`}
              onClick={(event) => {
                event.stopPropagation();
                dispatch({ type: 'close-tab', tabId: tab.id });
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          className="tab-add"
          type="button"
          aria-label="New tab"
          onClick={() => {
            dispatch({ type: 'add-tab', draft: defaultDraft() });
          }}
        >
          +
        </button>
        <div className="tab-bar-space" />
        {NEW_PANE_CHOICES.map((choice) => (
          <button
            className="new-pane"
            type="button"
            key={choice.label}
            disabled={active === undefined}
            onClick={() => {
              if (active !== undefined) {
                dispatch({
                  type: 'split',
                  paneId: active.focusedId,
                  direction: 'row',
                  content: choice.content,
                });
              }
            }}
          >
            + {choice.label}
          </button>
        ))}
      </div>
      <div className="tab-area">
        {workspace.tabs.map((tab) => (
          <TabView
            key={tab.id}
            tab={tab}
            shown={tab.id === workspace.activeTabId}
            dispatch={dispatch}
            debug={debug}
          />
        ))}
      </div>
    </div>
  );
}

interface TabViewProps {
  tab: Tab;
  shown: boolean;
  dispatch: Dispatch<WorkspaceAction>;
  debug: boolean;
}

interface Drag {
  divider: DividerLine;
  lastPosition: number;
}

function TabView({ tab, shown, dispatch, debug }: TabViewProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);

  // A click inside an embedded page never reaches this document, so the
  // usual "pointer down focuses the pane" cannot see it. What can be seen is
  // the window losing focus to a frame: that frame's pane is the one clicked.
  useEffect(() => {
    function onWindowBlur() {
      const frame = document.activeElement;
      if (!(frame instanceof HTMLIFrameElement) || areaRef.current?.contains(frame) !== true) {
        return;
      }
      const paneId = frame.closest('[data-pane-id]')?.getAttribute('data-pane-id');
      if (typeof paneId === 'string') {
        dispatch({ type: 'focus', paneId });
      }
    }
    window.addEventListener('blur', onWindowBlur);
    return () => {
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [dispatch]);

  const geometry = useMemo(() => computeGeometry(tab.root), [tab.root]);
  const leaves = useMemo(() => leavesOf(tab.root).sort(creationOrder), [tab.root]);
  const rects = useMemo(
    () => new Map(geometry.panes.map((pane) => [pane.paneId, pane.rect])),
    [geometry],
  );

  function positionOf(divider: DividerLine, event: ReactPointerEvent<HTMLDivElement>): number {
    return divider.direction === 'row' ? event.clientX : event.clientY;
  }

  function onDividerDown(divider: DividerLine, event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { divider, lastPosition: positionOf(divider, event) };
    setDragging(true);
  }

  function onDividerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const area = areaRef.current;
    if (drag === null || area === null) {
      return;
    }
    const box = area.getBoundingClientRect();
    const areaPixels = drag.divider.direction === 'row' ? box.width : box.height;
    const splitPixels = areaPixels * drag.divider.extent;
    if (splitPixels <= 0) {
      return;
    }
    const position = positionOf(drag.divider, event);
    const delta = (position - drag.lastPosition) / splitPixels;
    drag.lastPosition = position;
    dispatch({
      type: 'move-divider',
      splitId: drag.divider.splitId,
      index: drag.divider.index,
      delta,
    });
  }

  function onDividerUp(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragging(false);
  }

  return (
    <div
      className="tab-view"
      role="tabpanel"
      data-shown={shown}
      data-dragging={dragging}
      ref={areaRef}
    >
      {leaves.map((leaf) => {
        const magnified = tab.magnifiedId === leaf.id;
        const hidden = tab.magnifiedId !== null && !magnified;
        const rect = magnified ? { x: 0, y: 0, w: 1, h: 1 } : rects.get(leaf.id);
        if (rect === undefined) {
          return null;
        }
        return (
          <div
            className="pane-slot"
            key={leaf.id}
            data-hidden={hidden}
            data-magnified={magnified}
            style={rectStyle(rect)}
          >
            <PaneFrame
              leaf={leaf}
              accent={accentFor(tab.color)}
              active={shown && tab.focusedId === leaf.id}
              magnified={magnified}
              dispatch={dispatch}
              debug={debug}
            />
          </div>
        );
      })}
      {tab.magnifiedId === null
        ? geometry.dividers.map((divider) => (
            <div
              className="divider"
              role="separator"
              key={`${divider.splitId}:${String(divider.index)}`}
              data-direction={divider.direction}
              aria-orientation={divider.direction === 'row' ? 'vertical' : 'horizontal'}
              style={rectStyle(divider.rect)}
              onPointerDown={(event) => {
                onDividerDown(divider, event);
              }}
              onPointerMove={onDividerMove}
              onPointerUp={onDividerUp}
              onPointerCancel={onDividerUp}
            />
          ))
        : null}
    </div>
  );
}

interface PaneFrameProps {
  leaf: LeafNode;
  accent: string;
  active: boolean;
  magnified: boolean;
  dispatch: Dispatch<WorkspaceAction>;
  debug: boolean;
}

function PaneFrame({ leaf, accent, active, magnified, dispatch, debug }: PaneFrameProps) {
  const paneId = leaf.id;
  const title = paneTitle(leaf);

  // A pane may put a temporary title up, such as an unsaved marker, and
  // later ask for "the default" again. The default is whatever the title was
  // before the pane first changed it, which may be one a layout file set.
  const ownTitleRef = useRef<{ before: string | null } | null>(null);
  const currentTitleRef = useRef(leaf.title);
  currentTitleRef.current = leaf.title;

  const actions = useMemo<PaneActions>(
    () => ({
      openPane(content, options) {
        dispatch({
          type: 'split',
          paneId,
          direction: options?.direction ?? 'row',
          content,
          title: options?.title ?? null,
        });
      },
      replaceContent(content) {
        dispatch({ type: 'replace-content', paneId, content });
      },
      setTitle(next) {
        if (next === null) {
          const restored = ownTitleRef.current?.before ?? null;
          ownTitleRef.current = null;
          dispatch({ type: 'set-title', paneId, title: restored });
          return;
        }
        ownTitleRef.current ??= { before: currentTitleRef.current };
        dispatch({ type: 'set-title', paneId, title: next });
      },
      setBadge(badge) {
        dispatch({ type: 'set-badge', paneId, badge });
      },
      close() {
        dispatch({ type: 'close', paneId });
      },
    }),
    [dispatch, paneId],
  );

  return (
    <section
      className="pane"
      data-active={active}
      data-pane-id={paneId}
      onPointerDownCapture={() => {
        dispatch({ type: 'focus', paneId });
      }}
    >
      <header className="pane-title" style={{ background: accent }}>
        <span className="pane-title-text">{title}</span>
        {leaf.badge === null ? null : (
          <span className="pane-badge" style={{ background: badgeColorFor(leaf.badge.color) }}>
            {leaf.badge.text}
          </span>
        )}
        <span className="pane-title-space" />
        <button
          type="button"
          aria-label={`Split ${title} right`}
          title="Split right"
          onClick={() => {
            dispatch({
              type: 'split',
              paneId,
              direction: 'row',
              content: contentForSplit(leaf.content),
            });
          }}
        >
          ◫
        </button>
        <button
          type="button"
          aria-label={`Split ${title} down`}
          title="Split down"
          onClick={() => {
            dispatch({
              type: 'split',
              paneId,
              direction: 'column',
              content: contentForSplit(leaf.content),
            });
          }}
        >
          ⊟
        </button>
        <button
          type="button"
          aria-label={magnified ? `Restore ${title}` : `Magnify ${title}`}
          title={magnified ? 'Restore' : 'Magnify'}
          onClick={() => {
            dispatch({ type: 'toggle-magnify', paneId });
          }}
        >
          {magnified ? '⤡' : '⤢'}
        </button>
        <button
          type="button"
          aria-label={`Close ${title}`}
          title="Close"
          onClick={() => {
            dispatch({ type: 'close', paneId });
          }}
        >
          ×
        </button>
      </header>
      <div className="pane-body">
        <PaneBody
          paneId={paneId}
          name={`${leaf.content.type}-${paneId}`}
          content={leaf.content}
          active={active}
          debug={debug}
          actions={actions}
        />
      </div>
    </section>
  );
}
