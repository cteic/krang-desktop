import { describe, expect, it } from 'vitest';

import type { ChatHistory, ChatHistoryItem } from '../../workspace/model';

import {
  HISTORY_MAX_CHARS,
  HISTORY_MAX_ITEMS,
  fromHistory,
  sameHistory,
  toHistory,
} from './history';
import {
  EMPTY_TRANSCRIPT,
  type Transcript,
  type TranscriptAction,
  transcriptReducer,
  transcriptText,
} from './transcript';

function run(actions: TranscriptAction[], from: Transcript = EMPTY_TRANSCRIPT): Transcript {
  return actions.reduce(transcriptReducer, from);
}

function lines(state: Transcript): string[] {
  return transcriptText('a', 'm', state).split('\n').slice(1);
}

function history(items: ChatHistoryItem[], rest: Partial<ChatHistory> = {}): ChatHistory {
  return { sessionId: null, running: false, truncated: false, items, ...rest };
}

function charsIn(saved: ChatHistory | undefined): number {
  return (saved?.items ?? []).reduce(
    (sum, item) => sum + ('text' in item ? item.text.length : 0),
    0,
  );
}

const FINISHED: TranscriptAction[] = [
  { type: 'send', text: 'hi' },
  { type: 'event', event: { type: 'session', id: 's-1' } },
  { type: 'event', event: { type: 'tool', id: 't1', name: 'Read', summary: 'a.ts' } },
  { type: 'event', event: { type: 'text', text: 'Hello' } },
  { type: 'event', event: { type: 'done', costUsd: null } },
  { type: 'exit', exitCode: 0, stderr: '' },
];

describe('toHistory', () => {
  it('saves nothing for a chat with nothing in it', () => {
    expect(toHistory(EMPTY_TRANSCRIPT)).toBeUndefined();
  });

  it('keeps the session id and every kind of item', () => {
    const saved = toHistory(run(FINISHED));
    expect(saved).toMatchObject({ sessionId: 's-1', running: false, truncated: false });
    expect(saved?.items.slice(0, 3)).toEqual([
      { kind: 'user', text: 'hi' },
      { kind: 'tool', name: 'Read', summary: 'a.ts' },
      { kind: 'assistant', text: 'Hello', stopped: false },
    ]);
  });

  it('says when a run is in progress', () => {
    expect(toHistory(run([{ type: 'send', text: 'hi' }]))?.running).toBe(true);
  });

  it('keeps only the newest items once there are too many', () => {
    const sends = Array.from({ length: HISTORY_MAX_ITEMS + 5 }, (_, index) =>
      history([{ kind: 'user', text: `message ${String(index)}` }]),
    ).flatMap((one) => one.items);
    const saved = toHistory(fromHistory(history(sends)));

    expect(saved?.items).toHaveLength(HISTORY_MAX_ITEMS);
    expect(saved?.items.at(-1)).toEqual({
      kind: 'user',
      text: `message ${String(HISTORY_MAX_ITEMS + 4)}`,
    });
    expect(saved?.truncated).toBe(true);
  });

  it('keeps only the newest items once their text is too long', () => {
    const long = 'x'.repeat(HISTORY_MAX_CHARS / 4);
    const state = run([
      { type: 'send', text: `oldest ${long}` },
      { type: 'stop' },
      { type: 'send', text: `older ${long}` },
      { type: 'stop' },
      { type: 'send', text: `old ${long}` },
      { type: 'stop' },
      { type: 'send', text: `new ${long}` },
      { type: 'stop' },
      { type: 'send', text: 'newest' },
    ]);
    const saved = toHistory(state);

    expect(charsIn(saved)).toBeLessThanOrEqual(HISTORY_MAX_CHARS);
    expect(saved?.items.at(-1)).toEqual({ kind: 'user', text: 'newest' });
    expect(JSON.stringify(saved)).not.toContain('oldest');
    expect(saved?.truncated).toBe(true);
  });

  it('cuts one message that is longer than everything a saved chat may hold', () => {
    const saved = toHistory(run([{ type: 'send', text: 'y'.repeat(HISTORY_MAX_CHARS * 2) }]));

    expect(saved?.items).toHaveLength(1);
    expect(charsIn(saved)).toBe(HISTORY_MAX_CHARS);
    expect(saved?.truncated).toBe(true);
  });
});

describe('fromHistory', () => {
  it('opens a new chat when nothing was saved', () => {
    expect(fromHistory(undefined)).toBe(EMPTY_TRANSCRIPT);
  });

  it('brings a finished chat back as it was, idle, with its session', () => {
    const before = run(FINISHED);
    const after = fromHistory(toHistory(before));

    expect(lines(after)).toEqual(lines(before));
    expect(after.sessionId).toBe('s-1');
    expect(after.status).toBe('idle');
    expect(new Set(after.items.map((item) => item.key)).size).toBe(after.items.length);
    expect(after.nextKey).toBeGreaterThan(Math.max(...after.items.map((item) => item.key)));
  });

  it('marks a run that was in progress as interrupted, and is not running', () => {
    const before = run([
      { type: 'send', text: 'hi' },
      { type: 'event', event: { type: 'text-delta', text: 'Hel' } },
    ]);
    const after = fromHistory(toHistory(before));

    expect(after.status).toBe('idle');
    expect(lines(after).slice(0, 3)).toEqual(['you: hi', 'agent: Hel', 'interrupted']);
    expect(after.items.some((item) => item.kind === 'assistant' && item.streaming)).toBe(false);
  });

  it('keeps the interrupted mark through a second save and load', () => {
    const once = fromHistory(toHistory(run([{ type: 'send', text: 'hi' }])));
    const saved = toHistory(once);
    const twice = fromHistory(saved);

    expect(saved?.running).toBe(false);
    expect(lines(twice)).toEqual(lines(once));
    expect(lines(twice).filter((line) => line === 'interrupted')).toHaveLength(1);
  });

  it('says so when a restored chat lost its oldest items', () => {
    const saved = history([{ kind: 'user', text: 'hi' }], { truncated: true });
    expect(fromHistory(saved).truncated).toBe(true);
    expect(toHistory(fromHistory(saved))?.truncated).toBe(true);
  });

  it('bounds a saved chat that was edited by hand to be too long', () => {
    const items: ChatHistoryItem[] = Array.from({ length: HISTORY_MAX_ITEMS * 2 }, () => ({
      kind: 'note',
      text: 'n',
    }));
    const restored = fromHistory(history(items));
    expect(restored.items).toHaveLength(HISTORY_MAX_ITEMS);
    expect(restored.truncated).toBe(true);
  });

  it.each(['--dangerously-skip-permissions', '-x', '', 'a b', 'x'.repeat(200)])(
    'drops a saved session id that is not a plain id: %j',
    (sessionId) => {
      expect(fromHistory(history([{ kind: 'user', text: 'hi' }], { sessionId })).sessionId).toBe(
        null,
      );
    },
  );

  it.each(['0b6f1c1e-4a55-4c1f-9d3e-2a4f5b6c7d8e', 'th-9', 's-1'])(
    'keeps a plain session id: %s',
    (sessionId) => {
      expect(fromHistory(history([], { sessionId })).sessionId).toBe(sessionId);
    },
  );
});

describe('sameHistory', () => {
  it('compares by value', () => {
    expect(sameHistory(toHistory(run(FINISHED)), toHistory(run(FINISHED)))).toBe(true);
    expect(sameHistory(toHistory(run(FINISHED)), undefined)).toBe(false);
    expect(sameHistory(undefined, undefined)).toBe(true);
  });
});
