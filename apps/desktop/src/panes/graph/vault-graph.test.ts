import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GRAPH } from './fixtures';
import {
  errorText,
  fetchFingerprint,
  fetchGraph,
  parseFingerprint,
  parseGraph,
} from './vault-graph';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe('parseGraph', () => {
  it('accepts the shape the Rust side sends', () => {
    expect(parseGraph(structuredClone(GRAPH))).toEqual(GRAPH);
  });

  it('drops fields it does not know, so nothing unexpected is carried along', () => {
    const reply = { ...structuredClone(GRAPH), spacePassword: 'hunter2' };
    expect('spacePassword' in parseGraph(reply)).toBe(false);
  });

  it('rejects a reply of the wrong shape', () => {
    const wrong: unknown[] = [
      null,
      'graph',
      {},
      { ...GRAPH, nodes: [{ id: 'a' }] },
      { ...GRAPH, skippedRelations: -1 },
      { ...GRAPH, relations: [{ ...GRAPH.relations[0], tentative: 'no' }] },
      { ...GRAPH, canvases: [{ name: 'x' }] },
    ];
    for (const reply of wrong) {
      expect(() => parseGraph(reply)).toThrow('a shape this pane does not understand');
    }
  });
});

describe('parseFingerprint', () => {
  it('accepts a non-empty text and nothing else', () => {
    expect(parseFingerprint('5-00ff')).toBe('5-00ff');
    expect(() => parseFingerprint('')).toThrow();
    expect(() => parseFingerprint(5)).toThrow();
    expect(() => parseFingerprint(null)).toThrow();
  });
});

describe('fetchGraph and fetchFingerprint', () => {
  it('ask the Rust side by path and check the answer', async () => {
    vi.mocked(invoke).mockImplementation((command: string) =>
      Promise.resolve(command === 'graph_read' ? structuredClone(GRAPH) : '5-00ff'),
    );
    await expect(fetchGraph('~/vault')).resolves.toEqual(GRAPH);
    await expect(fetchFingerprint('~/vault')).resolves.toBe('5-00ff');
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['graph_read', { path: '~/vault' }],
      ['graph_fingerprint', { path: '~/vault' }],
    ]);
  });

  it('pass a failure on', async () => {
    vi.mocked(invoke).mockRejectedValue('/nope: No such file or directory (os error 2)');
    await expect(fetchGraph('/nope')).rejects.toBe('/nope: No such file or directory (os error 2)');
  });
});

describe('errorText', () => {
  it('reads the text out of whatever was thrown', () => {
    expect(errorText('plain')).toBe('plain');
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText(42)).toBe('42');
  });
});
