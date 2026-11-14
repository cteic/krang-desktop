import { indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState, type Extension, Prec } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';

import { findLanguage } from './editor-language';
import { editorLayout, isMarkdownPath } from './file-kind';

// One-dark supplies the syntax colours. These rules sit above it so the
// surfaces match the rest of the window.
const APP_THEME = Prec.highest(
  EditorView.theme(
    {
      '&': {
        height: '100%',
        color: 'var(--text)',
        backgroundColor: 'var(--bg)',
        fontSize: '13px',
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': {
        fontFamily: '"SF Mono", Menlo, Monaco, monospace',
        lineHeight: '1.5',
      },
      '.cm-content': { padding: '8px 0' },
      '.cm-gutters': {
        color: 'var(--muted)',
        backgroundColor: 'var(--bg)',
        border: 'none',
      },
      '.cm-activeLine': { backgroundColor: 'rgb(255 255 255 / 4%)' },
      '.cm-activeLineGutter': { color: 'var(--text)', backgroundColor: 'transparent' },
      '.cm-panels': { color: 'var(--text)', backgroundColor: 'var(--panel)' },
      '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
      '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
      '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--line)' },
    },
    { dark: true },
  ),
);

// The standard setup always adds a gutter. Prose hides it and gets side padding.
const PROSE_LAYOUT = EditorView.theme({
  '.cm-gutters': { display: 'none' },
  '.cm-line': { padding: '0 16px' },
});

const layoutCompartment = new Compartment();
const languageCompartment = new Compartment();

function layoutExtension(path: string | null): Extension {
  const layout = editorLayout(path);
  const extensions: Extension[] = [];
  if (layout.lineWrapping) {
    extensions.push(EditorView.lineWrapping);
  }
  if (!layout.lineNumbers) {
    extensions.push(PROSE_LAYOUT);
  }
  return extensions;
}

function markdownSupport(): Extension {
  return markdown({ base: markdownLanguage, codeLanguages: languages });
}

export interface EditorOptions {
  parent: HTMLElement;
  text: string;
  path: string | null;
  onChange: (text: string) => void;
  /** Told when the selection starts or stops holding text. */
  onSelection?: ((selected: boolean) => void) | undefined;
}

/** A stretch of the buffer and the text it held when it was read. */
export interface EditorSelection {
  from: number;
  to: number;
  text: string;
}

export interface EditorHandle {
  /** The main selection. Empty text when nothing is selected. */
  selection(): EditorSelection;
  /**
   * Puts `insert` where `range` was read. False, and nothing changes, when
   * the buffer no longer holds that text there.
   */
  replaceRange(range: EditorSelection, insert: string): boolean;
  /** Applies the language and layout for a file name, without losing the buffer. */
  setPath(path: string | null): void;
  focus(): void;
  destroy(): void;
}

/** Builds one editor in `parent`. The caller destroys it when the file closes. */
export function createEditor({
  parent,
  text,
  path,
  onChange,
  onSelection,
}: EditorOptions): EditorHandle {
  let destroyed = false;
  let selected = false;
  let languageRequest = 0;

  // A file with Windows line endings keeps them when it is saved.
  const lineSeparator = text.includes('\r\n') ? EditorState.lineSeparator.of('\r\n') : [];

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        lineSeparator,
        basicSetup,
        keymap.of([indentWithTab]),
        layoutCompartment.of(layoutExtension(path)),
        languageCompartment.of(isMarkdownPath(path) ? markdownSupport() : []),
        APP_THEME,
        oneDark,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChange(update.state.sliceDoc());
          }
          const nowSelected = !update.state.selection.main.empty;
          if (nowSelected !== selected) {
            selected = nowSelected;
            onSelection?.(selected);
          }
        }),
      ],
    }),
  });

  function setLanguage(support: Extension, request: number) {
    if (!destroyed && request === languageRequest) {
      view.dispatch({ effects: languageCompartment.reconfigure(support) });
    }
  }

  function loadLanguage(filePath: string | null) {
    languageRequest += 1;
    const request = languageRequest;
    if (filePath === null) {
      setLanguage([], request);
      return;
    }
    if (isMarkdownPath(filePath)) {
      setLanguage(markdownSupport(), request);
      return;
    }
    const description = findLanguage(filePath);
    if (description === null) {
      setLanguage([], request);
      return;
    }
    description
      .load()
      .then((support) => {
        setLanguage(support, request);
      })
      .catch((error: unknown) => {
        console.error('[editor-pane]', error);
      });
  }

  if (!isMarkdownPath(path)) {
    loadLanguage(path);
  }

  return {
    selection() {
      const { from, to } = view.state.selection.main;
      return { from, to, text: view.state.sliceDoc(from, to) };
    },
    replaceRange(range, insert) {
      const length = view.state.doc.length;
      const inside = range.from >= 0 && range.from <= range.to && range.to <= length;
      if (destroyed || !inside || view.state.sliceDoc(range.from, range.to) !== range.text) {
        return false;
      }
      view.dispatch({
        changes: { from: range.from, to: range.to, insert },
        selection: { anchor: range.from + insert.length },
      });
      return true;
    },
    setPath(nextPath) {
      if (destroyed) {
        return;
      }
      view.dispatch({ effects: layoutCompartment.reconfigure(layoutExtension(nextPath)) });
      loadLanguage(nextPath);
    },
    focus() {
      if (!destroyed) {
        view.focus();
      }
    },
    destroy() {
      destroyed = true;
      view.destroy();
    },
  };
}
