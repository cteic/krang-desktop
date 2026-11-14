import type { VaultGraph } from './vault-graph';

/**
 * The vault's health: everything that was left out of the picture or may
 * be drawn wrong, one row per note, relation or file.
 */

export interface IssueRow {
  key: string;
  text: string;
  /** The note to open for this row. Null when the row is not about one note. */
  path: string | null;
}

export interface IssueGroup {
  kind: string;
  title: string;
  rows: IssueRow[];
}

/** The groups in the order they are listed, with the heading of each. */
const GROUPS: [string, string][] = [
  ['file', 'Files that could not be read'],
  ['limit', 'Limits reached'],
  ['sharedId', 'Notes that share an instance id'],
  ['skippedRelation', 'Relations left out'],
  ['ambiguous', 'Relations that may be drawn to the wrong note'],
  ['missingNote', 'Canvas boxes whose note is missing'],
  ['canvas', 'Canvas shapes not drawn'],
  ['more', 'More'],
];

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** Sorts what is wrong with a vault into groups. A group with nothing in it is left out. */
export function buildIssues(graph: VaultGraph): IssueGroup[] {
  const rows = new Map<string, IssueRow[]>();
  function add(kind: string, text: string, path: string | null) {
    const list = rows.get(kind) ?? [];
    list.push({ key: `${kind}:${String(list.length)}`, text, path });
    rows.set(kind, list);
  }

  for (const issue of graph.issues) {
    add(issue.kind, issue.text, issue.path);
  }

  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const labels = new Map(graph.relationTypes.map((type) => [type.id, type.label]));
  for (const relation of graph.relations) {
    if (!relation.ambiguous) {
      continue;
    }
    const source = nodes.get(relation.source);
    const destination = nodes.get(relation.destination);
    // The second note to carry an id is given it with `#2` on the end.
    const shared = nodes.has(`${relation.source}#2`) ? source : destination;
    add(
      'ambiguous',
      `${labels.get(relation.typeId) ?? 'relation'}: "${source?.title ?? relation.source}" to "${destination?.title ?? relation.destination}"`,
      shared?.path ?? null,
    );
  }

  for (const canvas of graph.canvases) {
    const pageNames = new Map(canvas.pages.map((page) => [page.id, page.name]));
    for (const node of canvas.nodes) {
      if (node.path === null) {
        const page = canvas.pages.length > 1 ? ` / ${pageNames.get(node.pageId) ?? ''}` : '';
        add('missingNote', `"${node.title}" on ${canvas.name}${page}`, null);
      }
    }
    if (canvas.unboundRelations > 0) {
      add(
        'canvas',
        `${canvas.name}: ${plural(canvas.unboundRelations, 'arrow is', 'arrows are')} not attached to a box at both ends`,
        null,
      );
    }
    if (canvas.otherShapes > 0) {
      add(
        'canvas',
        `${canvas.name}: ${plural(canvas.otherShapes, 'other shape is', 'other shapes are')} not drawn`,
        null,
      );
    }
  }

  const known = new Set(GROUPS.map(([kind]) => kind));
  const groups: IssueGroup[] = [];
  for (const [kind, title] of GROUPS) {
    const list = rows.get(kind);
    if (list !== undefined) {
      groups.push({ kind, title, rows: list });
    }
  }
  for (const [kind, list] of rows) {
    if (!known.has(kind)) {
      groups.push({ kind, title: 'Other', rows: list });
    }
  }
  return groups;
}

export function issueCount(groups: readonly IssueGroup[]): number {
  return groups.reduce((sum, group) => sum + group.rows.length, 0);
}
