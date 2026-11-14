import { describe, expect, it } from 'vitest';

import { findLanguage } from './editor-language';

describe('findLanguage', () => {
  it('chooses a language from the file extension', () => {
    expect(findLanguage('/src/main.rs')?.name).toBe('Rust');
    expect(findLanguage('/src/app.tsx')?.name).toBe('TSX');
    expect(findLanguage('~/x/data.json')?.name).toBe('JSON');
    expect(findLanguage('script.py')?.name).toBe('Python');
  });

  it('matches whole file names too', () => {
    expect(findLanguage('/repo/Dockerfile')?.name).toBe('Dockerfile');
  });

  it('is null for a file it does not know', () => {
    expect(findLanguage('/a/notes.unknownext')).toBeNull();
    expect(findLanguage('/a/LICENSE')).toBeNull();
  });
});
