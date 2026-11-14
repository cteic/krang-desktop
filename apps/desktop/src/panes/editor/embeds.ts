import { extensionOf } from './file-kind';
import type { Directory } from './fs-api';
import { basename, localFileUrl } from './paths';

/** Finds the address of an embedded image by its file name. Null when there is none. */
export type EmbedResolver = (name: string) => Promise<string | null>;

export type ListDirectory = (path: string) => Promise<Directory>;

// Only files an `<img>` can draw. An image element never runs a script, so
// showing one does not open the local-file scheme any wider.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

// A vault this large is searched in part, not for ever.
const MAX_DIRECTORIES = 400;
const BATCH = 8;

const SKIPPED_DIRECTORIES = new Set(['node_modules']);

export function isImageName(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

function keyOf(name: string): string {
  return basename(name).toLowerCase();
}

/**
 * Lists every image under `root`, nearest first, by lower-case file name.
 * Hidden folders are skipped. With `deep` off only `root` itself is read.
 */
async function indexImages(
  root: string,
  deep: boolean,
  list: ListDirectory,
): Promise<Map<string, string>> {
  const images = new Map<string, string>();
  let level = [root];
  let visited = 0;
  while (level.length > 0 && visited < MAX_DIRECTORIES) {
    const batch = level.slice(0, Math.min(BATCH, MAX_DIRECTORIES - visited));
    const waiting = level.slice(batch.length);
    visited += batch.length;
    const listings = await Promise.all(batch.map((path) => list(path).catch(() => null)));
    const found: string[] = [];
    for (const listing of listings) {
      for (const entry of listing?.entries ?? []) {
        if (entry.isDir) {
          if (deep && !entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name)) {
            found.push(entry.path);
          }
        } else if (isImageName(entry.name) && !images.has(keyOf(entry.name))) {
          images.set(keyOf(entry.name), entry.path);
        }
      }
    }
    // Folders found now go behind those already waiting, so nearer ones are read first.
    level = [...waiting, ...found];
  }
  return images;
}

/**
 * Builds the lookup for one note's embeds. Inside a vault the whole vault is
 * searched, as Obsidian does; outside one, only the note's own folder. The
 * search runs once, on the first embed, and its result is kept.
 */
export function createEmbedResolver(
  vault: string | null,
  baseDir: string | null,
  list: ListDirectory,
): EmbedResolver {
  const root = vault ?? baseDir;
  let index: Promise<Map<string, string>> | null = null;
  return async (name) => {
    if (root === null || !isImageName(name)) {
      return null;
    }
    index ??= indexImages(root, vault !== null, list);
    const path = (await index).get(keyOf(name));
    return path === undefined ? null : localFileUrl(path);
  };
}
