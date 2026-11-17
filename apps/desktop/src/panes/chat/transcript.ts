import type { AgentEvent } from './agent-event';

export type TranscriptStatus = 'idle' | 'running' | 'error';

interface ItemBase {
  /** Unique within one transcript. */
  key: number;
}

export interface UserItem extends ItemBase {
  kind: 'user';
  text: string;
}

export interface AssistantItem extends ItemBase {
  kind: 'assistant';
  text: string;
  /** True while deltas are still arriving for this message. */
  streaming: boolean;
  /**
   * True when the text came as deltas and the whole message that repeats it
   * has not arrived yet.
   */
  unconfirmed: boolean;
  /** True when the person stopped the run while this was being written. */
  stopped: boolean;
}

export interface ToolItem extends ItemBase {
  kind: 'tool';
  toolId: string | null;
  name: string;
  summary: string;
}

export interface NoteItem extends ItemBase {
  kind: 'note';
  text: string;
}

export interface ErrorItem extends ItemBase {
  kind: 'error';
  text: string;
}

/** A run that was still going when the pane went away. It was not restarted. */
export interface InterruptedItem extends ItemBase {
  kind: 'interrupted';
}

export type TranscriptItem =
  UserItem | AssistantItem | ToolItem | NoteItem | ErrorItem | InterruptedItem;

export interface Transcript {
  items: TranscriptItem[];
  sessionId: string | null;
  status: TranscriptStatus;
  nextKey: number;
  /** True when a restored chat came back without its oldest items. */
  truncated: boolean;
}

export type TranscriptAction =
  /** The person sent a message and a run is starting. */
  | { type: 'send'; text: string }
  | { type: 'event'; event: AgentEvent }
  /** The process ended. */
  | { type: 'exit'; exitCode: number | null; stderr: string }
  /** The process never started. */
  | { type: 'start-failed'; message: string }
  /** The person stopped the run. */
  | { type: 'stop' }
  | { type: 'reset' };

export const EMPTY_TRANSCRIPT: Transcript = {
  items: [],
  sessionId: null,
  status: 'idle',
  nextKey: 1,
  truncated: false,
};

export const INTERRUPTED_TEXT = 'Interrupted. This run did not finish and was not restarted.';

const STDERR_TAIL_LINES = 8;

/** The last few lines of what a process wrote to standard error. */
export function stderrTail(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');
  return lines.slice(-STDERR_TAIL_LINES).join('\n');
}

function append(state: Transcript, item: TranscriptItem): Transcript {
  return { ...state, items: [...state.items, item], nextKey: state.nextKey + 1 };
}

function replaceAt(state: Transcript, index: number, item: TranscriptItem): Transcript {
  return { ...state, items: state.items.map((old, at) => (at === index ? item : old)) };
}

/** Where the current turn begins: just after the person's last message. */
function turnStart(items: TranscriptItem[]): number {
  return items.findLastIndex((item) => item.kind === 'user') + 1;
}

/** Marks every message as finished. Nothing is still being written. */
function settle(state: Transcript): Transcript {
  if (!state.items.some((item) => item.kind === 'assistant' && item.streaming)) {
    return state;
  }
  return {
    ...state,
    items: state.items.map((item) =>
      item.kind === 'assistant' && item.streaming ? { ...item, streaming: false } : item,
    ),
  };
}

function applyDelta(state: Transcript, text: string): Transcript {
  const lastIndex = state.items.length - 1;
  const last = state.items[lastIndex];
  if (last !== undefined && last.kind === 'assistant' && last.streaming) {
    return replaceAt(state, lastIndex, { ...last, text: last.text + text });
  }
  return append(settle(state), {
    key: state.nextKey,
    kind: 'assistant',
    text,
    streaming: true,
    unconfirmed: true,
    stopped: false,
  });
}

/**
 * A whole message. When its text already arrived as deltas in this turn,
 * the streamed message takes the whole text and no second copy is added.
 */
function applyText(state: Transcript, text: string): Transcript {
  const start = turnStart(state.items);
  const index = state.items.findIndex(
    (item, at) =>
      at >= start &&
      item.kind === 'assistant' &&
      item.unconfirmed &&
      text.trim().startsWith(item.text.trim()),
  );
  const streamed = state.items[index];
  if (streamed !== undefined && streamed.kind === 'assistant') {
    return replaceAt(state, index, { ...streamed, text, streaming: false, unconfirmed: false });
  }
  return append(settle(state), {
    key: state.nextKey,
    kind: 'assistant',
    text,
    streaming: false,
    unconfirmed: false,
    stopped: false,
  });
}

/** A tool call. A second event for the same call fills in the first. */
function applyTool(
  state: Transcript,
  id: string | null,
  name: string,
  summary: string,
): Transcript {
  const start = turnStart(state.items);
  const index =
    id === null
      ? -1
      : state.items.findIndex(
          (item, at) => at >= start && item.kind === 'tool' && item.toolId === id,
        );
  const known = state.items[index];
  if (known !== undefined && known.kind === 'tool') {
    return replaceAt(state, index, {
      ...known,
      name,
      summary: summary === '' ? known.summary : summary,
    });
  }
  return append(settle(state), { key: state.nextKey, kind: 'tool', toolId: id, name, summary });
}

function applyError(state: Transcript, message: string): Transcript {
  const last = state.items.at(-1);
  const settled: Transcript = { ...settle(state), status: 'error' };
  if (last !== undefined && last.kind === 'error' && last.text === message) {
    return settled;
  }
  return append(settled, { key: state.nextKey, kind: 'error', text: message });
}

function applyEvent(state: Transcript, event: AgentEvent): Transcript {
  switch (event.type) {
    case 'session':
      return state.sessionId === event.id ? state : { ...state, sessionId: event.id };
    case 'text-delta':
      return applyDelta(state, event.text);
    case 'text':
      return applyText(state, event.text);
    case 'tool':
      return applyTool(state, event.id, event.name, event.summary);
    case 'note':
      return append(settle(state), { key: state.nextKey, kind: 'note', text: event.text });
    case 'done':
      // The turn is written. The run itself is over when the process exits.
      return settle(state);
    case 'error':
      return applyError(state, event.message);
  }
}

function applyExit(state: Transcript, exitCode: number | null, stderr: string): Transcript {
  const settled = settle(state);
  if (exitCode === 0) {
    return settled.status === 'running' ? { ...settled, status: 'idle' } : settled;
  }
  const tail = stderrTail(stderr);
  if (tail === '' && settled.status === 'error') {
    return settled;
  }
  const ending =
    exitCode === null
      ? 'The agent was stopped by a signal'
      : `The agent exited with code ${String(exitCode)}`;
  return applyError(settled, tail === '' ? ending : `${ending}\n${tail}`);
}

/** Marks the message being written as stopped. A stop is not an error. */
function applyStop(state: Transcript): Transcript {
  const settled: Transcript = { ...settle(state), status: 'idle' };
  const lastIndex = settled.items.length - 1;
  const last = settled.items[lastIndex];
  if (last !== undefined && last.kind === 'assistant') {
    return replaceAt(settled, lastIndex, { ...last, unconfirmed: false, stopped: true });
  }
  return append(settled, {
    key: settled.nextKey,
    kind: 'assistant',
    text: '',
    streaming: false,
    unconfirmed: false,
    stopped: true,
  });
}

export function transcriptReducer(state: Transcript, action: TranscriptAction): Transcript {
  switch (action.type) {
    case 'send':
      return append(
        { ...settle(state), status: 'running' },
        { key: state.nextKey, kind: 'user', text: action.text },
      );
    case 'event':
      return applyEvent(state, action.event);
    case 'exit':
      return applyExit(state, action.exitCode, action.stderr);
    case 'start-failed':
      return applyError(state, action.message);
    case 'stop':
      return applyStop(state);
    case 'reset':
      return EMPTY_TRANSCRIPT;
  }
}

function itemLine(item: TranscriptItem): string {
  switch (item.kind) {
    case 'user':
      return `you: ${item.text}`;
    case 'assistant':
      return `agent: ${item.text}${item.stopped ? ' [stopped]' : ''}`;
    case 'tool':
      return `tool: ${[item.name, item.summary].filter((part) => part !== '').join(' ')}`;
    case 'note':
      return `note: ${item.text}`;
    case 'error':
      return `error: ${item.text}`;
    case 'interrupted':
      return 'interrupted';
  }
}

/** The pane as plain text, for debug snapshots. */
export function transcriptText(agent: string, mode: string, transcript: Transcript): string {
  const head = `agent=${agent} mode=${mode} status=${transcript.status} session=${transcript.sessionId ?? 'none'}`;
  return [head, ...transcript.items.map(itemLine)].join('\n');
}
