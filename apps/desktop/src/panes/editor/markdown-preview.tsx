import { type MouseEvent, useMemo } from 'react';
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { PaneContent } from '../../workspace/model';

import { EmbedImage } from './embed-image';
import type { EmbedResolver } from './embeds';
import { splitFrontmatter } from './frontmatter';
import { classifyLink, resolveImageSrc } from './links';
import { EMBED_SCHEME, parseEmbedHref, remarkObsidianMarks } from './obsidian-marks';
import { PropertiesBlock } from './properties-block';
import { useDebouncedValue } from './use-debounced-value';
import { remarkWikilinks, WIKILINK_SCHEME } from './wikilinks';

export interface MarkdownPreviewProps {
  text: string;
  /** The directory of the file shown, or null for a buffer with no file yet. */
  baseDir: string | null;
  /** Asked to open a pane beside this one. Keep it stable between renders. */
  onOpen: (content: PaneContent) => void;
  /** Finds embedded images. Left out, an embed shows as its file name. */
  resolveEmbed?: EmbedResolver | undefined;
}

// Long enough to skip the renders between keystrokes, short enough to feel live.
const DEBOUNCE_MS = 150;

// Embeds are found before wikilinks, or `![[a.png]]` would become a link.
const REMARK_PLUGINS = [remarkGfm, remarkObsidianMarks, remarkWikilinks];

/**
 * Lets wikilink and embed addresses through. Everything else gets the
 * standard safety check.
 */
function transformUrl(url: string): string {
  if (url.startsWith(WIKILINK_SCHEME) || url.startsWith(EMBED_SCHEME)) {
    return url;
  }
  return defaultUrlTransform(url);
}

function sizeOf(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

// The preview lives inside the app window. A link that navigated would
// replace the whole app, so no click is ever left to the browser.
function stopNavigation(event: MouseEvent) {
  event.preventDefault();
}

/**
 * Renders Markdown for reading. The first text shows at once; later changes
 * show after a short pause. Links open panes; they never navigate. A note's
 * frontmatter shows as a closed list of properties, not as text.
 */
export function MarkdownPreview({ text, baseDir, onOpen, resolveEmbed }: MarkdownPreviewProps) {
  const settledText = useDebouncedValue(text, DEBOUNCE_MS);
  const note = useMemo(() => splitFrontmatter(settledText), [settledText]);

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
      img: ({ src, alt, title, width, height }) => {
        const embedded = typeof src === 'string' ? parseEmbedHref(src) : null;
        if (embedded !== null) {
          return (
            <EmbedImage
              name={embedded}
              width={sizeOf(width)}
              height={sizeOf(height)}
              resolve={resolveEmbed ?? null}
            />
          );
        }
        return (
          <img
            src={typeof src === 'string' ? resolveImageSrc(src, baseDir) : undefined}
            alt={alt ?? ''}
            title={title}
          />
        );
      },
    }),
    [baseDir, onOpen, resolveEmbed],
  );

  const rendered = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        urlTransform={transformUrl}
        components={components}
      >
        {note.body}
      </ReactMarkdown>
    ),
    [note.body, components],
  );

  return (
    <div className="editor-preview-content">
      {note.properties !== null && note.properties.length > 0 && (
        <PropertiesBlock properties={note.properties} />
      )}
      {rendered}
    </div>
  );
}
