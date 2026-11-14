/**
 * Which folders the person has trusted for chat. A trusted folder's own
 * agent settings, skills and hooks apply to a chat that runs in it. The
 * list lives in this window's local storage and only `trustFolder` adds to
 * it. Nothing in a pane's content, a layout file or a link is read here.
 */

const STORAGE_KEY = 'chat.trusted-folders';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** True for the home directory, however a pane's content spells it. */
export function isHomeDirectory(directory: string | null): boolean {
  return directory === null || /^~\/*$/.test(directory);
}

/** True for a `~/...` path, which needs the home directory to become absolute. */
export function needsHome(directory: string | null): boolean {
  return directory !== null && directory.startsWith('~/') && !isHomeDirectory(directory);
}

/**
 * The absolute path trust is remembered under, or null when there is none
 * yet. Only trailing slashes are dropped. `..` and repeated slashes are
 * kept as written: collapsing them as text could turn a path through a
 * link into the path of a different, trusted folder.
 */
export function folderKey(directory: string | null, home: string | null): string | null {
  if (directory === null) {
    return null;
  }
  let path: string | null = null;
  if (directory.startsWith('/')) {
    path = directory;
  } else if (directory.startsWith('~/') && home !== null && home.startsWith('/')) {
    path = `${home.replace(/\/+$/, '')}/${directory.slice(2)}`;
  }
  if (path === null) {
    return null;
  }
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** The trusted folders. Storage that is missing, blocked or malformed gives none. */
export function readTrustedFolders(): string[] {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(stored);
    return isStringArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function isTrustedFolder(key: string): boolean {
  return readTrustedFolders().includes(key);
}

/** Remembers a folder as trusted. False when it could not be stored. */
export function trustFolder(key: string): boolean {
  if (!key.startsWith('/')) {
    return false;
  }
  try {
    const folders = readTrustedFolders();
    if (!folders.includes(key)) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...folders, key]));
    }
    return true;
  } catch {
    return false;
  }
}
