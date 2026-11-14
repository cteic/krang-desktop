import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { EditorContent, PaneContent } from '../../workspace/model';
import { useDebugSnapshot } from '../debug-snapshot';
import type { PaneProps } from '../pane-props';

import { candidateText, nodeText } from './capture';
import { CapturePopover } from './capture-popover';
import { CodeEditor, type EditorApi } from './code-editor';
import { debugText } from './debug-text';
import './editor-pane.css';
import type { EditorSelection } from './editor-setup';
import { type CaptureState, type CreatedNotice, EditorToolbar } from './editor-toolbar';
import { createEmbedResolver } from './embeds';
import { effectiveView, isMarkdownPath, type ViewMode } from './file-kind';
import {
  errorText,
  isMissingFileError,
  listDirectory,
  loadFile,
  readTextFile,
  resolvePath,
  writeTextFile,
} from './fs-api';
import { MarkdownPreview } from './markdown-preview';
import { basename, dirname, isAbsolutePath, isHomePath } from './paths';
import { createNode, type NodeType, readNodeTypes, vaultRootOf } from './vault-api';

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

/** The selection a node is being made from, while its type is chosen. */
interface Capture {
  range: EditorSelection;
  /** Null until the vault's node types have been read. */
  types: NodeType[] | null;
  error: string | null;
  busy: boolean;
}

// Long enough to read the notice and reach for "Open".
const CREATED_NOTICE_MS = 12_000;
const FOLLOW_MS = 2000;

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
  // The vault the file is in. Null outside one, where nodes cannot be made.
  const [vault, setVault] = useState<string | null>(null);
  const [selected, setSelected] = useState(false);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [created, setCreated] = useState<CreatedNotice | null>(null);

  const docKeyRef = useRef(0);
  const adoptedPathRef = useRef<string | null>(null);
  const titledRef = useRef(false);
  const saveAsRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<EditorApi | null>(null);
  const captureRunRef = useRef(0);

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
    captureRunRef.current += 1;
    setCapture(null);
    setCreated(null);

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

  // A clean buffer follows the file: when another program rewrites it, the
  // pane shows the new text. Unsaved edits are never replaced this way.
  const followRef = useRef({ dirty, savedText });
  followRef.current = { dirty, savedText };
  useEffect(() => {
    if (!ready || isNew || resolvedPath === null) {
      return;
    }
    const followed = resolvedPath;
    let busy = false;
    const timer = window.setInterval(() => {
      if (busy || followRef.current.dirty) {
        return;
      }
      busy = true;
      readTextFile(followed)
        .then(
          (file) => {
            const now = followRef.current;
            if (!now.dirty && file.text !== now.savedText) {
              setReloadCount((count) => count + 1);
            }
          },
          () => {
            // A file that cannot be read right now keeps what is shown.
          },
        )
        .finally(() => {
          busy = false;
        });
    }, FOLLOW_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [ready, isNew, resolvedPath]);
  const markdown = isMarkdownPath(path);
  const view = effectiveView(markdown, viewChoice ?? content.mode ?? null);
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

  useEffect(() => {
    let cancelled = false;
    setVault(null);
    if (resolvedPath === null) {
      return;
    }
    void vaultRootOf(resolvedPath).then((root) => {
      if (!cancelled) {
        setVault(root);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [resolvedPath]);

  useEffect(() => {
    if (created === null) {
      return;
    }
    const timer = window.setTimeout(() => {
      setCreated(null);
    }, CREATED_NOTICE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [created]);

  const baseDir = resolvedPath === null ? null : dirname(resolvedPath);
  // A reload builds a new lookup, so an image added since is found.
  const resolveEmbed = useMemo(
    () => createEmbedResolver(vault, baseDir, listDirectory),
    [vault, baseDir, reloadCount],
  );

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
    actions.replaceContent(
      content.mode === undefined
        ? { type: 'editor', path: target }
        : { type: 'editor', path: target, mode: content.mode },
    );
  }

  function chooseView(mode: ViewMode) {
    setViewChoice(mode);
    // Recorded with the workspace, so the pane reopens the way it was left.
    actions.replaceContent({ type: 'editor', path: content.path, mode });
  }

  let captureState: CaptureState = 'hidden';
  if (vault !== null) {
    captureState = selected && view !== 'preview' && capture === null ? 'ready' : 'disabled';
  }

  function openCapture() {
    const range = editorRef.current?.selection();
    if (vault === null || captureState !== 'ready' || range === undefined) {
      return;
    }
    if (nodeText(range.text) === '') {
      return;
    }
    captureRunRef.current += 1;
    const run = captureRunRef.current;
    setCapture({ range, types: null, error: null, busy: false });
    readNodeTypes(vault)
      .then((types) => {
        if (captureRunRef.current === run) {
          setCapture((current) => (current === null ? null : { ...current, types }));
        }
      })
      .catch((error: unknown) => {
        if (captureRunRef.current === run) {
          setCapture((current) =>
            current === null ? null : { ...current, types: [], error: errorText(error) },
          );
        }
      });
  }

  function closeCapture() {
    captureRunRef.current += 1;
    setCapture(null);
    editorRef.current?.focus();
  }

  async function createFromCapture(type: NodeType) {
    if (capture === null || vault === null || capture.busy) {
      return;
    }
    const run = captureRunRef.current;
    const range = capture.range;
    setCapture({ ...capture, error: null, busy: true });
    try {
      const node = await createNode({
        vault,
        typeId: type.id,
        text: nodeText(range.text),
        body: '',
      });
      if (captureRunRef.current !== run) {
        return;
      }
      const linked = editorRef.current?.replaceRange(range, `[[${node.title}]]`) ?? false;
      setCreated({
        title: node.title,
        path: node.path,
        warning: linked ? null : 'The text changed, so no link was added',
      });
      closeCapture();
    } catch (error) {
      if (captureRunRef.current === run) {
        setCapture((current) =>
          current === null ? null : { ...current, error: errorText(error), busy: false },
        );
      }
    }
  }

  function markCandidate(type: NodeType) {
    if (capture === null || capture.busy) {
      return;
    }
    const marked = editorRef.current?.replaceRange(
      capture.range,
      candidateText(capture.range.text, type),
    );
    if (marked === true) {
      closeCapture();
    } else {
      setCapture({ ...capture, error: 'The text changed. Select it again.' });
    }
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
    const plainCommand = event.metaKey && !event.altKey && !event.ctrlKey;
    if (event.key.toLowerCase() === 'n' && plainCommand && event.shiftKey && vault !== null) {
      event.preventDefault();
      openCapture();
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
        capture={captureState}
        created={created}
        onCapture={openCapture}
        onOpenCreated={() => {
          if (created !== null) {
            openBeside({ type: 'editor', path: created.path });
            setCreated(null);
          }
        }}
        onDismissCreated={() => {
          setCreated(null);
        }}
        onSave={save}
        onSaveAs={(typed) => {
          void saveAs(typed);
        }}
        onView={chooseView}
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
            onSelection={setSelected}
            apiRef={editorRef}
          />
        </div>
        {view !== 'edit' && (
          <div className="editor-preview">
            <MarkdownPreview
              text={text}
              baseDir={baseDir}
              onOpen={openBeside}
              resolveEmbed={resolveEmbed}
            />
          </div>
        )}
        {capture !== null && (
          <CapturePopover
            text={capture.range.text}
            types={capture.types}
            error={capture.error}
            busy={capture.busy}
            onCreate={(type) => {
              void createFromCapture(type);
            }}
            onCandidate={markCandidate}
            onCancel={closeCapture}
          />
        )}
      </div>
    </div>
  );
}
