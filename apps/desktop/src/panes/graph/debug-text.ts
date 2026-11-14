import type { GraphView } from './view-model';

/**
 * The pane as plain text: the vault path, the view's name and counts, then
 * one `- title` line per node on show. A failed load, or a vault with no
 * graph in it, puts one `! message` line after the path.
 */
export function debugText(
  directory: string,
  view: GraphView | null,
  problem: string | null = null,
): string {
  const lines = [directory];
  if (problem !== null) {
    lines.push(`! ${problem}`);
  }
  if (view !== null) {
    lines.push(
      `view: ${view.label}`,
      `nodes: ${String(view.nodes.length)}`,
      `relations: ${String(view.edges.length)}`,
      `skipped: ${String(view.skipped)}`,
    );
    for (const node of view.nodes) {
      lines.push(`- ${node.title}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
