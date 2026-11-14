import { extensionOf } from './file-kind';
import { isAbsolutePath, isHomePath, joinPath, localFileUrl } from './paths';
import { parseWikilinkHref, wikilinkFileName } from './wikilinks';

export interface WebTarget {
  kind: 'web';
  url: string;
}

export interface EditorTarget {
  kind: 'editor';
  path: string;
}

export interface NoTarget {
  kind: 'none';
}

export type LinkTarget = WebTarget | EditorTarget | NoTarget;

const NONE: NoTarget = { kind: 'none' };

const HTTP = /^https?:\/\//i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// Files a web pane shows better than a text editor does.
const WEB_VIEWED = new Set(['html', 'htm', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Drops the `?query` and `#fragment` of a link and decodes its escapes. */
function pathPart(href: string): string {
  const end = href.search(/[?#]/);
  return decode(end === -1 ? href : href.slice(0, end));
}

/** The absolute path a link points at, or null when it cannot be resolved. */
function resolveFile(path: string, baseDir: string | null): string | null {
  if (isAbsolutePath(path)) {
    return joinPath('/', path);
  }
  if (baseDir === null) {
    return null;
  }
  return joinPath(baseDir, path);
}

/**
 * Decides what a click on a preview link opens. `baseDir` is the directory
 * of the file being previewed, or null for a buffer that has no file yet.
 */
export function classifyLink(href: string, baseDir: string | null): LinkTarget {
  const trimmed = href.trim();
  const note = parseWikilinkHref(trimmed);
  if (note !== null) {
    const fileName = wikilinkFileName(note);
    const path = fileName === null ? null : resolveFile(fileName, baseDir);
    return path === null ? NONE : { kind: 'editor', path };
  }
  if (HTTP.test(trimmed)) {
    return { kind: 'web', url: trimmed };
  }
  if (trimmed.startsWith('//')) {
    return { kind: 'web', url: `https:${trimmed}` };
  }
  if (ANY_SCHEME.test(trimmed)) {
    return NONE;
  }
  const path = pathPart(trimmed);
  if (path === '') {
    return NONE;
  }
  if (isHomePath(path)) {
    return { kind: 'editor', path };
  }
  const resolved = resolveFile(path, baseDir);
  if (resolved === null) {
    return NONE;
  }
  if (WEB_VIEWED.has(extensionOf(resolved))) {
    return { kind: 'web', url: localFileUrl(resolved) };
  }
  return { kind: 'editor', path: resolved };
}

/**
 * The `src` to give an image in the preview. Web images pass through; a path
 * resolves against the file's directory and loads through the local-file scheme.
 */
export function resolveImageSrc(src: string, baseDir: string | null): string {
  const trimmed = src.trim();
  if (trimmed === '' || trimmed.startsWith('//') || ANY_SCHEME.test(trimmed)) {
    return trimmed;
  }
  const resolved = resolveFile(pathPart(trimmed), baseDir);
  return resolved === null ? trimmed : localFileUrl(resolved);
}
