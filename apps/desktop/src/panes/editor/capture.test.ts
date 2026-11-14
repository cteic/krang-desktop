import { describe, expect, it } from 'vitest';

import { candidateTag, candidateText, filterTypes, nodeText } from './capture';
import type { NodeType } from './vault-api';

const CLAIM: NodeType = {
  id: 'n-clm',
  name: 'Claim',
  format: 'CLM - {content}',
  color: '#7DA13E',
  tag: 'clm-candidate',
};
const QUESTION: NodeType = {
  id: 'n-que',
  name: 'Question',
  format: 'QUE - {content}',
  color: null,
};
const EVIDENCE: NodeType = { id: 'n-evd', name: 'Evidence', format: 'EVD - {content}', tag: '' };

describe('nodeText', () => {
  it('makes one trimmed line of the selection', () => {
    expect(nodeText('  first line\n\tsecond   line \n')).toBe('first line second line');
  });
});

describe('candidateText', () => {
  it('highlights the selection and adds the tag of the type', () => {
    expect(candidateText('a bold claim', CLAIM)).toBe('==a bold claim== #clm-candidate');
  });

  it('adds no tag for a type that has none', () => {
    expect(candidateText('an open question', QUESTION)).toBe('==an open question==');
    expect(candidateText('a result', EVIDENCE)).toBe('==a result==');
    expect(candidateTag(QUESTION)).toBeNull();
  });

  it('writes one hash whether or not the settings gave one', () => {
    expect(candidateTag({ ...CLAIM, tag: '#clm-candidate' })).toBe('#clm-candidate');
  });

  it('keeps the space around the selection outside the highlight', () => {
    expect(candidateText(' a claim\n', CLAIM)).toBe(' ==a claim== #clm-candidate\n');
    expect(candidateText('two\nlines', CLAIM)).toBe('==two lines== #clm-candidate');
  });
});

describe('filterTypes', () => {
  const types = [CLAIM, QUESTION, EVIDENCE];

  it('returns every type for an empty query', () => {
    expect(filterTypes(types, '  ')).toEqual(types);
  });

  it('puts names that start with the query first, then other matches', () => {
    expect(filterTypes(types, 'e').map((type) => type.name)).toEqual(['Evidence', 'Question']);
    expect(filterTypes(types, 'clm').map((type) => type.name)).toEqual(['Claim']);
    expect(filterTypes(types, 'zzz')).toEqual([]);
  });
});
