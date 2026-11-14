/** Pure path helpers for POSIX-style paths. Nothing here touches the disk. */

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/');
}

/** True for `~` and `~/...`, the forms the core expands to the home directory. */
export function isHomePath(path: string): boolean {
  return path === '~' || path.startsWith('~/');
}

/** Collapses `.`, `..` and repeated slashes. A relative path may keep leading `..`. */
export function normalizePath(path: string): string {
  const absolute = isAbsolutePath(path);
  const kept: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment !== '..') {
      kept.push(segment);
      continue;
    }
    if (kept.length > 0 && kept[kept.length - 1] !== '..') {
      kept.pop();
    } else if (!absolute) {
      kept.push('..');
    }
  }
  const joined = kept.join('/');
  if (absolute) {
    return `/${joined}`;
  }
  return joined === '' ? '.' : joined;
}

export function expandHome(path: string, home: string): string {
  if (path === '~') {
    return normalizePath(home);
  }
  if (path.startsWith('~/')) {
    return normalizePath(`${home}/${path.slice(2)}`);
  }
  return path;
}

/** The directory holding `path`. `/a/b.md` gives `/a`; a bare name gives `.`. */
export function dirname(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const index = trimmed.lastIndexOf('/');
  if (index === -1) {
    return '.';
  }
  if (index === 0) {
    return '/';
  }
  return trimmed.slice(0, index);
}

/** The last segment of `path`: the file name. */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/** Resolves `relative` against `base`. An absolute `relative` wins outright. */
export function joinPath(base: string, relative: string): string {
  if (isAbsolutePath(relative)) {
    return normalizePath(relative);
  }
  return normalizePath(`${base}/${relative}`);
}

const LOCAL_FILE_ORIGIN = 'localfile://localhost';

/** The app's URL for a file on disk. Each segment is percent-encoded. */
export function localFileUrl(absolutePath: string): string {
  const encoded = normalizePath(absolutePath).split('/').map(encodeURIComponent).join('/');
  return `${LOCAL_FILE_ORIGIN}${encoded}`;
}
