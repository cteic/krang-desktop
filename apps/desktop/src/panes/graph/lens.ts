import type { VaultGraph } from './vault-graph';

/**
 * The support lens: how well each claim in a vault is backed by evidence.
 * Everything here is worked out from the relations file, never from a
 * canvas drawing.
 */

export type RelationKind = 'supports' | 'opposes' | 'informs' | 'other';

export interface RelationSense {
  kind: RelationKind;
  /** True when the label reads from the far end, as in "is supported by". */
  inverse: boolean;
}

export type SupportStatus = 'unsupported' | 'contested' | 'supported';

export interface Backer {
  /** The id of the node at the other end of the relation. */
  id: string;
  title: string;
  path: string;
}

export interface ClaimRow {
  id: string;
  title: string;
  typeId: string;
  typeName: string;
  path: string;
  supports: Backer[];
  opposes: Backer[];
  status: SupportStatus;
}

export interface Lens {
  rows: ClaimRow[];
  unsupported: number;
  contested: number;
  supported: number;
}

const CLAIM_TYPE_NAMES: ReadonlySet<string> = new Set(['claim', 'hypothesis', 'conclusion']);

const FORWARD: Record<string, RelationKind> = {
  supports: 'supports',
  opposes: 'opposes',
  informs: 'informs',
};

const BACKWARD: Record<string, RelationKind> = {
  'is supported by': 'supports',
  'supported by': 'supports',
  'is opposed by': 'opposes',
  'opposed by': 'opposes',
  'is informed by': 'informs',
  'informed by': 'informs',
};

const STATUS_ORDER: Record<SupportStatus, number> = { unsupported: 0, contested: 1, supported: 2 };

function plain(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True for the node types the lens lists: claims, hypotheses and conclusions. */
export function isClaimType(name: string): boolean {
  return CLAIM_TYPE_NAMES.has(plain(name));
}

/**
 * What a relation label means, whatever its capitals. A label that reads
 * from the far end, such as "is supported by", gives the same kind with
 * `inverse` set.
 */
export function relationSense(label: string): RelationSense {
  const text = plain(label);
  const forward = FORWARD[text];
  if (forward !== undefined) {
    return { kind: forward, inverse: false };
  }
  const backward = BACKWARD[text];
  if (backward !== undefined) {
    return { kind: backward, inverse: true };
  }
  return { kind: 'other', inverse: false };
}

/**
 * Finds which end of each relation is the one acted on: the node that is
 * supported, opposed or informed. Usually that is the destination. It is
 * the source when the label reads from the far end, or when the settings
 * allow this relation type only the other way round between the two node
 * types, which means the relation was stored back to front.
 */
export function relationReader(
  graph: Pick<VaultGraph, 'allowedRelations'>,
): (relationTypeId: string, sourceTypeId: string, destinationTypeId: string) => boolean {
  const allowed = new Set(
    graph.allowedRelations.map(
      (rule) => `${rule.relationTypeId}\u0000${rule.sourceTypeId}\u0000${rule.destinationTypeId}`,
    ),
  );
  return (relationTypeId, sourceTypeId, destinationTypeId) => {
    const asStored = allowed.has(
      `${relationTypeId}\u0000${sourceTypeId}\u0000${destinationTypeId}`,
    );
    const turned = allowed.has(`${relationTypeId}\u0000${destinationTypeId}\u0000${sourceTypeId}`);
    return turned && !asStored;
  };
}

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** Sorts out every claim, hypothesis and conclusion by how well it is backed. */
export function buildLens(graph: VaultGraph): Lens {
  const typeNames = new Map(graph.nodeTypes.map((type) => [type.id, type.name]));
  const senses = new Map(graph.relationTypes.map((type) => [type.id, relationSense(type.label)]));
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const storedBackwards = relationReader(graph);

  const rows = new Map<string, ClaimRow>();
  for (const node of graph.nodes) {
    const typeName = typeNames.get(node.typeId);
    if (typeName !== undefined && isClaimType(typeName)) {
      rows.set(node.id, {
        id: node.id,
        title: node.title,
        typeId: node.typeId,
        typeName,
        path: node.path,
        supports: [],
        opposes: [],
        status: 'unsupported',
      });
    }
  }

  for (const relation of graph.relations) {
    const sense = senses.get(relation.typeId);
    const source = nodes.get(relation.source);
    const destination = nodes.get(relation.destination);
    if (sense === undefined || source === undefined || destination === undefined) {
      continue;
    }
    if (sense.kind !== 'supports' && sense.kind !== 'opposes') {
      continue;
    }
    const turned =
      sense.inverse !== storedBackwards(relation.typeId, source.typeId, destination.typeId);
    const claim = rows.get(turned ? source.id : destination.id);
    const backer = turned ? destination : source;
    if (claim === undefined || backer.id === claim.id) {
      continue;
    }
    claim[sense.kind].push({ id: backer.id, title: backer.title, path: backer.path });
  }

  const lens: Lens = { rows: [], unsupported: 0, contested: 0, supported: 0 };
  for (const row of rows.values()) {
    row.supports.sort((a, b) => compareText(a.title, b.title) || compareText(a.id, b.id));
    row.opposes.sort((a, b) => compareText(a.title, b.title) || compareText(a.id, b.id));
    if (row.supports.length > 0) {
      row.status = row.opposes.length > 0 ? 'contested' : 'supported';
    }
    lens[row.status] += 1;
    lens.rows.push(row);
  }
  lens.rows.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      b.opposes.length - a.opposes.length ||
      compareText(a.title, b.title) ||
      compareText(a.id, b.id),
  );
  return lens;
}

/** The line above the list, such as "14 claims: 6 unsupported, 2 contested, 6 supported". */
export function lensSummary(lens: Lens): string {
  const total = lens.rows.length;
  if (total === 0) {
    return 'No claims, hypotheses or conclusions in this vault.';
  }
  return `${String(total)} ${total === 1 ? 'claim' : 'claims'}: ${String(lens.unsupported)} unsupported, ${String(lens.contested)} contested, ${String(lens.supported)} supported`;
}
