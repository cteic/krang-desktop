import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

import { candidateTag, filterTypes, nodeText } from './capture';
import { truncateMiddle } from './truncate-middle';
import type { NodeType } from './vault-api';

const TEXT_MAX_CHARACTERS = 90;

export interface CapturePopoverProps {
  /** The selected text the node will be made from. */
  text: string;
  /** Null while the vault's node types are being read. */
  types: NodeType[] | null;
  /** Why the types could not be read, or the node could not be made. */
  error: string | null;
  /** True while the node is being created. */
  busy: boolean;
  onCreate: (type: NodeType) => void;
  onCandidate: (type: NodeType) => void;
  onCancel: () => void;
}

/**
 * Asks which type of node the selection should become. Typing narrows the
 * list, the arrow keys move through it, Enter creates the node, Shift+Enter
 * marks the text as a candidate, and Escape closes it.
 */
export function CapturePopover({
  text,
  types,
  error,
  busy,
  onCreate,
  onCandidate,
  onCancel,
}: CapturePopoverProps) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const shown = types === null ? [] : filterTypes(types, query);
  const chosen = shown[Math.min(index, shown.length - 1)] ?? null;
  const ready = chosen !== null && !busy;

  function move(offset: 1 | -1) {
    if (shown.length > 0) {
      const from = Math.min(index, shown.length - 1);
      setIndex((from + offset + shown.length) % shown.length);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Nothing typed here is meant for the editor behind, or its shortcuts.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter' && event.target === inputRef.current) {
      event.preventDefault();
      if (chosen !== null && !busy) {
        if (event.shiftKey) {
          onCandidate(chosen);
        } else {
          onCreate(chosen);
        }
      }
    }
  }

  const tag = chosen === null ? null : candidateTag(chosen);

  return (
    <div className="editor-capture" role="dialog" aria-label="Make a node" onKeyDown={onKeyDown}>
      <div className="editor-capture-text" title={nodeText(text)}>
        {truncateMiddle(nodeText(text), TEXT_MAX_CHARACTERS)}
      </div>
      <input
        ref={inputRef}
        className="editor-capture-input"
        type="text"
        role="combobox"
        aria-label="Node type"
        aria-expanded={true}
        aria-controls={listId}
        aria-activedescendant={chosen === null ? undefined : `${listId}-${chosen.id}`}
        placeholder="Type to filter"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setIndex(0);
        }}
      />
      <ul className="editor-capture-list" id={listId} role="listbox" aria-label="Node types">
        {shown.map((type, position) => (
          <li
            key={type.id}
            id={`${listId}-${type.id}`}
            className="editor-capture-option"
            role="option"
            aria-selected={type === chosen}
            onMouseDown={(event) => {
              // Keeps the keyboard in the filter box.
              event.preventDefault();
            }}
            onClick={() => {
              setIndex(position);
            }}
          >
            <span
              className="editor-capture-dot"
              style={{ background: type.color ?? 'var(--muted)' }}
            />
            <span className="editor-capture-name">{type.name}</span>
            <span className="editor-capture-format">{type.format}</span>
          </li>
        ))}
      </ul>
      {types === null && error === null && (
        <p className="editor-capture-note">Reading node types…</p>
      )}
      {types !== null && shown.length === 0 && (
        <p className="editor-capture-note">
          {types.length === 0 ? 'This vault has no node types.' : 'No node type matches.'}
        </p>
      )}
      {error !== null && (
        <p className="editor-capture-error" role="alert">
          {error}
        </p>
      )}
      <div className="editor-capture-actions">
        <button
          className="editor-button"
          type="button"
          disabled={!ready}
          title="Enter"
          onClick={() => {
            if (chosen !== null) {
              onCreate(chosen);
            }
          }}
        >
          {busy ? 'Creating…' : 'Create node'}
        </button>
        <button
          className="editor-button"
          type="button"
          disabled={!ready}
          title={
            tag === null
              ? 'Highlight the text. Shift+Enter'
              : `Highlight the text and add ${tag}. Shift+Enter`
          }
          onClick={() => {
            if (chosen !== null) {
              onCandidate(chosen);
            }
          }}
        >
          Mark as candidate
        </button>
        <button className="editor-button" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
