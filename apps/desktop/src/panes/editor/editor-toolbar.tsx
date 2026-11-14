import { type RefObject, type SubmitEvent, useState } from 'react';

import { VIEW_MODES, type ViewMode } from './file-kind';
import { truncateMiddle } from './truncate-middle';

const PATH_MAX_CHARACTERS = 56;

const VIEW_LABELS: Record<ViewMode, string> = {
  edit: 'Edit',
  split: 'Split',
  preview: 'Preview',
};

export type CaptureState = 'hidden' | 'disabled' | 'ready';

export interface CreatedNotice {
  title: string;
  path: string;
  /** Set when the note was made but the link could not be put in the text. */
  warning: string | null;
}

export interface EditorToolbarProps {
  /** Null for a buffer that has never been saved. */
  path: string | null;
  /** True when the path names a file that is not on disk yet. */
  isNew: boolean;
  dirty: boolean;
  canSave: boolean;
  saving: boolean;
  markdown: boolean;
  view: ViewMode;
  confirmingReload: boolean;
  error: string | null;
  saveAsRef: RefObject<HTMLInputElement | null>;
  /** The "Node" button: hidden outside a vault, ready only with text selected. */
  capture: CaptureState;
  /** A note just made from the selection, offered for opening. */
  created: CreatedNotice | null;
  onCapture: () => void;
  onOpenCreated: () => void;
  onDismissCreated: () => void;
  onSave: () => void;
  onSaveAs: (path: string) => void;
  onView: (view: ViewMode) => void;
  onReload: () => void;
  onConfirmReload: () => void;
  onCancelReload: () => void;
}

export function EditorToolbar({
  path,
  isNew,
  dirty,
  canSave,
  saving,
  markdown,
  view,
  confirmingReload,
  error,
  saveAsRef,
  capture,
  created,
  onCapture,
  onOpenCreated,
  onDismissCreated,
  onSave,
  onSaveAs,
  onView,
  onReload,
  onConfirmReload,
  onCancelReload,
}: EditorToolbarProps) {
  const [saveAsPath, setSaveAsPath] = useState('');

  function submitSaveAs(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    onSaveAs(saveAsPath);
  }

  return (
    <div className="editor-toolbar">
      <div className="editor-toolbar-row">
        {path === null ? (
          <form className="editor-save-as" onSubmit={submitSaveAs}>
            <input
              ref={saveAsRef}
              className="editor-save-as-input"
              type="text"
              aria-label="Save as path"
              placeholder="Save as: /absolute/path or ~/path"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={saveAsPath}
              onChange={(event) => {
                setSaveAsPath(event.target.value);
              }}
            />
            <button
              className="editor-button"
              type="submit"
              disabled={saving || saveAsPath.trim() === ''}
            >
              Save as
            </button>
          </form>
        ) : (
          <span className="editor-path" title={path}>
            {truncateMiddle(path, PATH_MAX_CHARACTERS)}
          </span>
        )}
        {dirty && (
          <span className="editor-dirty" role="img" aria-label="Unsaved changes">
            •
          </span>
        )}
        {isNew && <span className="editor-note">New file: saving creates it</span>}
        <span className="editor-toolbar-space" />
        {markdown && (
          <div className="editor-view-switch" role="group" aria-label="View">
            {VIEW_MODES.map((mode) => (
              <button
                key={mode}
                className="editor-button"
                type="button"
                aria-pressed={mode === view}
                onClick={() => {
                  onView(mode);
                }}
              >
                {VIEW_LABELS[mode]}
              </button>
            ))}
          </div>
        )}
        {capture !== 'hidden' && (
          <button
            className="editor-button"
            type="button"
            title="Make a node from the selected text (Cmd+Shift+N)"
            disabled={capture !== 'ready'}
            onClick={onCapture}
          >
            Node
          </button>
        )}
        {path !== null && (
          <button className="editor-button" type="button" disabled={!canSave} onClick={onSave}>
            Save
          </button>
        )}
        <button
          className="editor-button"
          type="button"
          disabled={path === null || confirmingReload}
          onClick={onReload}
        >
          Reload from disk
        </button>
      </div>
      {confirmingReload && (
        <div className="editor-toolbar-row editor-confirm" role="alertdialog" aria-label="Reload">
          <span>Reload from disk and discard unsaved changes?</span>
          <button className="editor-button" type="button" onClick={onConfirmReload}>
            Discard changes
          </button>
          <button className="editor-button" type="button" onClick={onCancelReload}>
            Keep editing
          </button>
        </div>
      )}
      {created !== null && (
        <div className="editor-toolbar-row editor-created" role="status">
          <span className="editor-created-text">
            Created {created.title}
            {created.warning === null ? '' : `. ${created.warning}`}
          </span>
          <button className="editor-button" type="button" onClick={onOpenCreated}>
            Open
          </button>
          <button
            className="editor-button"
            type="button"
            aria-label="Dismiss"
            onClick={onDismissCreated}
          >
            ×
          </button>
        </div>
      )}
      {error !== null && (
        <div className="editor-toolbar-row editor-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
