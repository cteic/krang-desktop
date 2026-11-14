import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';

import type { GraphContent } from '../../workspace/model';
import { useDebugSnapshot } from '../debug-snapshot';
import type { PaneProps } from '../pane-props';

import { debugText } from './debug-text';
import { fitTransform, IDENTITY, revealRect } from './geometry';
import type { Size, Transform } from './geometry';
import { GraphCanvas } from './graph-canvas';
import './graph-pane.css';
import { keyAction } from './keys';
import type { KeyAction } from './keys';
import { moveSelection, neighbourhood, stepSelection } from './selection';
import { countsText, statusText } from './status';
import { errorText, fetchFingerprint, fetchGraph } from './vault-graph';
import type { VaultGraph } from './vault-graph';
import {
  ALL_VIEW,
  buildView,
  legendOf,
  resolveViewKey,
  viewBounds,
  viewOptions,
  withoutTypes,
} from './view-model';
import type { ViewNode } from './view-model';

/** How often the pane asks whether the vault has changed. */
const POLL_MS = 2500;
const NOTICE_MS = 2500;
const NO_TYPES: ReadonlySet<string> = new Set();

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
  const [fitted, setFitted] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftPath, setDraftPath] = useState('');

  const rootRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const pollingRef = useRef(false);
  const noticeTimerRef = useRef<number | null>(null);
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
    setFitted(null);
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
    };
  }, []);

  const options = useMemo(() => (graph === null ? [] : viewOptions(graph)), [graph]);
  const viewKey = graph === null ? ALL_VIEW : resolveViewKey(graph, chosenView);
  const fullView = useMemo(
    () => (graph === null ? null : buildView(graph, viewKey, pageId)),
    [graph, viewKey, pageId],
  );
  const legend = useMemo(
    () => (graph === null || fullView === null ? [] : legendOf(graph, fullView)),
    [graph, fullView],
  );
  const view = useMemo(
    () => (fullView === null ? null : withoutTypes(fullView, hidden)),
    [fullView, hidden],
  );
  const selected = view?.nodes.find((node) => node.id === selectedId) ?? null;
  const near = useMemo(
    () => (view === null || selected === null ? null : neighbourhood(view.edges, selected.id)),
    [view, selected],
  );

  // Fit once per vault, view and page: on the first drawing, not on a refresh.
  const fitToken =
    graph === null || fullView === null
      ? null
      : `${graph.directory}\n${fullView.key}\n${fullView.pageId ?? ''}`;
  useEffect(() => {
    if (fullView === null || fitToken === null || fitted === fitToken) {
      return;
    }
    // A pane in a tab that is not showing has no size yet. It fits when it does.
    if (size.w <= 0 || size.h <= 0) {
      return;
    }
    setTransform(fitTransform(viewBounds(fullView), size));
    setFitted(fitToken);
  }, [fullView, fitToken, fitted, size]);

  const hasDrawing = view !== null && graph?.message === null;
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

  useDebugSnapshot(name, debug, () =>
    debugText(graph?.directory ?? directory ?? '', view, failure ?? graph?.message ?? null),
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
    load(directory, { quiet: false, fingerprint: null });
  }

  function fit() {
    if (view !== null) {
      setTransform(fitTransform(viewBounds(view), size));
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

  const shownPath = graph?.directory ?? directory;
  const status = notice ?? statusText({ graph, view, loading, stale });

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
      <div className="graph-body">
        {view !== null && graph?.message === null ? (
          <GraphCanvas
            view={view}
            transform={transform}
            selectedId={selected?.id ?? null}
            near={near}
            label={`Graph of ${shownPath}, ${view.label}`}
            surfaceRef={surfaceRef}
            onSelect={setSelectedId}
            onOpen={openNode}
            onTransform={setTransform}
            onResize={setSize}
          />
        ) : null}
        {graph === null && failure === null ? <p className="graph-state">Loading...</p> : null}
        {graph !== null && graph.message !== null ? (
          <p className="graph-state">{graph.message}</p>
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
      <div className="graph-footer" role="status">
        {status}
      </div>
    </div>
  );
}
