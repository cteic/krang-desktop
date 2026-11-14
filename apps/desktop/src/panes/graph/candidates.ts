import { nodeColor } from './colors';
import type { Candidate, VaultGraph } from './vault-graph';

/**
 * Candidates: lines in ordinary notes that carry a node type's tag, such
 * as `#clm-candidate`. Each is a thought someone marked to become a node.
 */

export interface CandidateGroup {
  typeId: string;
  name: string;
  tag: string;
  fill: string;
  items: Candidate[];
}

/** The candidates by node type, in the settings' order. A type with none is left out. */
export function groupCandidates(graph: VaultGraph): CandidateGroup[] {
  const byType = new Map<string, Candidate[]>();
  for (const candidate of graph.candidates) {
    byType.set(candidate.typeId, [...(byType.get(candidate.typeId) ?? []), candidate]);
  }
  const groups: CandidateGroup[] = [];
  for (const type of graph.nodeTypes) {
    const items = byType.get(type.id);
    if (items !== undefined) {
      groups.push({
        typeId: type.id,
        name: type.name,
        tag: type.tag ?? '',
        fill: nodeColor(type.color),
        items,
      });
    }
  }
  return groups;
}

/** A note's name as shown in a list: its file name without the extension. */
export function noteName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}
