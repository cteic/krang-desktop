import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { errorText, parseIssues } from './issues';

/** One issue as `krang issue ls --json` prints it, with fields the pane ignores. */
const PRINTED = JSON.stringify([
  {
    id: 'CTE-176',
    title: 'Roll out Renovate',
    status: 'in_progress',
    project: 'foundation',
    priority: 'urgent',
    labels: [],
    blocked_by: [],
    claimed_by: null,
    related: ['CTE-172'],
    updated: '2026-11-09T13:41:21.935Z',
    description: 'Long text',
  },
]);

describe('parseIssues', () => {
  it('keeps the fields the pane shows and drops the rest', () => {
    expect(parseIssues(PRINTED)).toEqual([
      {
        id: 'CTE-176',
        title: 'Roll out Renovate',
        status: 'in_progress',
        project: 'foundation',
        priority: 'urgent',
        blocked_by: [],
        claimed_by: null,
        updated: '2026-11-09T13:41:21.935Z',
      },
    ]);
  });

  it('refuses a reply in another shape', () => {
    expect(() => parseIssues('{"issues": []}')).toThrow(ZodError);
  });

  it('refuses text that is not JSON', () => {
    expect(() => parseIssues('Unknown flag --json')).toThrow(SyntaxError);
  });
});

describe('errorText', () => {
  it('names the problem without the parser detail', () => {
    expect(errorText(new SyntaxError('Unexpected token'))).toBe(
      'krang printed something that is not JSON',
    );
  });

  it('passes on a message from the Rust side as it is', () => {
    expect(errorText('krang is not installed')).toBe('krang is not installed');
  });
});
