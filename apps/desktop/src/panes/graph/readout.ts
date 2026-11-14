import type { GraphView, ViewNode } from './view-model';

/**
 * The readout: one node spelled out in full under the drawing, for when
 * the boxes are too small to read.
 */

export interface Readout {
  title: string;
  typeName: string;
  fill: string;
  /** How the node relates to others, such as "supported by 2 · opposed by 1". */
  relations: string;
}

function count(text: string, total: number): string[] {
  return total === 0 ? [] : [`${text} ${String(total)}`];
}

/** Counts a node's relations in a view by what they say about it. */
export function relationsText(view: GraphView, id: string): string {
  let supportedBy = 0;
  let opposedBy = 0;
  let supports = 0;
  let opposes = 0;
  let other = 0;
  for (const edge of view.edges) {
    if (edge.source !== id && edge.target !== id) {
      continue;
    }
    const acted = edge.acted === id && edge.source !== edge.target;
    if (edge.kind === 'supports') {
      supportedBy += acted ? 1 : 0;
      supports += acted ? 0 : 1;
    } else if (edge.kind === 'opposes') {
      opposedBy += acted ? 1 : 0;
      opposes += acted ? 0 : 1;
    } else {
      other += 1;
    }
  }
  const parts = [
    ...count('supported by', supportedBy),
    ...count('opposed by', opposedBy),
    ...count('supports', supports),
    ...count('opposes', opposes),
    ...(other === 0 ? [] : [`${String(other)} other`]),
  ];
  return parts.length === 0 ? 'no relations' : parts.join(' · ');
}

export function readoutOf(view: GraphView, node: ViewNode, typeName: string): Readout {
  return { title: node.title, typeName, fill: node.fill, relations: relationsText(view, node.id) };
}
