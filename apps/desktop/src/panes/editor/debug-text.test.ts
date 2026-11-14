import { describe, expect, it } from 'vitest';

import { debugText } from './debug-text';

describe('debugText', () => {
  it('puts path, dirty and view on line one, then the buffer', () => {
    const text = debugText({ path: '~/notes/a.md', dirty: true, view: 'split', text: '# A\nb' });
    expect(text).toBe('path=~/notes/a.md dirty=true view=split\n# A\nb');
  });

  it('writes null for a buffer with no path', () => {
    expect(debugText({ path: null, dirty: false, view: 'edit', text: '' })).toBe(
      'path=null dirty=false view=edit\n',
    );
  });
});
