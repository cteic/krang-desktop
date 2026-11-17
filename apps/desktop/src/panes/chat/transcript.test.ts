import { describe, expect, it } from 'vitest';

import type { AgentEvent } from './agent-event';
import {
  EMPTY_TRANSCRIPT,
  type Transcript,
  type TranscriptAction,
  stderrTail,
  transcriptReducer,
  transcriptText,
} from './transcript';

function run(actions: TranscriptAction[], from: Transcript = EMPTY_TRANSCRIPT): Transcript {
  return actions.reduce(transcriptReducer, from);
}

function ev(event: AgentEvent): TranscriptAction {
  return { type: 'event', event };
}

function send(text: string): TranscriptAction {
  return { type: 'send', text };
}

/** The transcript as short lines, which is easier to read than objects. */
function lines(state: Transcript): string[] {
  return transcriptText('a', 'm', state).split('\n').slice(1);
}

describe('transcriptReducer', () => {
  it('starts idle and empty', () => {
    expect(EMPTY_TRANSCRIPT).toEqual({
      items: [],
      sessionId: null,
      status: 'idle',
      nextKey: 1,
      truncated: false,
      openRun: null,
    });
  });

  it('adds the message and starts running on send', () => {
    const state = run([send('hello')]);
    expect(state.status).toBe('running');
    expect(lines(state)).toEqual(['you: hello']);
  });

  it('records the session id, and the newest one wins', () => {
    const state = run([
      send('hi'),
      ev({ type: 'session', id: 's-1' }),
      ev({ type: 'session', id: 's-2' }),
    ]);
    expect(state.sessionId).toBe('s-2');
  });

  it('streams deltas into one assistant message', () => {
    const state = run([
      send('hi'),
      ev({ type: 'text-delta', text: 'Hel' }),
      ev({ type: 'text-delta', text: 'lo' }),
    ]);
    expect(lines(state)).toEqual(['you: hi', 'agent: Hello']);
    expect(state.items[1]).toMatchObject({ kind: 'assistant', streaming: true });
  });

  it('does not show the text twice when the whole message follows its deltas', () => {
    const state = run([
      send('hi'),
      ev({ type: 'text-delta', text: 'Hel' }),
      ev({ type: 'text-delta', text: 'lo' }),
      ev({ type: 'text', text: 'Hello' }),
    ]);
    expect(lines(state)).toEqual(['you: hi', 'agent: Hello']);
    expect(state.items[1]).toMatchObject({ streaming: false, unconfirmed: false });
  });

  it('takes the whole text when the deltas were only part of it', () => {
    const state = run([
      send('hi'),
      ev({ type: 'text-delta', text: 'Hel' }),
      ev({ type: 'text', text: 'Hello there' }),
    ]);
    expect(lines(state)).toEqual(['you: hi', 'agent: Hello there']);
  });

  it('matches the whole message to its deltas even after a tool note', () => {
    const state = run([
      send('hi'),
      ev({ type: 'text-delta', text: 'Looking.' }),
      ev({ type: 'tool', id: 't1', name: 'Read', summary: '' }),
      ev({ type: 'text', text: 'Looking.' }),
      ev({ type: 'tool', id: 't1', name: 'Read', summary: 'a.ts' }),
    ]);
    expect(lines(state)).toEqual(['you: hi', 'agent: Looking.', 'tool: Read a.ts']);
  });

  it('keeps two streamed messages in one turn apart', () => {
    const state = run([
      send('hi'),
      ev({ type: 'text-delta', text: 'First.' }),
      ev({ type: 'text', text: 'First.' }),
      ev({ type: 'tool', id: 't1', name: 'Read', summary: 'a.ts' }),
      ev({ type: 'text-delta', text: 'Sec' }),
      ev({ type: 'text-delta', text: 'ond.' }),
      ev({ type: 'text', text: 'Second.' }),
    ]);
    expect(lines(state)).toEqual(['you: hi', 'agent: First.', 'tool: Read a.ts', 'agent: Second.']);
  });

  it('starts a new message for deltas that come after a tool note', () => {
    const state = run([
      send('hi'),
      ev({ type: 'text-delta', text: 'One' }),
      ev({ type: 'tool', id: null, name: 'Run', summary: 'ls' }),
      ev({ type: 'text-delta', text: 'Two' }),
    ]);
    expect(lines(state)).toEqual(['you: hi', 'agent: One', 'tool: Run ls', 'agent: Two']);
    expect(state.items[1]).toMatchObject({ streaming: false });
    expect(state.items[3]).toMatchObject({ streaming: true });
  });

  it('adds a whole message that had no deltas', () => {
    const state = run([send('hi'), ev({ type: 'text', text: 'Whole' })]);
    expect(lines(state)).toEqual(['you: hi', 'agent: Whole']);
  });

  it('adds a second whole message that differs from the streamed one', () => {
    const state = run([
      send('hi'),
      ev({ type: 'text-delta', text: 'Alpha' }),
      ev({ type: 'text', text: 'Beta' }),
    ]);
    expect(lines(state)).toEqual(['you: hi', 'agent: Alpha', 'agent: Beta']);
  });

  it('does not match a whole message against an earlier turn', () => {
    const state = run([
      send('one'),
      ev({ type: 'text-delta', text: 'Yes' }),
      { type: 'exit', exitCode: 0, stderr: '' },
      send('two'),
      ev({ type: 'text', text: 'Yes' }),
    ]);
    expect(lines(state)).toEqual([
      'you: one',
      'agent: Yes',
      'cost: unknown',
      'you: two',
      'agent: Yes',
    ]);
  });

  it('adds tool notes, and a second event for the same call fills in the first', () => {
    const state = run([
      send('hi'),
      ev({ type: 'tool', id: 't1', name: 'Read', summary: '' }),
      ev({ type: 'tool', id: 't1', name: 'Read', summary: 'src/app.tsx' }),
      ev({ type: 'tool', id: 't1', name: 'Read', summary: '' }),
      ev({ type: 'tool', id: null, name: 'Run', summary: 'ls' }),
      ev({ type: 'tool', id: null, name: 'Run', summary: 'ls' }),
    ]);
    expect(lines(state)).toEqual([
      'you: hi',
      'tool: Read src/app.tsx',
      'tool: Run ls',
      'tool: Run ls',
    ]);
  });

  it('keeps an unreadable line as a note', () => {
    const state = run([send('hi'), ev({ type: 'note', text: 'odd line' })]);
    expect(lines(state)).toEqual(['you: hi', 'note: odd line']);
  });

  it('finishes the message on done and goes idle when the process exits', () => {
    const done = run([
      send('hi'),
      ev({ type: 'text-delta', text: 'Hello' }),
      ev({ type: 'done', costUsd: 0.01 }),
    ]);
    expect(done.status).toBe('running');
    expect(done.items[1]).toMatchObject({ streaming: false });
    const exited = run([{ type: 'exit', exitCode: 0, stderr: 'a warning' }], done);
    expect(exited.status).toBe('idle');
    expect(lines(exited)).toEqual(['you: hi', 'agent: Hello', 'cost: $0.0100']);
  });

  it('goes idle on a clean exit even without a done event', () => {
    const state = run([
      send('hi'),
      ev({ type: 'text-delta', text: 'Hello' }),
      { type: 'exit', exitCode: 0, stderr: '' },
    ]);
    expect(state.status).toBe('idle');
    expect(state.items[1]).toMatchObject({ streaming: false });
  });

  it('shows an error event and keeps the error status through the exit', () => {
    const state = run([
      send('hi'),
      ev({ type: 'error', message: 'no quota' }),
      ev({ type: 'error', message: 'no quota' }),
      ev({ type: 'done', costUsd: null }),
      { type: 'exit', exitCode: 1, stderr: '' },
    ]);
    expect(state.status).toBe('error');
    expect(lines(state)).toEqual(['you: hi', 'error: no quota', 'cost: unknown']);
  });

  it('shows the last lines of stderr on a non-zero exit', () => {
    const stderr = Array.from({ length: 12 }, (_, at) => `line ${String(at + 1)}`).join('\n');
    const state = run([send('hi'), { type: 'exit', exitCode: 2, stderr: `${stderr}\n\n` }]);
    expect(state.status).toBe('error');
    const last = state.items.findLast((item) => item.kind === 'error');
    expect(last).toMatchObject({ kind: 'error' });
    expect(last?.kind === 'error' ? last.text.split('\n') : []).toEqual([
      'The agent exited with code 2',
      'line 5',
      'line 6',
      'line 7',
      'line 8',
      'line 9',
      'line 10',
      'line 11',
      'line 12',
    ]);
  });

  it('says so when the process fails without a word', () => {
    expect(lines(run([send('hi'), { type: 'exit', exitCode: 3, stderr: '' }]))).toEqual([
      'you: hi',
      'error: The agent exited with code 3',
      'cost: unknown',
    ]);
    expect(lines(run([send('hi'), { type: 'exit', exitCode: null, stderr: '' }]))).toEqual([
      'you: hi',
      'error: The agent was stopped by a signal',
      'cost: unknown',
    ]);
  });

  it('shows why a run never started', () => {
    const state = run([
      send('hi'),
      { type: 'start-failed', message: 'codex was not found. Is it installed?' },
    ]);
    expect(state.status).toBe('error');
    expect(lines(state)).toEqual([
      'you: hi',
      'error: codex was not found. Is it installed?',
      'cost: unknown',
    ]);
  });

  it('marks the message being written as stopped, not as an error', () => {
    const state = run([send('hi'), ev({ type: 'text-delta', text: 'Half' }), { type: 'stop' }]);
    expect(state.status).toBe('idle');
    expect(state.items[1]).toMatchObject({ kind: 'assistant', stopped: true, streaming: false });
    expect(lines(state)).toEqual(['you: hi', 'agent: Half [stopped]', 'cost: unknown']);
    expect(state.items.some((item) => item.kind === 'error')).toBe(false);
  });

  it('adds a stopped marker when nothing was written yet', () => {
    const state = run([send('hi'), { type: 'stop' }]);
    expect(state.status).toBe('idle');
    expect(lines(state)).toEqual(['you: hi', 'agent:  [stopped]', 'cost: unknown']);
  });

  it('keeps the session id across turns, errors and stops', () => {
    const state = run([
      send('one'),
      ev({ type: 'session', id: 's-1' }),
      ev({ type: 'error', message: 'x' }),
      send('two'),
      { type: 'stop' },
    ]);
    expect(state.sessionId).toBe('s-1');
    expect(state.status).toBe('idle');
  });

  it('runs again after an error', () => {
    const state = run([send('one'), { type: 'start-failed', message: 'x' }, send('two')]);
    expect(state.status).toBe('running');
  });

  it('clears everything on reset', () => {
    const state = run([
      send('hi'),
      ev({ type: 'session', id: 's-1' }),
      ev({ type: 'text', text: 'Hello' }),
      { type: 'reset' },
    ]);
    expect(state).toEqual(EMPTY_TRANSCRIPT);
  });

  it('gives every item its own key and never changes the state it was given', () => {
    const first = run([send('hi')]);
    const frozen = structuredClone(first);
    const state = run(
      [
        ev({ type: 'text-delta', text: 'a' }),
        ev({ type: 'tool', id: 't', name: 'Read', summary: '' }),
        ev({ type: 'note', text: 'n' }),
        ev({ type: 'error', message: 'e' }),
        send('again'),
      ],
      first,
    );
    expect(first).toEqual(frozen);
    const keys = state.items.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('stderrTail', () => {
  it('keeps the last eight lines that say something', () => {
    expect(stderrTail('a\n\nb  \n')).toBe('a\nb');
    expect(stderrTail('')).toBe('');
    expect(stderrTail('1\n2\n3\n4\n5\n6\n7\n8\n9\n10').split('\n')).toHaveLength(8);
  });
});

describe('the cost of a run', () => {
  const EXIT: TranscriptAction = { type: 'exit', exitCode: 0, stderr: '' };

  it('is kept in the transcript when the agent reports it', () => {
    const state = run([
      send('hi'),
      ev({ type: 'text', text: 'Hello' }),
      ev({ type: 'done', costUsd: 0.0421 }),
      EXIT,
    ]);
    expect(state.items.at(-1)).toMatchObject({ kind: 'cost', costUsd: 0.0421 });
    expect(lines(state)).toEqual(['you: hi', 'agent: Hello', 'cost: $0.0421']);
  });

  it('is unknown when the agent reports none', () => {
    const state = run([
      send('hi'),
      ev({ type: 'text', text: 'Hello' }),
      ev({ type: 'done', costUsd: null }),
      EXIT,
    ]);
    expect(state.items.at(-1)).toMatchObject({ kind: 'cost', costUsd: null });
    expect(lines(state)).toEqual(['you: hi', 'agent: Hello', 'cost: unknown']);
  });

  it('is kept for a run that failed after spending', () => {
    const state = run([
      send('hi'),
      ev({ type: 'cost', costUsd: 0.5 }),
      ev({ type: 'error', message: 'error_max_turns' }),
      { type: 'exit', exitCode: 1, stderr: '' },
    ]);
    expect(lines(state)).toEqual(['you: hi', 'error: error_max_turns', 'cost: $0.5000']);
  });

  it('is written once per run, each with its own figure', () => {
    const state = run([
      send('one'),
      ev({ type: 'done', costUsd: 0.01 }),
      EXIT,
      send('two'),
      ev({ type: 'done', costUsd: null }),
      EXIT,
      send('three'),
      ev({ type: 'done', costUsd: 0.03 }),
      EXIT,
    ]);
    expect(lines(state)).toEqual([
      'you: one',
      'cost: $0.0100',
      'you: two',
      'cost: unknown',
      'you: three',
      'cost: $0.0300',
    ]);
  });

  it('closes a run that reported an error and had not exited when the next began', () => {
    const state = run([send('one'), ev({ type: 'error', message: 'no quota' }), send('two')]);
    expect(lines(state)).toEqual(['you: one', 'error: no quota', 'cost: unknown', 'you: two']);
    expect(new Set(state.items.map((item) => item.key)).size).toBe(state.items.length);
  });

  it('is not written while the run is still going', () => {
    const state = run([send('hi'), ev({ type: 'done', costUsd: 0.01 })]);
    expect(state.items.some((item) => item.kind === 'cost')).toBe(false);
  });

  it('ignores a cost reported when no run is open', () => {
    const state = run([send('hi'), EXIT, ev({ type: 'done', costUsd: 9 })]);
    expect(lines(state)).toEqual(['you: hi', 'cost: unknown']);
  });
});

describe('transcriptText', () => {
  it('starts with the agent, mode, status and session', () => {
    expect(transcriptText('claude', 'read-only', EMPTY_TRANSCRIPT)).toBe(
      'agent=claude mode=read-only status=idle session=none',
    );
    const state = run([
      send('hi'),
      ev({ type: 'session', id: 's-1' }),
      ev({ type: 'tool', id: 't', name: 'Read', summary: 'a.ts' }),
      ev({ type: 'text', text: 'Hello' }),
    ]);
    expect(transcriptText('codex', 'edit', state)).toBe(
      'agent=codex mode=edit status=running session=s-1\nyou: hi\ntool: Read a.ts\nagent: Hello',
    );
  });
});
