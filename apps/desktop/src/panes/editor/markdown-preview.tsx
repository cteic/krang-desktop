import { type MouseEvent, useMemo } from 'react';
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { PaneContent } from '../../workspace/model';

import { classifyLink, resolveImageSrc } from './links';
import { useDebouncedValue } from './use-debounced-value';
import { remarkWikilinks, WIKILINK_SCHEME } from './wikilinks';

export interface MarkdownPreviewProps {
  text: string;
  /** The directory of the file shown, or null for a buffer with no file yet. */
  baseDir: string | null;
  /** Asked to open a pane beside this one. Keep it stable between renders. */
  onOpen: (content: PaneContent) => void;
}

// Long enough to skip the renders between keystrokes, short enough to feel live.
const DEBOUNCE_MS = 150;

const REMARK_PLUGINS = [remarkGfm, remarkWikilinks];

/** Lets wikilink addresses through. Everything else gets the standard safety check. */
function transformUrl(url: string): string {
  return url.startsWith(WIKILINK_SCHEME) ? url : defaultUrlTransform(url);
}

// The preview lives inside the app window. A link that navigated would
// replace the whole app, so no click is ever left to the browser.
function stopNavigation(event: MouseEvent) {
  event.preventDefault();
}

/**
 * Renders Markdown for reading. The first text shows at once; later changes
 * show after a short pause. Links open panes; they never navigate.
 */
export function MarkdownPreview({ text, baseDir, onOpen }: MarkdownPreviewProps) {
  const settledText = useDebouncedValue(text, DEBOUNCE_MS);

  const components = useMemo<Components>(
    () => ({
      a: ({ href, title, children }) => {
        const address = href ?? '';
        const wikilink = address.startsWith(WIKILINK_SCHEME);
        return (
          <a
            className={wikilink ? 'editor-wikilink' : undefined}
            href={address}
            title={title}
            onAuxClick={stopNavigation}
            onClick={(event) => {
              event.preventDefault();
              const target = classifyLink(address, baseDir);
              if (target.kind === 'web') {
                onOpen({ type: 'web', url: target.url });
              } else if (target.kind === 'editor') {
                onOpen({ type: 'editor', path: target.path });
              }
            }}
          >
            {children}
          </a>
        );
      },
      img: ({ src, alt, title }) => (
        <img
          src={typeof src === 'string' ? resolveImageSrc(src, baseDir) : undefined}
          alt={alt ?? ''}
          title={title}
        />
      ),
    }),
    [baseDir, onOpen],
  );

  const rendered = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        urlTransform={transformUrl}
        components={components}
      >
        {settledText}
      </ReactMarkdown>
    ),
    [settledText, components],
  );

  return <div className="editor-preview-content">{rendered}</div>;
}
