/** The scheme the shell serves files from disk on. See `local_files.rs`. */
const LOCAL_FILE_PREFIX = 'localfile://localhost';

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const HOST_INPUT = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?(?:[/?#].*)?$/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

export const NOT_AN_ADDRESS = 'That is not an address. Try a URL, localhost:3000 or a file path.';
export const NO_HOME = 'Could not find your home folder.';
export const REMOTE_FILE = 'Files on another machine are not supported.';

export interface AddressOk {
  ok: true;
  url: string;
}

export interface AddressError {
  ok: false;
  message: string;
}

export type AddressResult = AddressOk | AddressError;

/** What the start view offers before anything is typed. */
export const START_SHORTCUTS: readonly string[] = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:4747',
];

function ok(url: string): AddressOk {
  return { ok: true, url };
}

function fail(message: string): AddressError {
  return { ok: false, message };
}

function parseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** True when the home folder is needed before `resolveAddress` can answer. */
export function needsHome(input: string): boolean {
  const text = input.trim();
  return text === '~' || text.startsWith('~/');
}

/** An absolute path as a URL the shell serves from disk. Slashes are kept. */
export function localFileUrl(path: string): string {
  return LOCAL_FILE_PREFIX + path.split('/').map(encodeURIComponent).join('/');
}

function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase();
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name === '[::1]' ||
    LOOPBACK_IPV4.test(name)
  );
}

function isIpLiteral(host: string): boolean {
  return host.startsWith('[') || IPV4.test(host);
}

function resolveFileUrl(text: string): AddressResult {
  const url = parseUrl(text);
  if (url === null || !url.pathname.startsWith('/')) {
    return fail(NOT_AN_ADDRESS);
  }
  if (url.hostname !== '' && url.hostname !== 'localhost') {
    return fail(REMOTE_FILE);
  }
  return ok(localFileUrl(decode(url.pathname)));
}

function resolveLocalFileUrl(text: string): AddressResult {
  const url = parseUrl(text);
  if (url === null || url.hostname !== 'localhost' || !url.pathname.startsWith('/')) {
    return fail(NOT_AN_ADDRESS);
  }
  return ok(url.href);
}

function resolveWebUrl(text: string): AddressResult {
  const url = parseUrl(text);
  if (url === null || url.hostname === '') {
    return fail(NOT_AN_ADDRESS);
  }
  return ok(url.href);
}

function resolveHost(text: string): AddressResult | null {
  const match = HOST_INPUT.exec(text);
  const host = match?.[1];
  if (host === undefined) {
    return null;
  }
  if (isLoopbackHost(host) || isIpLiteral(host)) {
    return resolveWebUrl(`http://${text}`);
  }
  if (DOMAIN.test(host)) {
    return resolveWebUrl(`https://${text}`);
  }
  return null;
}

/**
 * Turns what a person typed into a URL the frame can load. `home` is the
 * home folder, needed only for `~` paths: see `needsHome`.
 */
export function resolveAddress(input: string, home: string | null): AddressResult {
  const text = input.trim();
  if (text === '') {
    return fail('Type an address.');
  }
  if (needsHome(text)) {
    if (home === null || !home.startsWith('/')) {
      return fail(NO_HOME);
    }
    return ok(localFileUrl(home.replace(/\/+$/, '') + text.slice(1)));
  }
  if (text.startsWith('/')) {
    return ok(localFileUrl(text));
  }

  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase();
  if (scheme === 'http' || scheme === 'https') {
    return resolveWebUrl(text);
  }
  if (scheme === 'file') {
    return resolveFileUrl(text);
  }
  if (scheme === 'localfile') {
    return resolveLocalFileUrl(text);
  }

  const hosted = resolveHost(text);
  if (hosted !== null) {
    return hosted;
  }
  if (scheme !== undefined) {
    return fail(
      `Cannot open "${scheme}:" addresses. Only http, https and local files are supported.`,
    );
  }
  return fail(NOT_AN_ADDRESS);
}

/** How a loaded URL reads in the address field: a local file shows as its path. */
export function displayAddress(url: string): string {
  if (!url.startsWith(`${LOCAL_FILE_PREFIX}/`)) {
    return url;
  }
  const parsed = parseUrl(url);
  if (parsed === null) {
    return url;
  }
  return decode(parsed.pathname) + parsed.search + parsed.hash;
}

/** True for pages that may refuse to be framed: https, and not on this machine. */
export function mayRefuseFraming(url: string): boolean {
  const parsed = parseUrl(url);
  return parsed !== null && parsed.protocol === 'https:' && !isLoopbackHost(parsed.hostname);
}
