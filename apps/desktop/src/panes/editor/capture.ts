import type { NodeType } from './vault-api';

/** The selection as the one line a node is named from. */
export function nodeText(selection: string): string {
  return selection.replace(/\s+/g, ' ').trim();
}

/** A tag as written in a note: one `#`, whether or not the settings gave one. */
function hashTag(tag: string): string {
  return `#${tag.trim().replace(/^#+/, '')}`;
}

/** The tag a type marks candidates with, or null when it has none. */
export function candidateTag(type: NodeType): string | null {
  const tag = type.tag ?? '';
  return hashTag(tag) === '#' ? null : hashTag(tag);
}

/**
 * The selection marked as a candidate node: highlighted, then the type's
 * tag. Space around the selection stays outside the highlight, and a
 * selection over several lines becomes one, since a highlight cannot span them.
 */
export function candidateText(selection: string, type: NodeType): string {
  const leading = /^\s*/.exec(selection)?.[0] ?? '';
  const trailing = selection.trim() === '' ? '' : (/\s*$/.exec(selection)?.[0] ?? '');
  const tag = candidateTag(type);
  const marked = `==${nodeText(selection)}==`;
  return `${leading}${tag === null ? marked : `${marked} ${tag}`}${trailing}`;
}

/** The fixed part of a naming pattern: `CLM - {content}` gives `clm - `. */
function patternPrefix(type: NodeType): string {
  return type.format.replace('{content}', '').toLowerCase();
}

/** The types whose name or naming pattern holds what was typed. */
export function filterTypes(types: readonly NodeType[], query: string): NodeType[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === '') {
    return [...types];
  }
  const starts = types.filter((type) => type.name.toLowerCase().startsWith(wanted));
  const holds = types.filter(
    (type) =>
      !starts.includes(type) &&
      (type.name.toLowerCase().includes(wanted) || patternPrefix(type).includes(wanted)),
  );
  return [...starts, ...holds];
}
