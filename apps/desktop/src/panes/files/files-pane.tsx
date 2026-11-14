import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';

import type { FilesContent } from '../../workspace/model';
import { useDebugSnapshot } from '../debug-snapshot';
import type { PaneProps } from '../pane-props';

import { columnsFor, isNarrowHeader } from './columns';
import type { Columns } from './columns';
import { debugText } from './debug-text';
import { DEFAULT_SORT, emptyMessage, nextSort, summaryText, visibleEntries } from './entries';
import type { SortKey, SortState } from './entries';
import './files-pane.css';
import { formatModified, formatSize } from './format';
import { keyAction } from './keys';
import type { KeyAction, KeySource } from './keys';
import { errorText, fetchListing } from './listing';
import type { FileEntry, Listing } from './listing';
import { isHtmlPath, lexicalParent, localFileUrl, splitBreadcrumbs } from './paths';

const NOTICE_MS = 2500;

interface LoadFailure {
  message: string;
  /** The directory that failed. Null when it was the home directory. */
  path: string | null;
}

interface LoadOptions {
  /** The entry to select once the directory shows. Null selects the first row. */
  select: string | null;
  /** True when the person asked to go there, so the pane's content follows. */
  navigate: boolean;
}

interface SortHeaderProps {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  colSpan?: number;
  onSort: (key: SortKey) => void;
}

function SortHeader({ label, sortKey, sort, colSpan = 1, onSort }: SortHeaderProps) {
  const sorted = sort.key === sortKey;
  const ascending = sort.direction === 'asc';
  const ariaSort = ascending ? 'ascending' : 'descending';
  return (
    <th scope="col" colSpan={colSpan} aria-sort={sorted ? ariaSort : 'none'}>
      <button
        type="button"
        className="files-sort"
        title={`Sort by ${label.toLowerCase()}`}
        onClick={() => {
          onSort(sortKey);
        }}
      >
        {label}
        {sorted ? (
          <span className="files-sort-mark" aria-hidden="true">
            {ascending ? '▲' : '▼'}
          </span>
        ) : null}
      </button>
    </th>
  );
}

interface EntryRowProps {
  id: string;
  entry: FileEntry;
  selected: boolean;
  columns: Columns;
  onSelect: (entry: FileEntry) => void;
  onOpen: (entry: FileEntry) => void;
  onOpenWeb: (entry: FileEntry) => void;
  onOpenTerminal: (entry: FileEntry) => void;
  onCopyPath: (entry: FileEntry) => void;
}

function EntryRow({
  id,
  entry,
  selected,
  columns,
  onSelect,
  onOpen,
  onOpenWeb,
  onOpenTerminal,
  onCopyPath,
}: EntryRowProps) {
  function handleDoubleClick(event: MouseEvent<HTMLTableRowElement>) {
    // A fast double press on a row button is two presses, not an open.
    if (event.target instanceof Element && event.target.closest('button') !== null) {
      return;
    }
    onOpen(entry);
  }

  return (
    <tr
      id={id}
      className="files-row"
      aria-selected={selected}
      data-dir={entry.isDir}
      onClick={() => {
        onSelect(entry);
      }}
      onDoubleClick={handleDoubleClick}
    >
      <td className="files-kind">
        <span role="img" aria-label={entry.isDir ? 'Folder' : 'File'}>
          {entry.isDir ? '▸' : '·'}
        </span>
      </td>
      <th scope="row" className="files-name" title={entry.path}>
        {entry.name}
      </th>
      {columns.size ? (
        <td className="files-size">{entry.isDir ? '' : formatSize(entry.size)}</td>
      ) : null}
      {columns.modified ? (
        <td className="files-modified">{formatModified(entry.modifiedMs)}</td>
      ) : null}
      <td className="files-actions">
        {entry.isDir ? (
          <button
            type="button"
            aria-label="Open terminal here"
            title="Open terminal here"
            onClick={() => {
              onOpenTerminal(entry);
            }}
          >
            &gt;_
          </button>
        ) : null}
        {!entry.isDir && isHtmlPath(entry.path) ? (
          <button
            type="button"
            aria-label="Open in web pane"
            title="Open in web pane (Cmd+Enter)"
            onClick={() => {
              onOpenWeb(entry);
            }}
          >
            ↗
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Copy path"
          title="Copy path"
          onClick={() => {
            onCopyPath(entry);
          }}
        >
          ⧉
        </button>
      </td>
    </tr>
  );
}

function keySource(target: EventTarget, filterInput: HTMLInputElement | null): KeySource {
  if (target === filterInput) {
    return 'filter';
  }
  return target instanceof HTMLButtonElement ? 'button' : 'list';
}

export function FilesPane({ name, content, active, debug, actions }: PaneProps<FilesContent>) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [notice, setNotice] = useState<string | null>(null);

  // The pane's width, which decides the columns. Null until it is measured.
  const [width, setWidth] = useState<number | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLTableElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const noticeTimerRef = useRef<number | null>(null);
  // The directory on screen. When the workspace hands the same path back as
  // `content`, after `replaceContent`, there is nothing to load again.
  const shownPathRef = useRef<string | null>(null);
  const directoryRef = useRef(content.directory);
  directoryRef.current = content.directory;
  const rowIdBase = useId();

  const load = useCallback(
    (target: string | null, options: LoadOptions) => {
      const request = requestRef.current + 1;
      requestRef.current = request;
      setLoading(true);
      fetchListing(target).then(
        (next) => {
          if (requestRef.current !== request) {
            return;
          }
          const moved = shownPathRef.current !== next.path;
          shownPathRef.current = next.path;
          setListing(next);
          setFailure(null);
          setLoading(false);
          if (moved) {
            setFilter('');
            setSelectedPath(options.select);
          }
          if (options.navigate && directoryRef.current !== next.path) {
            actions.replaceContent({ type: 'files', directory: next.path });
          }
        },
        (reason: unknown) => {
          if (requestRef.current !== request) {
            return;
          }
          shownPathRef.current = null;
          setListing(null);
          setFailure({ message: errorText(reason), path: target });
          setLoading(false);
        },
      );
    },
    [actions],
  );

  useEffect(() => {
    if (content.directory !== null && content.directory === shownPathRef.current) {
      return;
    }
    load(content.directory, { select: null, navigate: false });
  }, [content.directory, load]);

  useEffect(() => {
    return () => {
      // A reply that lands after the pane has gone is dropped.
      requestRef.current += 1;
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
      }
    };
  }, []);

  const entries = listing?.entries;
  const visible = useMemo(
    () => visibleEntries(entries ?? [], { showHidden, filter, sort }),
    [entries, showHidden, filter, sort],
  );
  const foundIndex = visible.findIndex((entry) => entry.path === selectedPath);
  const selectedIndex = visible.length === 0 ? -1 : Math.max(foundIndex, 0);
  const selected = visible[selectedIndex] ?? null;
  const selectedId = selected === null ? undefined : `${rowIdBase}-${String(selectedIndex)}`;

  const currentPath = failure?.path ?? listing?.path ?? content.directory ?? '~';
  const crumbs = splitBreadcrumbs(currentPath);
  const failedParent =
    failure === null || failure.path === null ? null : lexicalParent(failure.path);
  const parentPath = failure === null ? (listing?.parent ?? null) : failedParent;
  const message = listing === null ? null : emptyMessage(listing.entries, visible.length, filter);

  useEffect(() => {
    if (active && document.activeElement !== filterRef.current) {
      listRef.current?.focus({ preventScroll: true });
    }
  }, [active, listing, failure]);

  useEffect(() => {
    if (selectedId === undefined) {
      return;
    }
    const row = document.getElementById(selectedId);
    // Not every DOM has it: the one the tests run in does not.
    if (row !== null && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedId, selected?.path]);

  useDebugSnapshot(name, debug, () => debugText(currentPath, visible, failure?.message ?? null));

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) {
      return;
    }
    function measure() {
      if (root !== null) {
        setWidth(root.clientWidth);
      }
    }
    measure();
    // Not every DOM has it: the one the tests run in does not.
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => {
      observer.disconnect();
    };
  }, []);

  const columns = columnsFor(width);

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

  function navigateTo(path: string, select: string | null = null) {
    load(path, { select, navigate: true });
  }

  function goUp() {
    if (parentPath !== null) {
      // Coming back up, the directory just left is the one selected.
      navigateTo(parentPath, listing?.path ?? failure?.path ?? null);
    }
  }

  function refresh() {
    const target = failure === null ? (listing?.path ?? content.directory) : failure.path;
    load(target, { select: null, navigate: false });
  }

  function retry() {
    if (failure !== null) {
      load(failure.path, { select: null, navigate: true });
    }
  }

  function openEntry(entry: FileEntry) {
    if (entry.isDir) {
      navigateTo(entry.path);
    } else {
      actions.openPane({ type: 'editor', path: entry.path });
    }
  }

  function openInWeb(entry: FileEntry) {
    if (!entry.isDir && isHtmlPath(entry.path)) {
      actions.openPane({ type: 'web', url: localFileUrl(entry.path) });
    }
  }

  function openTerminal(entry: FileEntry) {
    actions.openPane(
      { type: 'terminal', directory: entry.path, commands: [] },
      { direction: 'column' },
    );
  }

  async function copyPath(entry: FileEntry) {
    try {
      await navigator.clipboard.writeText(entry.path);
      showNotice(`Copied ${entry.path}`);
    } catch (error) {
      showNotice(`Could not copy the path: ${errorText(error)}`);
    }
  }

  function selectEntry(entry: FileEntry) {
    setSelectedPath(entry.path);
  }

  function selectIndex(index: number) {
    const clamped = Math.min(Math.max(index, 0), visible.length - 1);
    const entry = visible[clamped];
    if (entry !== undefined) {
      setSelectedPath(entry.path);
    }
  }

  function clearFilter() {
    setFilter('');
    listRef.current?.focus({ preventScroll: true });
  }

  function openSelected() {
    if (failure !== null) {
      retry();
    } else if (selected !== null) {
      openEntry(selected);
    }
  }

  function perform(action: KeyAction) {
    switch (action) {
      case 'next':
        selectIndex(selectedIndex + 1);
        break;
      case 'previous':
        selectIndex(selectedIndex - 1);
        break;
      case 'first':
        selectIndex(0);
        break;
      case 'last':
        selectIndex(visible.length - 1);
        break;
      case 'open':
        openSelected();
        break;
      case 'open-web':
        if (selected !== null) {
          openInWeb(selected);
        }
        break;
      case 'parent':
        goUp();
        break;
      case 'focus-filter':
        filterRef.current?.focus();
        filterRef.current?.select();
        break;
      case 'clear-filter':
        clearFilter();
        break;
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!active) {
      return;
    }
    const action = keyAction(event, keySource(event.target, filterRef.current));
    if (action !== null) {
      event.preventDefault();
      perform(action);
    }
  }

  function handleSort(key: SortKey) {
    setSort((current) => nextSort(current, key));
  }

  function handleCopyPath(entry: FileEntry) {
    void copyPath(entry);
  }

  const summary = listing === null ? '' : summaryText(visible.length, listing.entries.length);
  const status = notice ?? (loading ? 'Loading...' : summary);

  return (
    <div
      className="files-pane"
      ref={rootRef}
      data-narrow={isNarrowHeader(width) ? 'true' : undefined}
      onKeyDown={handleKeyDown}
    >
      <div className="files-header">
        <button
          type="button"
          aria-label="Go to parent directory"
          title="Parent directory (Backspace)"
          disabled={parentPath === null}
          onClick={goUp}
        >
          ↑
        </button>
        <button type="button" aria-label="Refresh" title="Refresh" onClick={refresh}>
          ↻
        </button>
        <nav className="files-crumbs" aria-label="Path">
          {crumbs.map((crumb, index) => (
            <span className="files-crumb" key={crumb.path}>
              {index > 0 && crumbs[index - 1]?.label !== '/' ? (
                <span className="files-crumb-gap" aria-hidden="true">
                  /
                </span>
              ) : null}
              <button
                type="button"
                title={crumb.path}
                aria-current={index === crumbs.length - 1 ? 'location' : undefined}
                onClick={() => {
                  navigateTo(crumb.path);
                }}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
        <button
          type="button"
          className="files-toggle"
          aria-label="Show hidden files"
          aria-pressed={showHidden}
          title="Show hidden files"
          onClick={() => {
            setShowHidden((shown) => !shown);
          }}
        >
          .*
        </button>
        <input
          ref={filterRef}
          className="files-filter"
          type="text"
          aria-label="Filter entries"
          placeholder="Filter ( / )"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
          }}
        />
      </div>
      <div className="files-scroll">
        <table
          ref={listRef}
          className="files-table"
          role="grid"
          aria-label={`Files in ${currentPath}`}
          aria-busy={loading}
          aria-activedescendant={selectedId}
          tabIndex={0}
        >
          <colgroup>
            <col className="files-col-kind" />
            <col />
            {columns.size ? <col className="files-col-size" /> : null}
            {columns.modified ? <col className="files-col-modified" /> : null}
            <col className="files-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <SortHeader label="Name" sortKey="name" sort={sort} colSpan={2} onSort={handleSort} />
              {columns.size ? (
                <SortHeader label="Size" sortKey="size" sort={sort} onSort={handleSort} />
              ) : null}
              {columns.modified ? (
                <SortHeader label="Modified" sortKey="modified" sort={sort} onSort={handleSort} />
              ) : null}
              <th scope="col">
                <span className="files-hidden-text">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((entry, index) => (
              <EntryRow
                key={entry.path}
                id={`${rowIdBase}-${String(index)}`}
                entry={entry}
                selected={index === selectedIndex}
                columns={columns}
                onSelect={selectEntry}
                onOpen={openEntry}
                onOpenWeb={openInWeb}
                onOpenTerminal={openTerminal}
                onCopyPath={handleCopyPath}
              />
            ))}
          </tbody>
        </table>
        {listing === null && failure === null ? <p className="files-state">Loading...</p> : null}
        {message === null ? null : <p className="files-state">{message}</p>}
        {failure === null ? null : (
          <div className="files-state files-error" role="alert">
            <p>This directory could not be opened.</p>
            <pre className="files-error-text">{failure.message}</pre>
            <div className="files-error-actions">
              <button type="button" onClick={retry}>
                Retry
              </button>
              <button type="button" disabled={parentPath === null} onClick={goUp}>
                Go up
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="files-footer" role="status">
        {status}
      </div>
    </div>
  );
}
