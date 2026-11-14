import { basename } from './paths';

export const VIEW_MODES = ['edit', 'split', 'preview'] as const;

export type ViewMode = (typeof VIEW_MODES)[number];

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);

/** The lower-case extension without its dot. Empty for none, and for dotfiles. */
export function extensionOf(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf('.');
  if (index <= 0) {
    return '';
  }
  return name.slice(index + 1).toLowerCase();
}

export function isMarkdownPath(path: string | null): boolean {
  return path !== null && MARKDOWN_EXTENSIONS.has(extensionOf(path));
}

/** Markdown opens split unless the person chose a view. Code is always edit. */
export function effectiveView(markdown: boolean, choice: ViewMode | null): ViewMode {
  if (!markdown) {
    return 'edit';
  }
  return choice ?? 'split';
}

export interface EditorLayout {
  lineWrapping: boolean;
  lineNumbers: boolean;
}

/** Prose wraps and has no gutter. Code keeps long lines and shows line numbers. */
export function editorLayout(path: string | null): EditorLayout {
  const markdown = isMarkdownPath(path);
  return { lineWrapping: markdown, lineNumbers: !markdown };
}
