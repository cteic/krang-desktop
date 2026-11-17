import type { ChatHistory, ChatHistoryItem } from '../../workspace/model';

import { EMPTY_TRANSCRIPT, type Transcript, type TranscriptItem } from './transcript';

/**
 * A chat's conversation as the workspace saves it, and back again.
 *
 * The saved size is bounded. Only the newest items are kept: at most
 * `HISTORY_MAX_ITEMS` of them, holding at most `HISTORY_MAX_CHARS`
 * characters between them. What is left out is said, not hidden: the
 * history is marked `truncated` and the pane shows that.
 */
export const HISTORY_MAX_ITEMS = 200;
export const HISTORY_MAX_CHARS = 64_000;

/**
 * A saved session id goes back to the agent as a command-line argument. The
 * saved file can be edited by hand, so an id that could be read as an option
 * is dropped.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function toSavedItem(item: TranscriptItem): ChatHistoryItem {
  switch (item.kind) {
    case 'user':
      return { kind: 'user', text: item.text };
    case 'assistant':
      return { kind: 'assistant', text: item.text, stopped: item.stopped };
    case 'tool':
      return { kind: 'tool', name: item.name, summary: item.summary };
    case 'note':
      return { kind: 'note', text: item.text };
    case 'error':
      return { kind: 'error', text: item.text };
    case 'interrupted':
      return { kind: 'interrupted' };
  }
}

function sizeOf(item: ChatHistoryItem): number {
  switch (item.kind) {
    case 'tool':
      return item.name.length + item.summary.length;
    case 'interrupted':
      return 0;
    default:
      return item.text.length;
  }
}

/** The item with its text cut to `limit` characters. A tool call is short. */
function cut(item: ChatHistoryItem, limit: number): ChatHistoryItem | null {
  if (item.kind === 'tool' || item.kind === 'interrupted') {
    return null;
  }
  return { ...item, text: `${item.text.slice(0, limit - 1)}…` };
}

/** The newest items that fit the bounds, oldest first. */
function newestThatFit(items: readonly ChatHistoryItem[]): {
  kept: ChatHistoryItem[];
  truncated: boolean;
} {
  const kept: ChatHistoryItem[] = [];
  let chars = 0;
  for (const item of items.toReversed()) {
    const size = sizeOf(item);
    if (kept.length >= HISTORY_MAX_ITEMS || chars + size > HISTORY_MAX_CHARS) {
      // One message longer than the whole budget is kept, cut short.
      const short = kept.length === 0 ? cut(item, HISTORY_MAX_CHARS) : null;
      return { kept: short === null ? kept.reverse() : [short], truncated: true };
    }
    kept.push(item);
    chars += size;
  }
  return { kept: kept.reverse(), truncated: false };
}

/** What to save for a transcript. A chat with nothing in it saves nothing. */
export function toHistory(transcript: Transcript): ChatHistory | undefined {
  if (transcript.items.length === 0 && transcript.sessionId === null) {
    return undefined;
  }
  const { kept, truncated } = newestThatFit(transcript.items.map(toSavedItem));
  return {
    sessionId: transcript.sessionId,
    running: transcript.status === 'running',
    truncated: truncated || transcript.truncated,
    items: kept,
  };
}

function toTranscriptItem(item: ChatHistoryItem, key: number): TranscriptItem {
  if (item.kind === 'assistant') {
    return { ...item, key, streaming: false, unconfirmed: false };
  }
  if (item.kind === 'tool') {
    return { ...item, key, toolId: null };
  }
  return { ...item, key };
}

/**
 * The transcript a saved chat opens with. Nothing is running when a pane
 * opens, so a run that was in progress when the chat was saved is marked as
 * interrupted. It is never started again from here.
 */
export function fromHistory(history: ChatHistory | undefined): Transcript {
  if (history === undefined) {
    return EMPTY_TRANSCRIPT;
  }
  const { kept, truncated } = newestThatFit(history.items);
  const saved: ChatHistoryItem[] = history.running ? [...kept, { kind: 'interrupted' }] : kept;
  const items = saved.map((item, index) => toTranscriptItem(item, index + 1));
  const sessionId =
    history.sessionId !== null && SESSION_ID.test(history.sessionId) ? history.sessionId : null;
  return {
    items,
    sessionId,
    status: 'idle',
    nextKey: items.length + 1,
    truncated: truncated || history.truncated,
  };
}

export function sameHistory(a: ChatHistory | undefined, b: ChatHistory | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
