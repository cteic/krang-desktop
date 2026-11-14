import { useEffect, useRef } from 'react';

import { createEditor, type EditorHandle } from './editor-setup';

export interface CodeEditorProps {
  /** Changes when a file is loaded. A new key builds a new editor. */
  docKey: number;
  /** The text to start from. Read once per `docKey`. */
  initialText: string;
  path: string | null;
  focused: boolean;
  onChange: (text: string) => void;
}

/**
 * The CodeMirror editor. It owns the buffer: the parent hears every change
 * through `onChange` but never pushes text back in, so typing does not
 * rebuild anything.
 */
export function CodeEditor({ docKey, initialText, path, focused, onChange }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<EditorHandle | null>(null);
  const startRef = useRef({ initialText, path });
  startRef.current = { initialText, path };
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const appliedPathRef = useRef(path);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    const start = startRef.current;
    const handle = createEditor({
      parent: host,
      text: start.initialText,
      path: start.path,
      onChange: (text) => {
        onChangeRef.current(text);
      },
    });
    handleRef.current = handle;
    appliedPathRef.current = start.path;
    return () => {
      handleRef.current = null;
      handle.destroy();
    };
  }, [docKey]);

  // Saving a new buffer gives it a name. The editor keeps its text and
  // history and only picks up the language and layout for that name.
  useEffect(() => {
    if (appliedPathRef.current !== path) {
      appliedPathRef.current = path;
      handleRef.current?.setPath(path);
    }
  }, [path, docKey]);

  useEffect(() => {
    if (focused) {
      handleRef.current?.focus();
    }
  }, [focused, docKey]);

  return <div className="editor-code-host" ref={hostRef} />;
}
