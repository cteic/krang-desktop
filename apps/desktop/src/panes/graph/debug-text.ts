import type { GraphView } from './view-model';

/** What the pane shows beside the drawing, as counts. */
export interface DebugStats {
  /** Nodes with no relations that are not drawn. */
  unlinkedHidden: number;
  claims: number;
  unsupported: number;
  contested: number;
  supported: number;
  candidates: number;
  issues: number;
}

/**
 * The pane as plain text: the vault path, the view's name and counts, then
 * one `- title` line per node on show. A failed load, or a vault with no
 * graph in it, puts one `! message` line after the path. With `stats`, the
 * counts are followed by what the support lens, the candidates list and
 * the issues list hold.
 */
export function debugText(
  directory: string,
  view: GraphView | null,
  problem: string | null = null,
  stats: DebugStats | null = null,
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
    if (stats !== null) {
      lines.push(
        `unlinked hidden: ${String(stats.unlinkedHidden)}`,
        `claims: ${String(stats.claims)} (${String(stats.unsupported)} unsupported, ${String(stats.contested)} contested, ${String(stats.supported)} supported)`,
        `candidates: ${String(stats.candidates)}`,
        `issues: ${String(stats.issues)}`,
      );
    }
    for (const node of view.nodes) {
      lines.push(`- ${node.title}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
