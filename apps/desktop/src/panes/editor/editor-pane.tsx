import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';

import type { EditorContent, PaneContent } from '../../workspace/model';
import { useDebugSnapshot } from '../debug-snapshot';
import type { PaneProps } from '../pane-props';

import { CodeEditor } from './code-editor';
import { debugText } from './debug-text';
import './editor-pane.css';
import { EditorToolbar } from './editor-toolbar';
import { effectiveView, isMarkdownPath, type ViewMode } from './file-kind';
import {
  errorText,
  isMissingFileError,
  loadFile,
  readTextFile,
  resolvePath,
  writeTextFile,
} from './fs-api';
import { MarkdownPreview } from './markdown-preview';
import { basename, dirname, isAbsolutePath, isHomePath } from './paths';

interface LoadingBuffer {
  status: 'loading';
}

interface FailedBuffer {
  status: 'failed';
  message: string;
}

interface ReadyBuffer {
  status: 'ready';
  /** Goes up by one per load, so each load gets a fresh editor. */
  docKey: number;
  initialText: string;
}

type Buffer = LoadingBuffer | FailedBuffer | ReadyBuffer;

/** True when something is already at `path`, readable as text or not. */
async function pathIsTaken(path: string): Promise<boolean> {
  try {
    await readTextFile(path);
    return true;
  } catch (error) {
    return !isMissingFileError(errorText(error));
  }
}

export function EditorPane({ name, content, active, debug, actions }: PaneProps<EditorContent>) {
  const [buffer, setBuffer] = useState<Buffer>({ status: 'loading' });
  // The path this buffer belongs to. It follows `content.path`, and runs
  // ahead of it for the moment between a first save and the workspace's reply.
  const [path, setPath] = useState<string | null>(content.path);
  const [resolvedPath, setResolvedPath] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [text, setText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmingReload, setConfirmingReload] = useState(false);
  const [viewChoice, setViewChoice] = useState<ViewMode | null>(null);
  const [reloadCount, setReloadCount] = useState(0);

  const docKeyRef = useRef(0);
  const adoptedPathRef = useRef<string | null>(null);
  const titledRef = useRef(false);
  const saveAsRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // A first save tells the workspace the new path, and the workspace hands
    // it straight back as `content`. That echo is not a request to load.
    const adopted = adoptedPathRef.current;
    adoptedPathRef.current = null;
    if (adopted !== null && adopted === content.path) {
      return;
    }

    let cancelled = false;

    function show(initialText: string, resolved: string | null, missing: boolean) {
      docKeyRef.current += 1;
      setResolvedPath(resolved);
      setIsNew(missing);
      setText(initialText);
      setSavedText(initialText);
      setBuffer({ status: 'ready', docKey: docKeyRef.current, initialText });
    }

    setPath(content.path);
    setSaveError(null);
    setConfirmingReload(false);

    if (content.path === null) {
      show('', null, false);
      return;
    }

    setBuffer({ status: 'loading' });
    void loadFile(content.path).then((result) => {
      if (cancelled) {
        return;
      }
      if (result.kind === 'failed') {
        setBuffer({ status: 'failed', message: result.message });
      } else if (result.kind === 'missing') {
        show('', result.resolvedPath, true);
      } else {
        show(result.text, result.resolvedPath, false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [content.path, reloadCount]);

  const ready = buffer.status === 'ready';
  const dirty = ready && text !== savedText;
  const markdown = isMarkdownPath(path);
  const view = effectiveView(markdown, viewChoice);
  const fileName = path === null ? 'untitled' : basename(path);

  // The title is only cleared if this pane set it, so a title given by a
  // layout file survives until the first edit.
  useEffect(() => {
    if (dirty) {
      titledRef.current = true;
      actions.setTitle(`${fileName} •`);
    } else if (titledRef.current) {
      titledRef.current = false;
      actions.setTitle(null);
    }
  }, [actions, dirty, fileName]);

  useDebugSnapshot(name, debug, () => debugText({ path, dirty, view, text }));

  const openBeside = useCallback(
    (next: PaneContent) => {
      actions.openPane(next);
    },
    [actions],
  );

  async function writeTo(target: string): Promise<boolean> {
    const snapshot = text;
    setSaving(true);
    setSaveError(null);
    try {
      await writeTextFile(target, snapshot);
      setSavedText(snapshot);
      setIsNew(false);
      return true;
    } catch (error) {
      setSaveError(errorText(error));
      return false;
    } finally {
      setSaving(false);
    }
  }

  function save() {
    if (!ready || saving) {
      return;
    }
    if (path === null) {
      saveAsRef.current?.focus();
      return;
    }
    void writeTo(path);
  }

  async function saveAs(typed: string) {
    const target = typed.trim();
    if (!ready || saving || target === '') {
      return;
    }
    if (!isAbsolutePath(target) && !isHomePath(target)) {
      setSaveError('Enter an absolute path, or one that starts with ~/');
      return;
    }
    if (await pathIsTaken(target)) {
      setSaveError(`${target} already exists. Choose another path.`);
      return;
    }
    if (!(await writeTo(target))) {
      return;
    }
    const resolved = await resolvePath(target).catch(() => null);
    adoptedPathRef.current = target;
    setPath(target);
    setResolvedPath(resolved);
    actions.replaceContent({ type: 'editor', path: target });
  }

  function reload() {
    setConfirmingReload(false);
    setReloadCount((count) => count + 1);
  }

  function requestReload() {
    if (dirty) {
      setConfirmingReload(true);
    } else {
      reload();
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 's' && event.metaKey && !event.altKey && !event.ctrlKey) {
      event.preventDefault();
      save();
    }
  }

  if (buffer.status === 'loading') {
    return (
      <div className="editor-pane">
        <p className="editor-status">Loading…</p>
      </div>
    );
  }

  if (buffer.status === 'failed') {
    return (
      <div className="editor-pane">
        <div className="editor-load-error" role="alert">
          <p>{buffer.message}</p>
          <button className="editor-button" type="button" onClick={reload}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-pane" onKeyDown={onKeyDown}>
      <EditorToolbar
        path={path}
        isNew={isNew}
        dirty={dirty}
        canSave={(dirty || isNew) && !saving}
        saving={saving}
        markdown={markdown}
        view={view}
        confirmingReload={confirmingReload}
        error={saveError}
        saveAsRef={saveAsRef}
        onSave={save}
        onSaveAs={(typed) => {
          void saveAs(typed);
        }}
        onView={setViewChoice}
        onReload={requestReload}
        onConfirmReload={reload}
        onCancelReload={() => {
          setConfirmingReload(false);
        }}
      />
      <div className="editor-body" data-view={view}>
        {/* Hidden in preview, not removed: the buffer and its undo history live here. */}
        <div className="editor-code" hidden={view === 'preview'}>
          <CodeEditor
            docKey={buffer.docKey}
            initialText={buffer.initialText}
            path={path}
            focused={active && view !== 'preview'}
            onChange={setText}
          />
        </div>
        {view !== 'edit' && (
          <div className="editor-preview">
            <MarkdownPreview
              text={text}
              baseDir={resolvedPath === null ? null : dirname(resolvedPath)}
              onOpen={openBeside}
            />
          </div>
        )}
      </div>
    </div>
  );
}
