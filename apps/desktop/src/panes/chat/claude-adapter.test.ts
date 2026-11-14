import { describe, expect, it } from 'vitest';

import { claudeArgs, parseClaudeLine, summariseToolInput } from './claude-adapter';

describe('claudeArgs', () => {
  it('builds a first message in read-only mode', () => {
    expect(claudeArgs({ mode: 'read-only', directory: '~/src', sessionId: null })).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      'plan',
    ]);
  });

  it('resumes the session for a follow-up', () => {
    expect(claudeArgs({ mode: 'edit', directory: null, sessionId: 'abc-123' })).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Bash(kd node:*)',
      'Bash(kd relate:*)',
      'Bash(kd types:*)',
      'Bash(kd nodes:*)',
      '--resume',
      'abc-123',
    ]);
  });

  it('allows an editing chat the four graph commands and nothing wider', () => {
    const args = claudeArgs({ mode: 'edit', directory: '~/vault', sessionId: null });
    const start = args.indexOf('--allowedTools');
    expect(args.slice(start + 1)).toEqual([
      'Bash(kd node:*)',
      'Bash(kd relate:*)',
      'Bash(kd types:*)',
      'Bash(kd nodes:*)',
    ]);
    // The bare tool would also allow the commands that drive the app.
    for (const tool of ['Bash', 'Bash(kd:*)', 'Bash(kd *)', 'Bash(*)']) {
      expect(args).not.toContain(tool);
    }
    expect(args.some((arg) => /kd (term|layout|view|web|chat|skill|vault)/.test(arg))).toBe(false);
  });

  it('allows no shell command in read-only mode', () => {
    const args = claudeArgs({ mode: 'read-only', directory: null, sessionId: 's' });
    expect(args).not.toContain('--allowedTools');
    expect(args.some((arg) => arg.startsWith('Bash'))).toBe(false);
  });

  it('never passes a flag that skips permissions or the login', () => {
    const all = [
      ...claudeArgs({ mode: 'read-only', directory: null, sessionId: 's' }),
      ...claudeArgs({ mode: 'edit', directory: null, sessionId: 's' }),
    ];
    expect(all).not.toContain('--bare');
    expect(all).not.toContain('bypassPermissions');
    expect(all.some((arg) => arg.includes('dangerously'))).toBe(false);
  });
});

describe('parseClaudeLine', () => {
  it('reads the session id from the init event', () => {
    const line =
      '{"type":"system","subtype":"init","session_id":"s-1","model":"m","tools":["Read"]}';
    expect(parseClaudeLine(line)).toEqual([{ type: 'session', id: 's-1' }]);
  });

  it('ignores other system events', () => {
    expect(parseClaudeLine('{"type":"system","subtype":"status","session_id":"s-1"}')).toEqual([]);
  });

  it('reads a streamed text delta', () => {
    const line =
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}';
    expect(parseClaudeLine(line)).toEqual([{ type: 'text-delta', text: 'Hi' }]);
  });

  it('ignores deltas that are not text', () => {
    const line =
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}}';
    expect(parseClaudeLine(line)).toEqual([]);
  });

  it('reads the start of a tool call', () => {
    const line =
      '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"t1","name":"Read","input":{}}}}';
    expect(parseClaudeLine(line)).toEqual([{ type: 'tool', id: 't1', name: 'Read', summary: '' }]);
  });

  it('ignores the start of a text block', () => {
    const line =
      '{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text","text":""}}}';
    expect(parseClaudeLine(line)).toEqual([]);
  });

  it('reads whole text and tool blocks from an assistant message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Looking.' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/app.tsx' } },
          { type: 'thinking', thinking: 'hmm' },
          'not a block',
        ],
      },
    });
    expect(parseClaudeLine(line)).toEqual([
      { type: 'text', text: 'Looking.' },
      { type: 'tool', id: 't1', name: 'Read', summary: 'src/app.tsx' },
    ]);
  });

  it('reads a successful result with its cost', () => {
    const line =
      '{"type":"result","subtype":"success","is_error":false,"result":"Hi","session_id":"s-2","total_cost_usd":0.01}';
    expect(parseClaudeLine(line)).toEqual([
      { type: 'session', id: 's-2' },
      { type: 'done', costUsd: 0.01 },
    ]);
  });

  it('reads a failed result with its errors', () => {
    const line =
      '{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"s-2","errors":["boom","again"]}';
    expect(parseClaudeLine(line)).toEqual([
      { type: 'session', id: 's-2' },
      { type: 'error', message: 'boom\nagain' },
    ]);
  });

  it('names the subtype when a failed result says nothing else', () => {
    expect(parseClaudeLine('{"type":"result","subtype":"error_max_turns"}')).toEqual([
      { type: 'error', message: 'error_max_turns' },
    ]);
  });

  it('treats is_error on a success subtype as an error', () => {
    const line = '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in"}';
    expect(parseClaudeLine(line)).toEqual([{ type: 'error', message: 'Not logged in' }]);
  });

  it('keeps a line that is not JSON as a note', () => {
    expect(parseClaudeLine('  Warning: something odd  ')).toEqual([
      { type: 'note', text: 'Warning: something odd' },
    ]);
    expect(parseClaudeLine('{"type":"assistant"')).toEqual([
      { type: 'note', text: '{"type":"assistant"' },
    ]);
  });

  it.each([
    ['a blank line', '   '],
    ['an unknown type', '{"type":"rate_limit_event","info":{}}'],
    ['a user event', '{"type":"user","message":{"content":[]}}'],
    ['no type', '{"session_id":"s"}'],
    ['a type that is not text', '{"type":7}'],
    ['a JSON array', '[1,2]'],
    ['a JSON string', '"hello"'],
    ['null', 'null'],
    ['an init without a session id', '{"type":"system","subtype":"init"}'],
    ['a stream event without an event', '{"type":"stream_event"}'],
    [
      'a delta without text',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta"}}}',
    ],
    [
      'a delta whose text is a number',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":5}}}',
    ],
    ['an assistant without content', '{"type":"assistant","message":{}}'],
    [
      'a result whose cost is text',
      '{"type":"result","subtype":"success","total_cost_usd":"free"}',
    ],
  ])('gives no events for %s', (_name, line) => {
    expect(parseClaudeLine(line)).toEqual([]);
  });

  it('ignores unknown fields on known events', () => {
    const line =
      '{"type":"stream_event","uuid":"u","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"A","extra":1}}}';
    expect(parseClaudeLine(line)).toEqual([{ type: 'text-delta', text: 'A' }]);
  });
});

describe('summariseToolInput', () => {
  it('prefers the file path', () => {
    expect(summariseToolInput({ limit: 5, file_path: 'a.ts', description: 'x' })).toBe('a.ts');
  });

  it('flattens a command onto one line', () => {
    expect(summariseToolInput({ command: 'ls\n  -la' })).toBe('ls -la');
  });

  it('falls back to the first text value, then to JSON', () => {
    expect(summariseToolInput({ count: 2, subject: 'Tidy up' })).toBe('Tidy up');
    expect(summariseToolInput({ count: 2 })).toBe('{"count":2}');
  });

  it('gives nothing for an empty or missing input', () => {
    expect(summariseToolInput({})).toBe('');
    expect(summariseToolInput(undefined)).toBe('');
    expect(summariseToolInput(null)).toBe('');
  });

  it('cuts a long summary', () => {
    const summary = summariseToolInput({ command: 'x'.repeat(500) });
    expect(summary.length).toBe(120);
    expect(summary.endsWith('…')).toBe(true);
  });
});
