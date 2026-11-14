import { describe, expect, it } from 'vitest';

import { codexArgs, parseCodexLine } from './codex-adapter';

describe('codexArgs', () => {
  it('builds a first message in read-only mode', () => {
    expect(
      codexArgs({ mode: 'read-only', directory: '/Users/x/src', sessionId: null, trusted: true }),
    ).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/Users/x/src',
      '-s',
      'read-only',
      '-',
    ]);
  });

  it('leaves out -C for home and for a path that starts with a tilde', () => {
    const expected = ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-'];
    expect(codexArgs({ mode: 'edit', directory: null, sessionId: null, trusted: true })).toEqual(
      expected,
    );
    expect(codexArgs({ mode: 'edit', directory: '~/src', sessionId: null, trusted: true })).toEqual(
      expected,
    );
  });

  it('resumes the thread for a follow-up, with flags resume accepts', () => {
    expect(
      codexArgs({ mode: 'read-only', directory: '/Users/x/src', sessionId: 'th-1', trusted: true }),
    ).toEqual([
      'exec',
      'resume',
      'th-1',
      '--json',
      '--skip-git-repo-check',
      '-c',
      'sandbox_mode="read-only"',
      '-',
    ]);
    expect(
      codexArgs({ mode: 'edit', directory: null, sessionId: 'th-1', trusted: true }),
    ).toContain('sandbox_mode="workspace-write"');
  });

  it('builds the same arguments whether or not the folder is trusted here', () => {
    for (const sessionId of [null, 'th-1']) {
      const request = { mode: 'edit', directory: '/v', sessionId } as const;
      const untrusted = codexArgs({ ...request, trusted: false });
      expect(untrusted).toEqual(codexArgs({ ...request, trusted: true }));
      // Codex asks before it runs a project's hooks. Nothing here skips that.
      expect(untrusted.some((arg) => arg.includes('bypass'))).toBe(false);
    }
  });

  it('never turns the sandbox off', () => {
    const all = [
      ...codexArgs({ mode: 'read-only', directory: null, sessionId: null, trusted: true }),
      ...codexArgs({ mode: 'edit', directory: null, sessionId: null, trusted: true }),
      ...codexArgs({ mode: 'read-only', directory: null, sessionId: 's', trusted: true }),
      ...codexArgs({ mode: 'edit', directory: null, sessionId: 's', trusted: true }),
    ];
    expect(all.some((arg) => arg.includes('danger'))).toBe(false);
  });
});

describe('parseCodexLine', () => {
  it('reads the thread id', () => {
    expect(parseCodexLine('{"type":"thread.started","thread_id":"th-1"}')).toEqual([
      { type: 'session', id: 'th-1' },
    ]);
  });

  it('gives no events for the start of a turn', () => {
    expect(parseCodexLine('{"type":"turn.started"}')).toEqual([]);
  });

  it('reads a command as a tool call', () => {
    const line =
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}';
    expect(parseCodexLine(line)).toEqual([
      { type: 'tool', id: 'item_1', name: 'Run', summary: 'bash -lc ls' },
    ]);
  });

  it('reads a whole agent message once it is complete', () => {
    const line =
      '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Done."}}';
    expect(parseCodexLine(line)).toEqual([{ type: 'text', text: 'Done.' }]);
    const started =
      '{"type":"item.started","item":{"id":"item_3","type":"agent_message","text":""}}';
    expect(parseCodexLine(started)).toEqual([]);
  });

  it('reads the other tool-like items', () => {
    expect(
      parseCodexLine(
        '{"type":"item.completed","item":{"id":"i1","type":"file_change","changes":[{"path":"a.ts","kind":"update"},{"path":"b.ts","kind":"add"},{"kind":"odd"}]}}',
      ),
    ).toEqual([{ type: 'tool', id: 'i1', name: 'Edit', summary: 'a.ts, b.ts' }]);
    expect(
      parseCodexLine(
        '{"type":"item.started","item":{"id":"i2","type":"mcp_tool_call","server":"docs","tool":"search"}}',
      ),
    ).toEqual([{ type: 'tool', id: 'i2', name: 'docs.search', summary: '' }]);
    expect(
      parseCodexLine(
        '{"type":"item.completed","item":{"id":"i3","type":"web_search","query":"tauri channel"}}',
      ),
    ).toEqual([{ type: 'tool', id: 'i3', name: 'Search', summary: 'tauri channel' }]);
    expect(
      parseCodexLine(
        '{"type":"item.started","item":{"id":"i4","type":"todo_list","items":[{},{}]}}',
      ),
    ).toEqual([{ type: 'tool', id: 'i4', name: 'Plan', summary: '2 steps' }]);
  });

  it('keeps reasoning out of the transcript', () => {
    expect(
      parseCodexLine(
        '{"type":"item.completed","item":{"id":"i5","type":"reasoning","text":"thinking"}}',
      ),
    ).toEqual([]);
  });

  it('keeps an error item as a note, since the turn carries on', () => {
    expect(
      parseCodexLine(
        '{"type":"item.completed","item":{"id":"i6","type":"error","message":"slow down"}}',
      ),
    ).toEqual([{ type: 'note', text: 'slow down' }]);
  });

  it('reads the end of a turn', () => {
    expect(parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":1}}')).toEqual([
      { type: 'done', costUsd: null },
    ]);
  });

  it('reads a failed turn and a stream error', () => {
    expect(parseCodexLine('{"type":"turn.failed","error":{"message":"no quota"}}')).toEqual([
      { type: 'error', message: 'no quota' },
    ]);
    expect(parseCodexLine('{"type":"error","message":"lost connection"}')).toEqual([
      { type: 'error', message: 'lost connection' },
    ]);
  });

  it('still reports a failure whose shape is not the expected one', () => {
    expect(parseCodexLine('{"type":"turn.failed"}')).toEqual([
      { type: 'error', message: 'The turn failed' },
    ]);
    expect(parseCodexLine('{"type":"error","message":{"code":1}}')).toEqual([
      { type: 'error', message: 'The agent reported an error' },
    ]);
  });

  it('keeps a line that is not JSON as a note', () => {
    expect(parseCodexLine('Reading prompt from stdin...')).toEqual([
      { type: 'note', text: 'Reading prompt from stdin...' },
    ]);
  });

  it.each([
    ['a blank line', ''],
    ['an unknown type', '{"type":"session.configured","model":"x"}'],
    ['no type', '{"thread_id":"th"}'],
    ['a JSON number', '42'],
    ['a thread without an id', '{"type":"thread.started"}'],
    ['an item event without an item', '{"type":"item.completed"}'],
    ['an item without a type', '{"type":"item.completed","item":{"id":"x"}}'],
    ['an unknown item type', '{"type":"item.completed","item":{"id":"x","type":"hologram"}}'],
    [
      'a message whose text is not text',
      '{"type":"item.completed","item":{"type":"agent_message","text":[1]}}',
    ],
  ])('gives no events for %s', (_name, line) => {
    expect(parseCodexLine(line)).toEqual([]);
  });

  it('ignores unknown fields on known events', () => {
    const line =
      '{"type":"item.completed","seq":9,"item":{"id":"item_3","type":"agent_message","text":"Hi","phase":"final"}}';
    expect(parseCodexLine(line)).toEqual([{ type: 'text', text: 'Hi' }]);
  });
});
