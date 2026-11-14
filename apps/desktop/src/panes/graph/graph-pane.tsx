import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';

import type { GraphContent } from '../../workspace/model';
import { useDebugSnapshot } from '../debug-snapshot';
import type { PaneProps } from '../pane-props';

import { groupCandidates } from './candidates';
import { nodeColor, textColorOn } from './colors';
import { debugText } from './debug-text';
import { centerOn, fitTransform, IDENTITY, revealRect } from './geometry';
import type { Size, Transform } from './geometry';
import { GraphCanvas } from './graph-canvas';
import './graph-pane.css';
import { buildIssues, issueCount } from './issues';
import { keyAction } from './keys';
import type { KeyAction } from './keys';
import { DEFAULT_LAYOUT, nextLayout } from './layout';
import type { KeptLayout } from './layout';
import { buildLens } from './lens';
import type { SupportStatus } from './lens';
import { readoutOf } from './readout';
import { moveSelection, neighbourhood, stepSelection } from './selection';
import { CandidatesPanel, ClaimsPanel, IssuesPanel } from './side-panels';
import type { TypeLook } from './side-panels';
import { countsText, statusText } from './status';
import { errorText, fetchFingerprint, fetchGraph } from './vault-graph';
import type { VaultGraph } from './vault-graph';
import {
  ALL_VIEW,
  buildView,
  canvasTextFloor,
  fitCap,
  layoutInput,
  legendOf,
  resolveViewKey,
  splitTitle,
  viewBounds,
  viewOptions,
  withoutTypes,
  withoutUnlinked,
} from './view-model';
import type { ViewNode } from './view-model';

/** How often the pane asks whether the vault has changed. */
const POLL_MS = 2500;
const NOTICE_MS = 2500;
/** How long a node that has just appeared stays picked out. */
const FRESH_MS = 4000;
/** The space left around the drawing when it is fitted to the pane. */
const FIT_MARGIN = 14;
const NO_TYPES: ReadonlySet<string> = new Set();
const NO_IDS: ReadonlySet<string> = new Set();

type Panel = 'claims' | 'candidates' | 'issues';

/**
 * The pane's shape in half-octave steps, so the layout is packed again
 * only when the pane changes shape by a lot. Null for a pane with no size.
 */
function aspectOf(size: Size): number | null {
  if (size.w <= 0 || size.h <= 0) {
    return null;
  }
  return 2 ** (Math.round(Math.log2(size.w / size.h) * 2) / 2);
}

interface LoadOptions {
  /** True for a check in the background, which shows no "Loading". */
  quiet: boolean;
  /** The vault's fingerprint, when the caller has just asked for it. */
  fingerprint: string | null;
}

export function GraphPane({ name, content, active, debug, actions }: PaneProps<GraphContent>) {
  const directory = content.directory;

  const [graph, setGraph] = useState<VaultGraph | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [loading, setLoading] = useState(directory !== null);
  const [chosenView, setChosenView] = useState(content.view);
  const [pageId, setPageId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(NO_TYPES);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  // True while the drawing is kept fitted to the pane. Panning or zooming
  // by hand turns it off, and Fit turns it on again.
  const [auto, setAuto] = useState(true);
  // The room for the drawing and the list beside it together. The layout
  // is shaped for this, so opening a list does not move the nodes.
  const [room, setRoom] = useState<Size>({ w: 0, h: 0 });
  const [layoutRound, setLayoutRound] = useState(0);
  const [showUnlinked, setShowUnlinked] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(NO_IDS);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftPath, setDraftPath] = useState('');

  const rootRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  // The pane shape the layout was last made for.
  const aspectRef = useRef<number | null>(null);
  const requestRef = useRef(0);
  const pollingRef = useRef(false);
  const noticeTimerRef = useRef<number | null>(null);
  const freshTimerRef = useRef<number | null>(null);
  // The layout on screen. A changed graph is laid out around it, so the
  // nodes already placed stay where they are.
  const layoutRef = useRef<KeptLayout | null>(null);
  // The nodes of the view as last drawn, to tell which ones are new.
  const drawnRef = useRef<{
    token: string;
    ids: ReadonlySet<string>;
    unlinked: ReadonlySet<string>;
  } | null>(null);
  // The fingerprint of the vault as last read. Null means "read it again".
  const fingerprintRef = useRef<string | null>(null);
  // True once a graph has been read with every file in order. From then on
  // a read that hits a half-written file keeps that graph on screen.
  const hasGoodRef = useRef(false);
  // The graph on screen as text, so a read that changes nothing redraws nothing.
  const shownRef = useRef<string | null>(null);

  const load = useCallback((target: string, options: LoadOptions) => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    if (!options.quiet) {
      setLoading(true);
    }
    const fingerprint =
      options.fingerprint === null
        ? fetchFingerprint(target)
        : Promise.resolve(options.fingerprint);
    // The fingerprint is taken before the graph is read. A change that
    // lands between the two then shows up as a new fingerprint next time.
    fingerprint
      .then(async (print) => ({ print, next: await fetchGraph(target) }))
      .then(
        ({ print, next }) => {
          if (requestRef.current !== request) {
            return;
          }
          setLoading(false);
          setFailure(null);
          if (next.incomplete) {
            fingerprintRef.current = null;
            if (hasGoodRef.current) {
              setStale(next.warnings[0] ?? 'A file in the vault could not be read.');
              return;
            }
          } else {
            fingerprintRef.current = print;
            hasGoodRef.current = true;
          }
          setStale(null);
          const text = JSON.stringify(next);
          if (text !== shownRef.current) {
            shownRef.current = text;
            setGraph(next);
          }
        },
        (reason: unknown) => {
          if (requestRef.current !== request) {
            return;
          }
          setLoading(false);
          fingerprintRef.current = null;
          if (hasGoodRef.current || shownRef.current !== null) {
            setStale(errorText(reason));
          } else {
            setFailure(errorText(reason));
          }
        },
      );
  }, []);

  useEffect(() => {
    requestRef.current += 1;
    fingerprintRef.current = null;
    hasGoodRef.current = false;
    shownRef.current = null;
    setGraph(null);
    setFailure(null);
    setStale(null);
    setHidden(NO_TYPES);
    setSelectedId(null);
    setPageId(null);
    setAuto(true);
    setShowUnlinked(false);
    setHoverId(null);
    setFresh(NO_IDS);
    layoutRef.current = null;
    aspectRef.current = null;
    drawnRef.current = null;
    setLoading(directory !== null);
    if (directory !== null) {
      load(directory, { quiet: false, fingerprint: null });
    }
  }, [directory, load]);

  useEffect(() => {
    if (directory === null) {
      return;
    }
    const timer = window.setInterval(() => {
      if (pollingRef.current) {
        return;
      }
      pollingRef.current = true;
      const request = requestRef.current;
      fetchFingerprint(directory)
        .then(
          (print) => {
            if (requestRef.current === request && print !== fingerprintRef.current) {
              load(directory, { quiet: true, fingerprint: print });
            }
          },
          () => {
            // The read reports what is wrong, and keeps the last graph.
            if (requestRef.current === request) {
              load(directory, { quiet: true, fingerprint: null });
            }
          },
        )
        .finally(() => {
          pollingRef.current = false;
        });
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [directory, load]);

  useEffect(() => {
    setChosenView(content.view);
  }, [content.view]);

  useEffect(() => {
    return () => {
      // A reply that lands after the pane has gone is dropped.
      requestRef.current += 1;
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
      }
      if (freshTimerRef.current !== null) {
        window.clearTimeout(freshTimerRef.current);
      }
    };
  }, []);

  // The layout follows the pane's shape only while the drawing is kept
  // fitted. Once the person has moved it, it stays as it is.
  const measured = aspectOf(room);
  if (auto && measured !== null) {
    aspectRef.current = measured;
  }
  const aspect = aspectRef.current;

  const options = useMemo(() => (graph === null ? [] : viewOptions(graph)), [graph]);
  const viewKey = graph === null ? ALL_VIEW : resolveViewKey(graph, chosenView);
  // Laid out here, once per graph and pane shape, and not on every drawing.
  // A graph that reads the same as the last one gives the same layout back.
  const placed = useMemo(() => {
    if (graph === null || viewKey !== ALL_VIEW) {
      return null;
    }
    const input = layoutInput(graph);
    const layout = nextLayout(
      layoutRef.current,
      input.nodes,
      input.edges,
      aspect === null ? DEFAULT_LAYOUT : { ...DEFAULT_LAYOUT, aspect },
    );
    layoutRef.current = layout;
    return layout.rects;
    // `layoutRound` is here so Reload lays the graph out afresh.
  }, [graph, viewKey, aspect, layoutRound]);
  const baseView = useMemo(
    () => (graph === null ? null : buildView(graph, viewKey, pageId, placed)),
    [graph, viewKey, pageId, placed],
  );
  // The text of a canvas box shrinks to fit its box, but only as far as
  // can still be read with the canvas fitted to the pane.
  const textFloor = useMemo(() => {
    if (baseView === null || baseView.key === ALL_VIEW || size.w <= 0 || size.h <= 0) {
      return null;
    }
    const fitted = fitTransform(viewBounds(baseView), size, FIT_MARGIN, fitCap(baseView));
    return canvasTextFloor(fitted.k);
  }, [baseView, size]);
  const fullView = useMemo(
    () =>
      graph === null || textFloor === null
        ? baseView
        : buildView(graph, viewKey, pageId, placed, textFloor),
    [graph, baseView, viewKey, pageId, placed, textFloor],
  );
  const linkedView = useMemo(() => {
    if (fullView === null) {
      return null;
    }
    return showUnlinked ? fullView : withoutUnlinked(fullView);
  }, [fullView, showUnlinked]);
  const legend = useMemo(
    () => (graph === null || linkedView === null ? [] : legendOf(graph, linkedView)),
    [graph, linkedView],
  );
  const view = useMemo(
    () => (linkedView === null ? null : withoutTypes(linkedView, hidden)),
    [linkedView, hidden],
  );
  const selected = view?.nodes.find((node) => node.id === selectedId) ?? null;
  const near = useMemo(
    () => (view === null || selected === null ? null : neighbourhood(view.edges, selected.id)),
    [view, selected],
  );

  const lens = useMemo(() => (graph === null ? null : buildLens(graph)), [graph]);
  const candidates = useMemo(() => (graph === null ? [] : groupCandidates(graph)), [graph]);
  const candidateCount = graph?.candidates.length ?? 0;
  const issues = useMemo(() => (graph === null ? [] : buildIssues(graph)), [graph]);
  const issueTotal = issueCount(issues);
  const looks = useMemo(() => {
    const map = new Map<string, TypeLook>();
    for (const type of graph?.nodeTypes ?? []) {
      const fill = nodeColor(type.color);
      map.set(type.id, {
        fill,
        ink: textColorOn(fill),
        chip: splitTitle(type.format.replace('{content}', 'x'), type.format).chip ?? type.name,
        strip: (title) => splitTitle(title, type.format).text,
      });
    }
    return map;
  }, [graph]);
  // How well each claim on show is backed, by the id of its box. A canvas
  // box has an id of its own, so there it is matched by its note.
  const lensById = useMemo(() => {
    if (panel !== 'claims' || lens === null || fullView === null) {
      return null;
    }
    // With nothing to count, no claim has a status and no box is marked.
    const byId = new Map<string, SupportStatus>();
    const byPath = new Map<string, SupportStatus>();
    for (const row of lens.rows) {
      if (row.status !== null) {
        byId.set(row.id, row.status);
        byPath.set(row.path, row.status);
      }
    }
    if (fullView.key === ALL_VIEW) {
      return byId;
    }
    const onCanvas = new Map<string, SupportStatus>();
    for (const node of fullView.nodes) {
      const status = node.path === null ? undefined : byPath.get(node.path);
      if (status !== undefined) {
        onCanvas.set(node.id, status);
      }
    }
    return onCanvas;
  }, [panel, lens, fullView]);

  const viewToken =
    graph === null || fullView === null
      ? null
      : `${graph.directory}\n${fullView.key}\n${fullView.pageId ?? ''}`;
  // Another vault, view or page starts fitted to the pane again.
  useEffect(() => {
    setAuto(true);
  }, [viewToken]);

  // While the drawing is kept fitted, it is fitted again whenever what is
  // drawn or the pane's size changes.
  const bounds = useMemo(() => (view === null ? null : viewBounds(view)), [view]);
  const cap = view === null ? 1 : fitCap(view);
  useLayoutEffect(() => {
    // A pane in a tab that is not showing has no size yet. It fits when it does.
    if (!auto || bounds === null || size.w <= 0 || size.h <= 0) {
      return;
    }
    setTransform(fitTransform(bounds, size, FIT_MARGIN, cap));
  }, [auto, bounds, size, cap]);

  // Picks out, for a few seconds, the nodes a refresh has added: the ones
  // that are new, and the ones that have just gained their first relation.
  useEffect(() => {
    if (fullView === null || viewToken === null) {
      drawnRef.current = null;
      return;
    }
    const before = drawnRef.current;
    drawnRef.current = {
      token: viewToken,
      ids: new Set(fullView.nodes.map((node) => node.id)),
      unlinked: fullView.unlinked,
    };
    if (before === null || before.token !== viewToken) {
      return;
    }
    const added = fullView.nodes
      .filter(
        (node) =>
          !before.ids.has(node.id) ||
          (before.unlinked.has(node.id) && !fullView.unlinked.has(node.id)),
      )
      .map((node) => node.id);
    if (added.length === 0) {
      return;
    }
    setFresh(new Set(added));
    if (freshTimerRef.current !== null) {
      window.clearTimeout(freshTimerRef.current);
    }
    freshTimerRef.current = window.setTimeout(() => {
      freshTimerRef.current = null;
      setFresh(NO_IDS);
    }, FRESH_MS);
  }, [fullView, viewToken]);

  // A vault that is set up and holds no node yet has nothing to draw.
  const noNodes =
    graph !== null && graph.message === null && viewKey === ALL_VIEW && graph.nodes.length === 0;
  const hasDrawing = view !== null && graph?.message === null && !noNodes;
  useEffect(() => {
    if (!active || !hasDrawing) {
      return;
    }
    const focused = document.activeElement;
    const inPane = focused !== null && rootRef.current?.contains(focused) === true;
    if (!inPane) {
      surfaceRef.current?.focus({ preventScroll: true });
    }
  }, [active, hasDrawing]);

  const unlinkedCount = fullView?.unlinked.size ?? 0;
  useDebugSnapshot(name, debug, () =>
    debugText(
      graph?.directory ?? directory ?? '',
      view,
      failure ?? graph?.message ?? null,
      lens === null
        ? null
        : {
            unlinkedHidden: showUnlinked ? 0 : unlinkedCount,
            claims: lens.rows.length,
            supportCounted: lens.counted,
            unsupported: lens.unsupported,
            opposed: lens.opposed,
            contested: lens.contested,
            supported: lens.supported,
            candidates: candidateCount,
            issues: issueTotal,
          },
    ),
  );

  function showNotice(text: string) {
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
    }
    setNotice(text);
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null;
      setNotice(null);
    }, NOTICE_MS);
  }

  function reload() {
    if (directory === null) {
      return;
    }
    // Asked for by hand, so whatever can be read now is shown, even when a
    // file is still broken.
    hasGoodRef.current = false;
    // And the graph is laid out afresh, not around the picture on screen.
    layoutRef.current = null;
    setLayoutRound((round) => round + 1);
    load(directory, { quiet: false, fingerprint: null });
  }

  function fit() {
    if (view !== null) {
      setAuto(true);
      setTransform(fitTransform(viewBounds(view), size, FIT_MARGIN, fitCap(view)));
    }
  }

  /** A pan or zoom made by hand, which ends the fitting to the pane. */
  function moveByHand(change: (current: Transform) => Transform) {
    setAuto(false);
    setTransform(change);
  }

  function handleResize(next: Size) {
    setSize(next);
    const main = mainRef.current;
    setRoom(main === null ? next : { w: main.clientWidth, h: main.clientHeight });
  }

  function togglePanel(next: Panel) {
    setPanel((current) => (current === next ? null : next));
  }

  function openNote(path: string) {
    actions.openPane({ type: 'editor', path });
  }

  /**
   * Selects a node of the vault from one of the lists and brings it to the
   * middle of the drawing. A node that is hidden is shown first.
   */
  function focusNode(id: string) {
    const wanted = graph?.nodes.find((node) => node.id === id);
    if (wanted === undefined || fullView === null) {
      return;
    }
    const node =
      fullView.key === ALL_VIEW
        ? fullView.nodes.find((item) => item.id === id)
        : fullView.nodes.find((item) => item.path === wanted.path);
    if (node === undefined) {
      showNotice(`"${wanted.title}" is not on this canvas. All nodes shows it.`);
      return;
    }
    if (fullView.unlinked.has(node.id)) {
      setShowUnlinked(true);
    }
    if (hidden.has(node.typeId)) {
      setHidden((current) => {
        const next = new Set(current);
        next.delete(node.typeId);
        return next;
      });
    }
    setSelectedId(node.id);
    if (size.w > 0 && size.h > 0) {
      setAuto(false);
      setTransform((current) => centerOn(current, node.rect, size));
    }
  }

  function chooseView(key: string) {
    const next = key === ALL_VIEW ? null : key;
    setChosenView(next);
    setPageId(null);
    setSelectedId(null);
    if (directory !== null && next !== content.view) {
      actions.replaceContent({ type: 'graph', directory, view: next });
    }
  }

  function choosePage(id: string) {
    setPageId(id);
    setSelectedId(null);
  }

  function toggleType(typeId: string) {
    setHidden((current) => {
      const next = new Set(current);
      if (!next.delete(typeId)) {
        next.add(typeId);
      }
      return next;
    });
  }

  function openNode(node: ViewNode) {
    if (node.path === null) {
      showNotice(`No note named "${node.title}" in this vault.`);
      return;
    }
    actions.openPane({ type: 'editor', path: node.path });
  }

  function selectByKey(id: string | null) {
    setSelectedId(id);
    const node = view?.nodes.find((item) => item.id === id);
    if (node !== undefined) {
      setTransform((current) => revealRect(current, node.rect, size));
    }
  }

  /** Returns false when the key should carry on to the browser. */
  function perform(action: KeyAction): boolean {
    if (view === null) {
      return false;
    }
    switch (action) {
      case 'left':
      case 'right':
      case 'up':
      case 'down':
        selectByKey(moveSelection(view.nodes, selected?.id ?? null, action));
        return true;
      case 'next':
      case 'previous': {
        const next = stepSelection(view.nodes, selected?.id ?? null, action === 'next' ? 1 : -1);
        selectByKey(next);
        // Past the last node, Tab moves on to the next control.
        return next !== null;
      }
      case 'open':
        if (selected !== null) {
          openNode(selected);
        }
        return selected !== null;
      case 'clear':
        setSelectedId(null);
        return true;
      case 'fit':
        fit();
        return true;
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Keys pressed on a button or a list keep their usual meaning.
    if (!active || event.target !== surfaceRef.current) {
      return;
    }
    const action = keyAction(event);
    if (action !== null && perform(action)) {
      event.preventDefault();
    }
  }

  function handleOpenVault(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const path = draftPath.trim();
    if (path !== '') {
      actions.replaceContent({ type: 'graph', directory: path, view: null });
    }
  }

  if (directory === null) {
    return (
      <div className="graph-pane" ref={rootRef}>
        <div className="graph-body">
          <div className="graph-state">
            <p>
              Open a notes vault that uses the Discourse Graphs plugin for Obsidian to see its
              questions, claims and evidence as a graph.
            </p>
            <form className="graph-open" onSubmit={handleOpenVault}>
              <input
                type="text"
                aria-label="Vault folder"
                placeholder="~/notes/my-vault"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                value={draftPath}
                onChange={(event) => {
                  setDraftPath(event.target.value);
                }}
              />
              <button type="submit">Open</button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  const shownPath = directory ?? graph?.directory ?? null;
  const status = notice ?? statusText({ graph, loading, stale });
  const hasGraph = view !== null && graph?.message === null;
  const pointed = view?.nodes.find((node) => node.id === hoverId) ?? selected;
  const readout =
    view === null || pointed === null || notice !== null || stale !== null
      ? null
      : readoutOf(
          view,
          pointed,
          graph?.nodeTypes.find((type) => type.id === pointed.typeId)?.name ?? 'Unknown type',
        );
  const freshUnlinked =
    !showUnlinked && fullView !== null && [...fresh].some((id) => fullView.unlinked.has(id));

  return (
    <div className="graph-pane" ref={rootRef} onKeyDown={handleKeyDown}>
      <div className="graph-header">
        <span className="graph-path" title={shownPath}>
          {shownPath}
        </span>
        <select
          aria-label="View"
          value={viewKey}
          disabled={graph === null}
          onChange={(event) => {
            chooseView(event.target.value);
          }}
        >
          {options.length === 0 ? <option value={ALL_VIEW}>All nodes</option> : null}
          {options.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
        {fullView !== null && fullView.pages.length > 1 ? (
          <select
            aria-label="Page"
            value={fullView.pageId ?? ''}
            onChange={(event) => {
              choosePage(event.target.value);
            }}
          >
            {fullView.pages.map((page) => (
              <option key={page.id} value={page.id}>
                {page.name}
              </option>
            ))}
          </select>
        ) : null}
        {hasGraph ? (
          <div className="graph-toggles" role="group" aria-label="Lists and filters">
            <button
              type="button"
              aria-pressed={panel === 'claims'}
              title="How well each claim is supported by evidence"
              onClick={() => {
                togglePanel('claims');
              }}
            >
              Claims
            </button>
            <button
              type="button"
              aria-pressed={panel === 'candidates'}
              title="Lines tagged to become nodes"
              onClick={() => {
                togglePanel('candidates');
              }}
            >
              Candidates ({candidateCount})
            </button>
            {unlinkedCount === 0 ? null : (
              <button
                type="button"
                aria-pressed={showUnlinked}
                data-fresh={freshUnlinked ? 'true' : undefined}
                title={
                  showUnlinked
                    ? 'Hide the nodes that have no relations'
                    : 'Show the nodes that have no relations'
                }
                onClick={() => {
                  setShowUnlinked((current) => !current);
                }}
              >
                Unlinked ({unlinkedCount})
              </button>
            )}
            <button
              type="button"
              aria-pressed={panel === 'issues'}
              data-quiet={issueTotal === 0}
              title="What was left out of the picture or may be drawn wrong"
              onClick={() => {
                togglePanel('issues');
              }}
            >
              Issues ({issueTotal})
            </button>
          </div>
        ) : null}
        {view === null ? null : (
          <span className="graph-counts" title={view.skippedNote}>
            {countsText(view)}
          </span>
        )}
        <button
          type="button"
          aria-label="Fit"
          title="Fit the graph in the pane (F)"
          disabled={view === null}
          onClick={fit}
        >
          ⤢
        </button>
        <button type="button" aria-label="Reload" title="Reload" onClick={reload}>
          ↻
        </button>
      </div>
      {legend.length === 0 ? null : (
        <div className="graph-legend" role="group" aria-label="Node types">
          {legend.map((entry) => (
            <button
              type="button"
              key={entry.typeId}
              aria-pressed={!hidden.has(entry.typeId)}
              title={hidden.has(entry.typeId) ? `Show ${entry.name}` : `Hide ${entry.name}`}
              onClick={() => {
                toggleType(entry.typeId);
              }}
            >
              <span className="graph-swatch" style={{ background: entry.fill }} />
              {entry.name}
              <span className="graph-legend-count">{entry.count}</span>
            </button>
          ))}
        </div>
      )}
      <div className="graph-main" ref={mainRef}>
        <div className="graph-body">
          {view !== null && hasDrawing ? (
            <GraphCanvas
              view={view}
              transform={transform}
              selectedId={selected?.id ?? null}
              near={near}
              lens={lensById}
              fresh={fresh}
              label={`Graph of ${shownPath}, ${view.label}`}
              surfaceRef={surfaceRef}
              onSelect={setSelectedId}
              onOpen={openNode}
              onHover={setHoverId}
              onTransform={moveByHand}
              onResize={handleResize}
            />
          ) : null}
          {graph === null && failure === null ? <p className="graph-state">Loading...</p> : null}
          {noNodes && failure === null ? (
            <div className="graph-state graph-empty">
              <p className="graph-empty-title">No nodes yet</p>
              <ul className="graph-empty-ways" aria-label="Ways to add a node">
                <li>Ask the agent in the chat pane to use the discourse-graph skill on a note.</li>
                <li>Select text in the editor and choose Node.</li>
                <li>
                  Run <code>kd node claim &quot;...&quot;</code> in the shell.
                </li>
              </ul>
            </div>
          ) : null}
          {graph !== null && graph.message !== null ? (
            <div className="graph-state graph-empty">
              <p className="graph-empty-title">This folder is not a vault</p>
              <p>{graph.message}</p>
              <p>
                To make one, run <code>kd vault init &lt;folder&gt;</code> in the shell.
              </p>
            </div>
          ) : null}
          {failure === null ? null : (
            <div className="graph-state" role="alert">
              <p>This vault could not be read.</p>
              <pre className="graph-error-text">{failure}</pre>
              <button type="button" onClick={reload}>
                Retry
              </button>
            </div>
          )}
        </div>
        {hasGraph && panel === 'claims' && lens !== null ? (
          <ClaimsPanel
            lens={lens}
            looks={looks}
            selectedId={
              selected === null
                ? null
                : (lens.rows.find((row) => row.id === selected.id || row.path === selected.path)
                    ?.id ?? null)
            }
            onSelect={focusNode}
            onOpen={openNote}
          />
        ) : null}
        {hasGraph && panel === 'candidates' ? (
          <CandidatesPanel groups={candidates} onOpen={openNote} />
        ) : null}
        {hasGraph && panel === 'issues' ? <IssuesPanel groups={issues} onOpen={openNote} /> : null}
      </div>
      <div className="graph-footer">
        {readout === null ? null : (
          <div className="graph-readout" aria-label="Node under the pointer">
            <span className="graph-type-chip" style={{ background: readout.fill }}>
              {readout.typeName}
            </span>
            <span className="graph-readout-title" title={readout.title}>
              {readout.title}
            </span>
            <span className="graph-readout-relations">{readout.relations}</span>
          </div>
        )}
        <div className="graph-status" role="status" data-covered={readout !== null}>
          {status}
        </div>
      </div>
    </div>
  );
}
