export interface Breadcrumb {
  label: string;
  /** The directory this segment opens. */
  path: string;
}

/**
 * Splits a path into clickable segments. An absolute path starts with a `/`
 * segment for the root. Repeated and trailing slashes are ignored.
 */
export function splitBreadcrumbs(path: string): Breadcrumb[] {
  const absolute = path.startsWith('/');
  const names = path.split('/').filter((name) => name !== '');
  const crumbs: Breadcrumb[] = absolute ? [{ label: '/', path: '/' }] : [];
  let current = '';
  for (const name of names) {
    if (current === '') {
      current = absolute ? `/${name}` : name;
    } else {
      current = `${current}/${name}`;
    }
    crumbs.push({ label: name, path: current });
  }
  return crumbs;
}

/**
 * The parent by the text of the path alone. Used when a directory failed to
 * load, so there is no listing to say what its parent is.
 */
export function lexicalParent(path: string): string | null {
  const parent = splitBreadcrumbs(path).at(-2);
  return parent === undefined ? null : parent.path;
}

export function isHtmlPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

/**
 * The address a web pane uses for a file on disk. Each segment is escaped so
 * a space, `#` or `?` in a name stays part of the path.
 */
export function localFileUrl(path: string): string {
  const escaped = path.split('/').map(encodeURIComponent).join('/');
  return `localfile://localhost${escaped}`;
}
