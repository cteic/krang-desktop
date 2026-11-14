import type { VaultGraph } from './vault-graph';
import type { GraphView } from './view-model';

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

export interface StatusInput {
  graph: VaultGraph | null;
  view: GraphView | null;
  loading: boolean;
  /** Why the graph on screen may be behind the vault. Null when it is current. */
  stale: string | null;
}

/** The one line under the drawing: what is going on, or what was left out. */
export function statusText({ graph, view, loading, stale }: StatusInput): string {
  if (stale !== null) {
    return `Showing the last graph that read cleanly. ${stale}`;
  }
  if (graph === null) {
    return loading ? 'Loading...' : '';
  }
  const parts = [...graph.warnings];
  if (view !== null && view.notDrawn > 0) {
    parts.push(
      `${plural(view.notDrawn, 'other shape', 'other shapes')} in this canvas ${view.notDrawn === 1 ? 'is' : 'are'} not drawn`,
    );
  }
  if (parts.length === 0) {
    return loading ? 'Loading...' : 'Double-click a node, or press Enter, to open its note.';
  }
  return parts.join('. ');
}

/** The counts shown in the toolbar. */
export function countsText(view: GraphView): string {
  return `${plural(view.nodes.length, 'node', 'nodes')} · ${plural(view.edges.length, 'relation', 'relations')} · ${String(view.skipped)} skipped`;
}
