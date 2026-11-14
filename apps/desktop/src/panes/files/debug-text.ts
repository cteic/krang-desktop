import { formatSize } from './format';
import type { FileEntry } from './listing';

/**
 * The pane as plain text: the path on line one, then one line per visible
 * entry, `d name/` for a directory and `f name size` for a file. A failed
 * load puts one `! message` line after the path.
 */
export function debugText(
  path: string,
  entries: readonly FileEntry[],
  error: string | null = null,
): string {
  const lines = [path];
  if (error !== null) {
    lines.push(`! ${error}`);
  }
  for (const entry of entries) {
    lines.push(entry.isDir ? `d ${entry.name}/` : `f ${entry.name} ${formatSize(entry.size)}`);
  }
  return `${lines.join('\n')}\n`;
}
