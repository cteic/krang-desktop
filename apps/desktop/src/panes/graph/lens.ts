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

/**
 * How a claim stands on evidence alone. "opposed" has only opposing
 * evidence. "unsupported" has no evidence either way.
 */
export type SupportStatus = 'unsupported' | 'opposed' | 'contested' | 'supported';

export interface Backer {
  /** The id of the node at the other end of the relation. */
  id: string;
  title: string;
  path: string;
}

/** A note listed under a claim that the counts leave out. */
export interface ListedNote extends Backer {
  kind: 'supports' | 'opposes';
}

export interface ClaimRow {
  id: string;
  title: string;
  typeId: string;
  typeName: string;
  path: string;
  /** Evidence that supports the claim. Each note is here once. */
  supports: Backer[];
  /** Evidence that opposes the claim. Each note is here once. */
  opposes: Backer[];
  /** Evidence joined only by a tentative relation. Listed, never counted. */
  tentative: ListedNote[];
  /** Other claims that support or oppose this one. Listed, never counted. */
  related: ListedNote[];
  /** Null when the vault has no relation type the lens can count. */
  status: SupportStatus | null;
}

export interface Lens {
  rows: ClaimRow[];
  /**
   * False when no relation type's label means supports or opposes. Then
   * nothing can be counted, and no claim is given a status.
   */
  counted: boolean;
  unsupported: number;
  opposed: number;
  contested: number;
  supported: number;
}

const CLAIM_TYPE_NAMES: ReadonlySet<string> = new Set(['claim', 'hypothesis', 'conclusion']);

const EVIDENCE_TYPE_NAMES: ReadonlySet<string> = new Set(['evidence', 'result']);

const KIND_WORDS: readonly { kind: RelationKind; forward: RegExp; backward: RegExp }[] = [
  { kind: 'supports', forward: /\bsupports?\b/, backward: /\bsupported by\b/ },
  { kind: 'opposes', forward: /\bopposes?\b/, backward: /\bopposed by\b/ },
  { kind: 'informs', forward: /\binforms?\b/, backward: /\binformed by\b/ },
];

const NEGATION = /\b(?:not|no|never)\b/;

const STATUS_ORDER: Record<SupportStatus, number> = {
  unsupported: 0,
  opposed: 1,
  contested: 2,
  supported: 3,
};

const OTHER: RelationSense = { kind: 'other', inverse: false };

function plain(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True for the node types the lens lists: claims, hypotheses and conclusions. */
export function isClaimType(name: string): boolean {
  return CLAIM_TYPE_NAMES.has(plain(name));
}

/** True for the node types whose notes count for or against a claim. */
export function isEvidenceType(name: string): boolean {
  return EVIDENCE_TYPE_NAMES.has(plain(name));
}

/**
 * What a relation label means, whatever its capitals. The word has to
 * stand whole in the label: "Supports (strong)" is supports, and
 * "unsupported by" is nothing. A label that reads from the far end, such
 * as "is supported by", gives the same kind with `inverse` set. A label
 * with a "not" in it, or with two of the words, is left alone.
 */
export function relationSense(label: string): RelationSense {
  const text = plain(label);
  if (NEGATION.test(text)) {
    return OTHER;
  }
  const found: RelationSense[] = [];
  for (const { kind, forward, backward } of KIND_WORDS) {
    if (backward.test(text)) {
      found.push({ kind, inverse: true });
    } else if (forward.test(text)) {
      found.push({ kind, inverse: false });
    }
  }
  const [only] = found;
  return only !== undefined && found.length === 1 ? only : OTHER;
}

/**
 * What a relation type means, from its label, or from its complement when
 * the label says nothing. The complement reads from the far end, so its
 * direction is the other way round. Nothing else decides direction: a
 * relation is read the way it is stored.
 */
export function relationTypeSense(type: { label: string; complement: string }): RelationSense {
  const fromLabel = relationSense(type.label);
  if (fromLabel.kind !== 'other') {
    return fromLabel;
  }
  const fromComplement = relationSense(type.complement);
  return fromComplement.kind === 'other'
    ? OTHER
    : { kind: fromComplement.kind, inverse: !fromComplement.inverse };
}

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function byTitle(a: Backer, b: Backer): number {
  return compareText(a.title, b.title) || compareText(a.id, b.id);
}

function statusOf(row: ClaimRow): SupportStatus {
  if (row.supports.length > 0) {
    return row.opposes.length > 0 ? 'contested' : 'supported';
  }
  return row.opposes.length > 0 ? 'opposed' : 'unsupported';
}

/** Adds a note to a list unless the list already has it for that kind. */
function addOnce<Item extends Backer>(list: Item[], item: Item, same: (other: Item) => boolean) {
  if (!list.some((other) => other.id === item.id && same(other))) {
    list.push(item);
  }
}

/**
 * Sorts out every claim, hypothesis and conclusion by the evidence for and
 * against it. Only evidence and result notes are counted, each once per
 * side. A claim that supports another claim is listed as related, and a
 * tentative relation is listed as tentative. Neither is counted.
 */
export function buildLens(graph: VaultGraph): Lens {
  const typeNames = new Map(graph.nodeTypes.map((type) => [type.id, type.name]));
  const senses = new Map(graph.relationTypes.map((type) => [type.id, relationTypeSense(type)]));
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const counted = [...senses.values()].some(
    (sense) => sense.kind === 'supports' || sense.kind === 'opposes',
  );

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
        tentative: [],
        related: [],
        status: null,
      });
    }
  }

  const pending: { claim: ClaimRow; note: ListedNote }[] = [];
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
    const { kind } = sense;
    const claim = rows.get(sense.inverse ? source.id : destination.id);
    const backer = sense.inverse ? destination : source;
    if (claim === undefined || backer.id === claim.id) {
      continue;
    }
    const note: ListedNote = { id: backer.id, title: backer.title, path: backer.path, kind };
    const backerType = typeNames.get(backer.typeId) ?? '';
    if (rows.has(backer.id)) {
      addOnce(claim.related, note, (other) => other.kind === kind);
    } else if (!isEvidenceType(backerType)) {
      continue;
    } else if (relation.tentative === false) {
      pending.push({ claim, note });
    } else {
      addOnce(claim[kind], { id: note.id, title: note.title, path: note.path }, () => true);
    }
  }
  // A tentative relation is listed only when no accepted one says the same.
  for (const { claim, note } of pending) {
    if (!claim[note.kind].some((backer) => backer.id === note.id)) {
      addOnce(claim.tentative, note, (other) => other.kind === note.kind);
    }
  }

  const lens: Lens = {
    rows: [],
    counted,
    unsupported: 0,
    opposed: 0,
    contested: 0,
    supported: 0,
  };
  for (const row of rows.values()) {
    row.supports.sort(byTitle);
    row.opposes.sort(byTitle);
    row.tentative.sort(byTitle);
    row.related.sort(byTitle);
    if (counted) {
      const status = statusOf(row);
      row.status = status;
      lens[status] += 1;
    }
    lens.rows.push(row);
  }
  lens.rows.sort(
    (a, b) =>
      (a.status === null ? 0 : STATUS_ORDER[a.status]) -
        (b.status === null ? 0 : STATUS_ORDER[b.status]) ||
      b.opposes.length - a.opposes.length ||
      compareText(a.title, b.title) ||
      compareText(a.id, b.id),
  );
  return lens;
}

/**
 * The line above the list, such as "14 claims by evidence: 6 unsupported,
 * 1 opposed, 2 contested, 5 supported".
 */
export function lensSummary(lens: Lens): string {
  const total = lens.rows.length;
  if (total === 0) {
    return 'No claims, hypotheses or conclusions in this vault.';
  }
  const claims = `${String(total)} ${total === 1 ? 'claim' : 'claims'}`;
  if (!lens.counted) {
    return `${claims}. Support is not counted: no relation type here is labelled supports or opposes.`;
  }
  return `${claims} by evidence: ${String(lens.unsupported)} unsupported, ${String(lens.opposed)} opposed, ${String(lens.contested)} contested, ${String(lens.supported)} supported`;
}
