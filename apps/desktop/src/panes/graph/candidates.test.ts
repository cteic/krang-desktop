import { describe, expect, it } from 'vitest';

import { groupCandidates, noteName } from './candidates';
import { GRAPH, VAULT } from './fixtures';

describe('groupCandidates', () => {
  it('groups the tagged lines by node type, in the settings order', () => {
    const groups = groupCandidates(GRAPH);
    expect(groups.map((group) => [group.name, group.tag, group.fill, group.items.length])).toEqual([
      ['Question', 'que-candidate', '#f2c123', 1],
      ['Claim', 'clm-candidate', '#2e9e82', 1],
    ]);
    expect(groups[1]?.items[0]).toEqual({
      path: `${VAULT}/daily/Monday.md`,
      line: 3,
      text: '- Caching helps #clm-candidate',
      typeId: 'node_c',
    });
  });

  it('leaves out a candidate whose type the settings no longer have', () => {
    const odd = {
      ...GRAPH,
      candidates: [{ path: `${VAULT}/a.md`, line: 1, text: '#old', typeId: 'node_gone' }],
    };
    expect(groupCandidates(odd)).toEqual([]);
  });
});

describe('noteName', () => {
  it('is the file name without its extension', () => {
    expect(noteName('/vault/daily/Monday.md')).toBe('Monday');
    expect(noteName('/vault/Notes.MD')).toBe('Notes');
    expect(noteName('plain')).toBe('plain');
  });
});
