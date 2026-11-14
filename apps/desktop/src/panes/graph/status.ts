import type { VaultGraph } from './vault-graph';
import type { GraphView } from './view-model';

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

export interface StatusInput {
  graph: VaultGraph | null;
  loading: boolean;
  /** Why the graph on screen may be behind the vault. Null when it is current. */
  stale: string | null;
}

/**
 * The one line under the drawing: what is going on right now. What the
 * vault holds that could not be drawn is listed under Issues instead, so
 * it does not sit here for good. A file that could not be read at this
 * moment is different: it may be half written, so it is said here.
 */
export function statusText({ graph, loading, stale }: StatusInput): string {
  if (stale !== null) {
    return `Showing the last graph that read cleanly. ${stale}`;
  }
  if (graph === null) {
    return loading ? 'Loading...' : '';
  }
  if (graph.incomplete && graph.warnings.length > 0) {
    return graph.warnings.join('. ');
  }
  return loading ? 'Loading...' : 'Double-click a node, or press Enter, to open its note.';
}

/** The counts shown in the toolbar. */
export function countsText(view: GraphView): string {
  return `${plural(view.nodes.length, 'node', 'nodes')} · ${plural(view.edges.length, 'relation', 'relations')} · ${String(view.skipped)} skipped`;
}
