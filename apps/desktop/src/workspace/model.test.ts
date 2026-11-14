import { describe, expect, it } from 'vitest';

import { paneTitle } from './model';
import type { LeafNode, PaneContent } from './model';

function leaf(content: PaneContent, title: string | null = null): LeafNode {
  return { kind: 'leaf', id: 'p1', title, badge: null, content };
}

describe('paneTitle', () => {
  it('prefers a title that was set', () => {
    expect(paneTitle(leaf({ type: 'web', url: 'https://example.com' }, 'docs'))).toBe('docs');
  });

  it('names a web pane after its host', () => {
    expect(paneTitle(leaf({ type: 'web', url: 'http://127.0.0.1:4747/issues' }))).toBe(
      '127.0.0.1:4747',
    );
  });

  it('names a local page after its file, not the placeholder host', () => {
    const url = 'localfile://localhost/Users/x/my%20site/hello.html';
    expect(paneTitle(leaf({ type: 'web', url }))).toBe('hello.html');
  });

  it('names files and editor panes after the last path segment', () => {
    expect(paneTitle(leaf({ type: 'files', directory: '/Users/x/krang/' }))).toBe('krang');
    expect(paneTitle(leaf({ type: 'editor', path: '~/notes/today.md' }))).toBe('today.md');
  });

  it('names a graph pane after its vault folder', () => {
    expect(paneTitle(leaf({ type: 'graph', directory: '~/notes/lab vault/', view: null }))).toBe(
      'lab vault',
    );
    expect(paneTitle(leaf({ type: 'graph', directory: '/vault', view: 'Overview' }))).toBe('vault');
    expect(paneTitle(leaf({ type: 'graph', directory: null, view: null }))).toBe('graph');
    expect(paneTitle(leaf({ type: 'graph', directory: '/vault', view: null }, 'claims'))).toBe(
      'claims',
    );
  });

  it('falls back to the pane type', () => {
    expect(paneTitle(leaf({ type: 'terminal', directory: null, commands: [] }))).toBe('terminal');
    expect(paneTitle(leaf({ type: 'editor', path: null }))).toBe('untitled');
    expect(paneTitle(leaf({ type: 'web', url: '' }))).toBe('');
  });
});
